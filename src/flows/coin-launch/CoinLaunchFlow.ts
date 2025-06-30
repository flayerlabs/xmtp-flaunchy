import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { getCharacterResponse } from "../../../utils/character";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { GraphQLService } from "../../services/GraphQLService";
import { getDefaultChain } from "../utils/ChainSelection";
import { createFlaunchTransaction } from "../utils/FlaunchTransactionUtils";
import { createCoinLaunchExtractionPrompt, CoinLaunchExtractionResult } from "./coinLaunchExtractionTemplate";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { safeParseJSON } from "../../core/utils/jsonUtils";

interface CoinLaunchData {
  name?: string;
  ticker?: string;
  image?: string; // Still optional during extraction, required before launch
  targetGroup?: string;
  // Launch parameters
  startingMarketCap?: number;
  fairLaunchDuration?: number;
  premineAmount?: number;
  buybackPercentage?: number;
}

export class CoinLaunchFlow extends BaseFlow {
  private graphqlService: GraphQLService;

  constructor() {
    super('CoinLaunchFlow');
    this.graphqlService = new GraphQLService();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);
    
    this.log('Processing coin launch message', { 
      userId: userState.userId,
      messageText: messageText?.substring(0, 100),
      hasProgress: !!userState.coinLaunchProgress,
      step: userState.coinLaunchProgress?.step
    });

    // Clear any conflicting pending transactions from other flows
    await this.clearCrossFlowTransactions(context);

    // Check for pending transaction first
    if (userState.pendingTransaction?.type === 'coin_creation') {
      const handled = await this.handlePendingTransactionUpdate(context);
      if (handled) {
        return; // Transaction was rebuilt and sent, we're done
      }
    }
    
    // Check if user is asking about status/progress
    if (await this.isStatusInquiry(context)) {
      await this.handleStatusInquiry(context);
      return;
    }
    
    // Check if user wants to launch (when they have progress)
    if (userState.coinLaunchProgress && await this.isLaunchCommand(context)) {
      await this.handleLaunchCommand(context);
      return;
    }
    
    // Check if user is asking about launch options
    if (await this.isLaunchOptionsInquiry(context)) {
      await this.handleLaunchOptionsInquiry(context);
      return;
    }

    // Check if user is asking about launch defaults
    if (await this.isLaunchDefaultsInquiry(context)) {
      await this.handleLaunchDefaultsInquiry(context);
      return;
    }

    // Check if user is asking about future features
    if (await this.isFutureFeatureInquiry(context)) {
      await this.handleFutureFeatureInquiry(context);
      return;
    }
    
    // Ensure user has groups
    if (userState.groups.length === 0) {
      await this.sendResponse(context, "create a group first before launching coins.");
      return;
    }

    // Continue from progress or start new
    if (userState.coinLaunchProgress) {
      await this.continueFromProgress(context);
    } else {
      await this.startNewCoinLaunch(context);
    }
  }

  private async handlePendingTransactionUpdate(context: FlowContext): Promise<boolean> {
    const { userState } = context;
    const pendingTx = userState.pendingTransaction!;
    
    // Extract any new launch parameters from the current message
    const currentData = await this.extractCoinData(context);
    
    // Check if any launch parameters have changed
    const currentParams = pendingTx.launchParameters || {};
    let parametersChanged = false;
    
    if (currentData.startingMarketCap && currentData.startingMarketCap !== currentParams.startingMarketCap) {
      currentParams.startingMarketCap = currentData.startingMarketCap;
      parametersChanged = true;
    }
    if (currentData.fairLaunchDuration && currentData.fairLaunchDuration !== currentParams.fairLaunchDuration) {
      currentParams.fairLaunchDuration = currentData.fairLaunchDuration;
      parametersChanged = true;
    }
    if (currentData.premineAmount && currentData.premineAmount !== currentParams.premineAmount) {
      currentParams.premineAmount = currentData.premineAmount;
      parametersChanged = true;
    }
    if (currentData.buybackPercentage && currentData.buybackPercentage !== currentParams.buybackPercentage) {
      currentParams.buybackPercentage = currentData.buybackPercentage;
      parametersChanged = true;
    }
    if (currentData.targetGroup && currentData.targetGroup !== currentParams.targetGroupId) {
      currentParams.targetGroupId = currentData.targetGroup;
      parametersChanged = true;
    }
    
    if (parametersChanged) {
      this.log('Launch parameters changed, rebuilding transaction', {
        userId: userState.userId,
        oldParams: pendingTx.launchParameters,
        newParams: currentParams
      });
      
      // Find the target group
      const targetGroupId = currentParams.targetGroupId || pendingTx.launchParameters?.targetGroupId;
      const targetGroup = userState.groups.find(g => g.id === targetGroupId);
      
      if (!targetGroup) {
        await this.sendResponse(context, "couldn't find the target group for your coin launch. please specify which group to launch into.");
        return false;
      }
      
      // Rebuild and send the transaction with updated parameters
      const coinData = pendingTx.coinData!;
      await this.rebuildAndSendTransaction(context, {
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        targetGroup: targetGroup.id,
        startingMarketCap: currentParams.startingMarketCap || 1000,
        fairLaunchDuration: currentParams.fairLaunchDuration || 30,
        premineAmount: currentParams.premineAmount || 0,
        buybackPercentage: currentParams.buybackPercentage || 0
      }, targetGroup);
      
      return true; // Transaction was rebuilt and sent
    }
    
    return false; // No changes, continue with normal flow
  }

  public async rebuildAndSendTransaction(context: FlowContext, coinData: Required<CoinLaunchData>, targetGroup: UserGroup): Promise<void> {
    this.log('Rebuilding transaction with updated parameters', {
      userId: context.userState.userId,
      coinData,
      groupId: targetGroup.id
    });

    // Use default chain (no chain switching)
    const selectedChain = getDefaultChain();

    try {
      // Process image if needed
      let imageUrl = coinData.image;
      if (imageUrl === 'attachment_provided' && context.hasAttachment) {
        imageUrl = await context.processImageAttachment(context.attachment);
        
        if (imageUrl === 'IMAGE_PROCESSING_FAILED') {
          await this.sendResponse(context, `couldn't process image for ${coinData.name} (${coinData.ticker}). try again.`);
          return;
        }
      }

      // Calculate creator fee allocation based on buyback percentage
      let creatorFeeAllocationPercent = 100;
      if (coinData.buybackPercentage) {
        // If buybacks are enabled, creator gets reduced share
        creatorFeeAllocationPercent = 100 - coinData.buybackPercentage;
      }

      // Create transaction using centralized function
      const walletSendCalls = await createFlaunchTransaction({
        name: coinData.name,
        ticker: coinData.ticker,
        image: imageUrl,
        creatorAddress: context.creatorAddress,
        senderInboxId: context.senderInboxId,
        chain: selectedChain,
        treasuryManagerAddress: targetGroup.id,
        processImageAttachment: context.processImageAttachment,
        hasAttachment: context.hasAttachment,
        attachment: context.attachment,
        ensResolver: context.ensResolver,
        // Pass extracted launch parameters
        startingMarketCapUSD: coinData.startingMarketCap || 1000,
        fairLaunchDuration: (coinData.fairLaunchDuration || 30) * 60, // Convert to seconds
        fairLaunchPercent: 10, // Keep default for now
        creatorFeeAllocationPercent,
        preminePercentage: coinData.premineAmount || 0
      });

      // Update pending transaction with new parameters
      await context.updateState({
        pendingTransaction: {
          type: 'coin_creation',
          coinData: {
            name: coinData.name,
            ticker: coinData.ticker,
            image: imageUrl
          },
          launchParameters: {
            startingMarketCap: coinData.startingMarketCap || 1000,
            fairLaunchDuration: coinData.fairLaunchDuration || 30,
            premineAmount: coinData.premineAmount || 0,
            buybackPercentage: coinData.buybackPercentage || 0,
            targetGroupId: targetGroup.id
          },
          network: selectedChain.name,
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Confirmation with updated parameters and prebuy suggestion
      const params = [];
      if (coinData.startingMarketCap && coinData.startingMarketCap !== 1000) {
        params.push(`$${coinData.startingMarketCap} market cap`);
      }
      if (coinData.fairLaunchDuration && coinData.fairLaunchDuration !== 30) {
        params.push(`${coinData.fairLaunchDuration}min fair launch`);
      }
      if (coinData.premineAmount && coinData.premineAmount > 0) {
        params.push(`${coinData.premineAmount}% prebuy`);
      }
      if (coinData.buybackPercentage && coinData.buybackPercentage > 0) {
        params.push(`${coinData.buybackPercentage}% buybacks`);
      }
      
      const paramString = params.length > 0 ? ` with ${params.join(', ')}` : '';
      let confirmationMessage = `updated! sign to launch $${coinData.ticker}${paramString}!`;
      
      await this.sendResponse(context, confirmationMessage);

    } catch (error) {
      this.logError('Failed to rebuild transaction', error);
      await this.sendResponse(context, `failed to update transaction: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * Clear pending transactions from other flows when starting coin launch
   * This prevents conflicts when users switch between different actions
   */
  private async clearCrossFlowTransactions(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    if (userState.pendingTransaction && userState.pendingTransaction.type !== 'coin_creation') {
      const pendingTx = userState.pendingTransaction;
      
      this.log('Clearing cross-flow pending transaction', {
        userId: userState.userId,
        transactionType: pendingTx.type,
        reason: 'User explicitly started coin launch'
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateState({
        pendingTransaction: undefined,
        // Clear management progress if it exists (user switching from group creation to coin launch)
        managementProgress: undefined
      });

      // NO USER MESSAGE - clearing should be invisible to the user
      // They just want their coin launched, not to hear about technical cleanup
    }
  }

  private async continueFromProgress(context: FlowContext): Promise<void> {
    const { userState } = context;
    const progress = userState.coinLaunchProgress!;

    // Extract any new coin data from current message
    const currentData = await this.extractCoinData(context);
    let updated = false;
    let parameterUpdates: string[] = [];

    progress.coinData = progress.coinData || {};
    
    // Update with any new data found
    if (currentData.name && !progress.coinData.name) {
      progress.coinData.name = currentData.name;
      updated = true;
    }
    if (currentData.ticker && !progress.coinData.ticker) {
      progress.coinData.ticker = currentData.ticker;
      updated = true;
    }
    if (currentData.image && !progress.coinData.image) {
      progress.coinData.image = currentData.image;
      updated = true; 
    }
    if (currentData.targetGroup && !progress.targetGroupId) {
      progress.targetGroupId = currentData.targetGroup;
      updated = true;
    }

    // Handle launch parameter updates
    progress.launchParameters = progress.launchParameters || {};
    if (currentData.startingMarketCap && currentData.startingMarketCap !== progress.launchParameters.startingMarketCap) {
      progress.launchParameters.startingMarketCap = currentData.startingMarketCap;
      parameterUpdates.push(`starting market cap to $${currentData.startingMarketCap}`);
      updated = true;
    }
    if (currentData.fairLaunchDuration && currentData.fairLaunchDuration !== progress.launchParameters.fairLaunchDuration) {
      progress.launchParameters.fairLaunchDuration = currentData.fairLaunchDuration;
      parameterUpdates.push(`fair launch duration to ${currentData.fairLaunchDuration} minutes`);
      updated = true;
    }
    if (currentData.premineAmount && currentData.premineAmount !== progress.launchParameters.premineAmount) {
      progress.launchParameters.premineAmount = currentData.premineAmount;
      parameterUpdates.push(`prebuy to ${currentData.premineAmount}%`);
      updated = true;
    }
    if (currentData.buybackPercentage && currentData.buybackPercentage !== progress.launchParameters.buybackPercentage) {
      progress.launchParameters.buybackPercentage = currentData.buybackPercentage;
      parameterUpdates.push(`buybacks to ${currentData.buybackPercentage}%`);
      updated = true;
    }

    // Auto-select target group if user has only one group
    if (!progress.targetGroupId && userState.groups.length === 1) {
      progress.targetGroupId = userState.groups[0].id;
      updated = true;
    }

    if (updated) {
      await context.updateState({ coinLaunchProgress: progress });
    }

    // If parameter updates were made, acknowledge them naturally
    if (parameterUpdates.length > 0) {
      const updateMessage = `got it! updated ${parameterUpdates.join(' and ')}.`;
      await this.sendResponse(context, updateMessage);
      
      console.log(`[CoinLaunch] ✅ Parameters updated: ${parameterUpdates.join(', ')}`);
    }

    // Check if we have all required data
    const coinData = progress.coinData || {};
    const hasAll = coinData.name && coinData.ticker && coinData.image && progress.targetGroupId;
    if (hasAll) {
      const targetGroup = userState.groups.find(g => g.id === progress.targetGroupId);
      if (targetGroup) {
        // Merge coin data with launch parameters from progress
        const fullCoinData = {
          ...coinData,
          startingMarketCap: progress.launchParameters?.startingMarketCap,
          fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
          premineAmount: progress.launchParameters?.premineAmount,
          buybackPercentage: progress.launchParameters?.buybackPercentage,
          targetGroup: targetGroup.id
        } as Required<CoinLaunchData>;
        
        await this.launchCoin(context, fullCoinData, targetGroup);
        return;
      }
    }

    // Still missing data - use complete coin data from progress, not partial currentData
    const completeCoinData = progress.coinData || {};
    
    if (!progress.targetGroupId) {
      // If only one group, auto-select it
      if (userState.groups.length === 1) {
        progress.targetGroupId = userState.groups[0].id;
        await context.updateState({ coinLaunchProgress: progress });
        
        // Now check if we can launch or need more data
        if (completeCoinData.name && completeCoinData.ticker && completeCoinData.image) {
          // Merge coin data with launch parameters from progress
          const fullCoinData = {
            ...completeCoinData,
            startingMarketCap: progress.launchParameters?.startingMarketCap,
            fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
            premineAmount: progress.launchParameters?.premineAmount,
            buybackPercentage: progress.launchParameters?.buybackPercentage,
            targetGroup: userState.groups[0].id
          } as Required<CoinLaunchData>;
          
          await this.launchCoin(context, fullCoinData, userState.groups[0]);
          return;
        } else {
          await this.requestMissingData(context, completeCoinData, userState.groups[0]);
          return;
        }
      }
      
      // Create a complete data object for group determination
      const completeDataForGroupSelection = {
        ...completeCoinData,
        targetGroup: currentData.targetGroup, // Only use new targetGroup if provided
        startingMarketCap: progress.launchParameters?.startingMarketCap,
        fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
        premineAmount: progress.launchParameters?.premineAmount,
        buybackPercentage: progress.launchParameters?.buybackPercentage
      };
      
      const targetGroup = await this.determineTargetGroup(context, completeDataForGroupSelection);
      if (targetGroup) {
        progress.targetGroupId = targetGroup.id;
        await context.updateState({ coinLaunchProgress: progress });
      }
      return;
    }

    // Request missing coin data
    const targetGroup = userState.groups.find(g => g.id === progress.targetGroupId);
    if (targetGroup) {
      await this.requestMissingData(context, completeCoinData, targetGroup);
    } else {
      // Target group not found - show available groups
      const missing = [];
      if (!completeCoinData.name) missing.push('coin name');
      if (!completeCoinData.ticker) missing.push('ticker');  
      if (!completeCoinData.image) missing.push('image');
      missing.push('target group');
      
      let message = `still need: ${missing.join(', ')}\n\n`;
      message += "available groups:\n\n";
      for (const group of userState.groups) {
        message += `${group.id}\n`;
        message += `- coins: ${group.coins.length > 0 ? group.coins.join(', ') : 'none yet'}\n\n`;
      }
      message += "specify the contract address (group ID) you want to launch into.";
      
      await this.sendResponse(context, message);
    }
  }

  private async startNewCoinLaunch(context: FlowContext): Promise<void> {
    // Extract coin data from message
    const extractedData = await this.extractCoinData(context);
    
    // Separate coin data from launch parameters
    const coinData = {
      name: extractedData.name,
      ticker: extractedData.ticker,
      image: extractedData.image
    };
    
    const launchParameters = {
      startingMarketCap: extractedData.startingMarketCap,
      fairLaunchDuration: extractedData.fairLaunchDuration,
      premineAmount: extractedData.premineAmount,
      buybackPercentage: extractedData.buybackPercentage
    };
    
    // Initialize progress with separated data
    const progress: any = {
      step: 'collecting_coin_data' as const,
      coinData,
      launchParameters,
      startedAt: new Date()
    };

    // Determine target group
    const targetGroup = await this.determineTargetGroup(context, extractedData);
    if (targetGroup) {
      progress.targetGroupId = targetGroup.id;
    }
    
    // Save progress
    await context.updateState({ coinLaunchProgress: progress });
    
    // Check if we have everything
    if (coinData.name && coinData.ticker && coinData.image && targetGroup) {
      // Merge coin data with launch parameters for launch
      const fullCoinData = {
        ...coinData,
        ...launchParameters,
        targetGroup: targetGroup.id
      } as Required<CoinLaunchData>;
      
      await this.launchCoin(context, fullCoinData, targetGroup);
    } else if (targetGroup) {
      await this.requestMissingData(context, coinData, targetGroup);
    }
  }

  private async extractCoinData(context: FlowContext): Promise<CoinLaunchData> {
    const messageText = this.extractMessageText(context);
    
    // Get existing coin data from context to preserve it
    const existingCoinData = this.getExistingCoinData(context);
    
    try {
      // Use LLM-based extraction instead of regex patterns
      const prompt = createCoinLaunchExtractionPrompt({
        message: messageText,
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? 'image' : undefined,
        imageUrl: undefined // We'll handle image URLs separately if needed
      });

      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 500
      });

      const rawResponse = response.choices[0]?.message?.content || '{}';
      const extractedData = safeParseJSON<CoinLaunchExtractionResult>(rawResponse);
      
      // Convert to CoinLaunchData format, preserving existing data when new extraction is null/undefined
      const result: CoinLaunchData = {
        name: extractedData.tokenDetails.name || existingCoinData?.name || undefined,
        ticker: extractedData.tokenDetails.ticker || existingCoinData?.ticker || undefined,
        image: extractedData.tokenDetails.image || existingCoinData?.image || (context.hasAttachment ? 'attachment_provided' : undefined),
        targetGroup: extractedData.targetGroup || existingCoinData?.targetGroup || undefined,
        startingMarketCap: extractedData.launchParameters.startingMarketCap || existingCoinData?.startingMarketCap || undefined,
        fairLaunchDuration: extractedData.launchParameters.fairLaunchDuration || existingCoinData?.fairLaunchDuration || undefined,
        premineAmount: extractedData.launchParameters.premineAmount !== null ? extractedData.launchParameters.premineAmount : (existingCoinData?.premineAmount || undefined),
        buybackPercentage: extractedData.launchParameters.buybackPercentage || existingCoinData?.buybackPercentage || undefined
      };

      this.log('Extracted coin data with preservation', {
        ...result,
        hasAttachment: context.hasAttachment,
        messageText: messageText || '(empty)',
        preservedFromExisting: {
          name: !extractedData.tokenDetails.name && existingCoinData?.name,
          ticker: !extractedData.tokenDetails.ticker && existingCoinData?.ticker,
          image: !extractedData.tokenDetails.image && existingCoinData?.image,
          targetGroup: !extractedData.targetGroup && existingCoinData?.targetGroup
        }
      });
      
      return result;
    } catch (error) {
      console.log(`[CoinLaunch] ❌ Extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      
      this.logError('Failed to extract coin data', error);
      
      // Fallback to existing data if extraction fails
      return existingCoinData || {
        name: undefined,
        ticker: undefined,
        image: context.hasAttachment ? 'attachment_provided' : undefined,
        targetGroup: undefined
      };
    }
  }

  /**
   * Get existing coin data from various sources in the context
   */
  private getExistingCoinData(context: FlowContext): CoinLaunchData | null {
    const { userState } = context;
    
    // First check pending transaction (most recent)
    if (userState.pendingTransaction?.type === 'coin_creation' && userState.pendingTransaction.coinData) {
      const coinData = userState.pendingTransaction.coinData;
      const launchParams = userState.pendingTransaction.launchParameters;
      
      return {
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        targetGroup: launchParams?.targetGroupId,
        startingMarketCap: launchParams?.startingMarketCap,
        fairLaunchDuration: launchParams?.fairLaunchDuration,
        premineAmount: launchParams?.premineAmount,
        buybackPercentage: launchParams?.buybackPercentage
      };
    }
    
    // Then check coin launch progress
    if (userState.coinLaunchProgress?.coinData) {
      const coinData = userState.coinLaunchProgress.coinData;
      const launchParams = userState.coinLaunchProgress.launchParameters;
      
      return {
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        targetGroup: userState.coinLaunchProgress.targetGroupId,
        startingMarketCap: launchParams?.startingMarketCap,
        fairLaunchDuration: launchParams?.fairLaunchDuration,
        premineAmount: launchParams?.premineAmount,
        buybackPercentage: launchParams?.buybackPercentage
      };
    }
    
    // Finally check onboarding progress (for new users)
    if (userState.onboardingProgress?.coinData) {
      const coinData = userState.onboardingProgress.coinData;
      
      return {
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        targetGroup: undefined,
        startingMarketCap: undefined,
        fairLaunchDuration: undefined,
        premineAmount: undefined,
        buybackPercentage: undefined
      };
    }
    
    return null;
  }

  private async determineTargetGroup(context: FlowContext, coinData: CoinLaunchData): Promise<UserGroup | null> {
    const { userState } = context;
    const groups = userState.groups;

    // If only one group, use it
    if (groups.length === 1) {
      return groups[0];
    }

    // If user specified a group
    if (coinData.targetGroup) {
      const group = this.findGroup(groups, coinData.targetGroup);
      if (group) {
        return group;
      }
      await this.sendResponse(context, `couldn't find group "${coinData.targetGroup}".`);
      return null;
    }

    // Multiple groups, need selection
    await this.requestGroupSelection(context, groups);
    return null;
  }

  private findGroup(groups: UserGroup[], identifier: string): UserGroup | null {
    const lowerIdentifier = identifier.toLowerCase();
    
    // Try exact contract address match
    const exactMatch = groups.find(g => g.id.toLowerCase() === lowerIdentifier);
    if (exactMatch) {
      console.log(`[CoinLaunch] ✅ Found group: ${exactMatch.name}`);
      return exactMatch;
    }
    
    // Try exact group name match
    const nameMatch = groups.find(g => g.name.toLowerCase() === lowerIdentifier);
    if (nameMatch) {
      console.log(`[CoinLaunch] ✅ Found group: ${nameMatch.name}`);
      return nameMatch;
    }
    
    // Try partial group name match
    const partialNameMatch = groups.find(g => g.name.toLowerCase().includes(lowerIdentifier));
    if (partialNameMatch) {
      console.log(`[CoinLaunch] ✅ Found group: ${partialNameMatch.name} (partial match)`);
      return partialNameMatch;
    }
    
    // Try partial contract address match (for shortened versions like 0xabcd...1234)
    const partialAddressMatch = groups.find(g => {
      const groupId = g.id.toLowerCase();
      // Check if identifier matches the start and end pattern (0xabcd...1234)
      if (lowerIdentifier.includes('...')) {
        const [start, end] = lowerIdentifier.split('...');
        return groupId.startsWith(start) && groupId.endsWith(end);
      }
      // Check if identifier is a substring of the group ID
      return groupId.includes(lowerIdentifier);
    });
    
    if (partialAddressMatch) {
      console.log(`[CoinLaunch] ✅ Found group: ${partialAddressMatch.name} (address match)`);
      return partialAddressMatch;
    }
    
    console.log(`[CoinLaunch] ❌ No group found for: ${identifier}`);
    return null;
  }

  private async requestGroupSelection(context: FlowContext, groups: UserGroup[]): Promise<void> {
    let message = "which group for this coin?\n\n";
    
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const groupDisplay = GroupCreationUtils.formatGroupDisplay(group, context.userState, {
        showClaimable: false,
        includeEmoji: true // Use folder emoji for selection
      });
      message += groupDisplay + '\n';
    }
    
    message += "specify either the group name (e.g., \"Zenith Pack 50\") or contract address.";
    await this.sendResponse(context, message);
  }

  private async requestMissingData(context: FlowContext, coinData: CoinLaunchData, targetGroup: UserGroup): Promise<void> {
    const missing = [];
    if (!coinData.name) missing.push('coin name');
    if (!coinData.ticker) missing.push('ticker');
    if (!coinData.image) missing.push('image');
    
    // Check if user is in onboarding (first coin) vs existing user
    const isFirstCoin = context.userState.status === 'onboarding' || context.userState.coins.length === 0;
    
    let message;
    if (isFirstCoin) {
      // New user - be extra excited and encouraging
      if (missing.length === 3) {
        // They haven't provided anything yet
        message = "let's launch your first coin!\n\ni need three things to get started:\n• coin name (e.g., \"Flaunchy\")\n• ticker (e.g., \"FLNCHY\")\n• image (upload or link an image)\n\njust send them all in one message and let's make this happen!";
      } else {
        // They've provided some info
        message = `awesome progress on your first coin! just need: ${missing.join(', ')}\n\nsend the missing info and we'll get this live!`;
      }
    } else {
      // Existing user - be more direct but still enthusiastic
      if (missing.length === 3) {
        message = `ready for another coin launch! need: ${missing.join(', ')}\n\nsend the details and let's get this one live!`;
      } else {
        message = `almost there! still need: ${missing.join(', ')}\n\nprovide the missing info to launch!`;
      }
    }
    
    await this.sendResponse(context, message);
  }

  private async launchCoin(context: FlowContext, coinData: Required<CoinLaunchData>, targetGroup: UserGroup): Promise<void> {
    this.log('Launching coin', {
      userId: context.userState.userId,
      coinData,
      groupId: targetGroup.id
    });

    // Use default chain (no chain switching)
    const selectedChain = getDefaultChain();

    // Validate chain compatibility
    if (selectedChain.name !== targetGroup.chainName) {
      await this.sendResponse(context, `your group is on ${targetGroup.chainName} but default chain is ${selectedChain.name}. create a group on ${selectedChain.name} first.`);
      return;
    }

    try {
      // Process image if attachment
      let imageUrl = coinData.image;
      if (imageUrl === 'attachment_provided' && context.hasAttachment) {
        imageUrl = await context.processImageAttachment(context.attachment);
        
        if (imageUrl === 'IMAGE_PROCESSING_FAILED') {
          await this.sendResponse(context, `couldn't process image for ${coinData.name} (${coinData.ticker}). try again.`);
          return;
        }
      }

      // Calculate creator fee allocation based on buyback percentage
      let creatorFeeAllocationPercent = 100;
      if (coinData.buybackPercentage) {
        // If buybacks are enabled, creator gets reduced share
        creatorFeeAllocationPercent = 100 - coinData.buybackPercentage;
      }

      // Create transaction using centralized function
      const walletSendCalls = await createFlaunchTransaction({
        name: coinData.name,
        ticker: coinData.ticker,
        image: imageUrl,
        creatorAddress: context.creatorAddress,
        senderInboxId: context.senderInboxId,
        chain: selectedChain,
        treasuryManagerAddress: targetGroup.id,
        processImageAttachment: context.processImageAttachment,
        hasAttachment: context.hasAttachment,
        attachment: context.attachment,
        ensResolver: context.ensResolver,
        // Pass extracted launch parameters
        startingMarketCapUSD: coinData.startingMarketCap || 1000,
        fairLaunchDuration: (coinData.fairLaunchDuration || 30) * 60, // Convert to seconds
        fairLaunchPercent: 10, // Keep default for now
        creatorFeeAllocationPercent,
        preminePercentage: coinData.premineAmount || 0
      });

      // Set pending transaction
      await context.updateState({
        pendingTransaction: {
          type: 'coin_creation',
          coinData: {
            name: coinData.name,
            ticker: coinData.ticker,
            image: imageUrl
          },
          launchParameters: {
            startingMarketCap: coinData.startingMarketCap || 1000,
            fairLaunchDuration: coinData.fairLaunchDuration || 30,
            premineAmount: coinData.premineAmount || 0,
            buybackPercentage: coinData.buybackPercentage || 0,
            targetGroupId: targetGroup.id
          },
          network: selectedChain.name,
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Confirmation with prebuy suggestion
      const currentPrebuy = coinData.premineAmount || 0;
      let confirmationMessage = `ready to launch $${coinData.ticker}! sign the transaction to make it happen.`;
      
      if (currentPrebuy === 0) {
        confirmationMessage += `\n\nby the way, let me know if you want to prebuy a % of the coin supply and we can make that happen before launch!`;
      }
      
      await this.sendResponse(context, confirmationMessage);

      // Update state
      await context.updateState({
        coins: [
          ...context.userState.coins,
          {
            ticker: coinData.ticker,
            name: coinData.name,
            image: imageUrl,
            groupId: targetGroup.id.toLowerCase(),
            launched: false,
            fairLaunchDuration: 30 * 60,
            fairLaunchPercent: 10,
            initialMarketCap: 1000,
            chainId: selectedChain.id,
            chainName: selectedChain.name,
            createdAt: new Date()
          }
        ],
        groups: context.userState.groups.map(g => 
          g.id.toLowerCase() === targetGroup.id.toLowerCase()
            ? { ...g, coins: [...g.coins, coinData.ticker], updatedAt: new Date() }
            : g
        ),
        coinLaunchProgress: undefined
      });

    } catch (error) {
      this.logError('Failed to launch coin', error);
      await this.sendResponse(context, `failed to launch coin: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async isLaunchOptionsInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about launch options, capabilities, or what they can configure when launching coins.

        Message: "${messageText}"

        Examples of launch options inquiries:
        - "what launch options do you have?"
        - "what can I configure when launching?"
        - "what settings are available?"
        - "what parameters can I set?"
        - "what options do I have for launching?"
        - "tell me about launch capabilities"

        Respond with only "YES" if this is asking about launch options/capabilities, or "NO" if it's not.
      `
    });

    return response.trim().toUpperCase() === 'YES';
  }

  private async handleLaunchOptionsInquiry(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about launch options. Explain the configurable parameters available:

        1. Starting market cap: $100 to $10,000
        2. Fair launch duration: 1 to 60 minutes  
        3. Prebuy amount: 0% to 100% (prebuy coins before launch)
        4. Automated buybacks: 0% to 100% of fees go to automated buybacks

        Be brief and clear. Don't overwhelm with details. Use your character voice.
      `
    });

    await this.sendResponse(context, response);
  }

  private async isFutureFeatureInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about these specific future features:
        - Token transfers
        - Whitelists for coin launches  
        - Airdrops for coin launches

        Message: "${messageText}"

        Examples:
        - "can I transfer tokens?"
        - "do you support whitelists?"
        - "can I create airdrops?"
        - "what about token transfers?"

        Respond with only "YES" if asking about these future features, or "NO" if not.
      `
    });

    return response.trim().toUpperCase() === 'YES';
  }

  private async handleFutureFeatureInquiry(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about future features (token transfers, whitelists, airdrops).
        
        Respond that these features aren't available yet but the team has them on their list.
        Be brief and encouraging. Use your character voice.
      `
    });

    await this.sendResponse(context, response);
  }

  private async isLaunchDefaultsInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about launch defaults or default settings.

        Message: "${messageText}"

        Examples of launch defaults inquiries:
        - "what launch defaults do you have?"
        - "what are the default settings?"
        - "what are your defaults?"
        - "tell me the default parameters"
        - "what defaults do you use?"
        - "show me default launch settings"

        Respond with only "YES" if this is asking about launch defaults/default settings, or "NO" if it's not.
      `
    });

    return response.trim().toUpperCase() === 'YES';
  }

  private async handleLaunchDefaultsInquiry(context: FlowContext): Promise<void> {
    // Get the actual defaults from our environment and constants
    const defaultChain = getDefaultChain();
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about launch defaults. Provide the accurate default settings:

        Network: ${defaultChain.name} (${process.env.NETWORK || 'base-sepolia'})
        Starting market cap: $1,000 USD
        Fair launch: 10% of supply 
        Fair launch duration: 30 minutes
        Prebuy: 0% (no prebuy)
        Creator fees: 100% (creator gets all fees)
        Automated buybacks: 0% (no buybacks)

        Note: Ticker, name, and image are required fields you must provide - they have no defaults.

        Be brief and clear. Use your character voice. Don't mention technical details.
      `
    });

    await this.sendResponse(context, response);
  }

  private async isStatusInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about the status, progress, or current state of their coin launch.

        Message: "${messageText}"

        Examples of status inquiries:
        - "where are we at with the coin launch?"
        - "what's the status?"
        - "how's the launch going?"
        - "what do we still need?"
        - "what's missing?"
        - "where do we stand?"
        - "what's next?"

        Respond with only "YES" if this is asking about status/progress, or "NO" if it's not.
      `
    });

    return response.trim().toUpperCase() === 'YES';
  }

  private async handleStatusInquiry(context: FlowContext): Promise<void> {
    const { userState } = context;
    const progress = userState.coinLaunchProgress;
    
    if (!progress || !progress.coinData) {
      // Check if user is in onboarding (first coin) vs existing user
      const isFirstCoin = context.userState.status === 'onboarding' || context.userState.coins.length === 0;
      
      if (isFirstCoin) {
        await this.sendResponse(context, "ready to launch your first coin? give me a name, ticker, and image!");
      } else {
        await this.sendResponse(context, "ready for another coin launch! what coin do you want to launch?");
      }
      return;
    }

    const coinData = progress.coinData;
    const missing = [];
    
    if (!coinData.name) missing.push('coin name');
    if (!coinData.ticker) missing.push('ticker');
    if (!coinData.image) missing.push('image');
    
    // Check target group - missing if no ID or group not found
    let targetGroup = null;
    if (!progress.targetGroupId) {
      missing.push('target group');
    } else {
      targetGroup = userState.groups.find(g => g.id === progress.targetGroupId);
      if (!targetGroup) {
        missing.push('target group (not found)');
      }
    }
    
    let statusMessage = "coin launch status:\n\n";
    
    // Show what we have
    if (coinData.name) statusMessage += `name: ${coinData.name}\n`;
    if (coinData.ticker) statusMessage += `ticker: ${coinData.ticker}\n`;
    if (coinData.image) statusMessage += `image: ${coinData.image}\n`;
    if (progress.targetGroupId && targetGroup) {
      statusMessage += `target group: "${targetGroup.name}" (${targetGroup.id.slice(0, 8)}...${targetGroup.id.slice(-6)})\n`;
    }
    
    // Show what's missing
    if (missing.length > 0) {
      statusMessage += `\nstill need: ${missing.join(', ')}\n\n`;
      
      // If target group is missing, show available groups
      if (missing.some(item => item.includes('target group'))) {
        statusMessage += "available groups:\n\n";
        for (const group of userState.groups) {
          const groupDisplay = GroupCreationUtils.formatGroupDisplay(group, userState, {
            showClaimable: false,
            includeEmoji: true
          });
          statusMessage += groupDisplay + '\n';
        }
        statusMessage += "specify either the group name (e.g., \"Zenith Pack 50\") or contract address.";
      } else {
        statusMessage += "provide the missing info to continue.";
      }
    } else {
      statusMessage += "\nready to launch. say 'launch' to proceed.";
    }
    
    await this.sendResponse(context, statusMessage);
  }

  private async isLaunchCommand(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context).toLowerCase().trim();
    
    // Simple check for launch commands
    return messageText === 'launch' || 
           messageText === 'launch it' || 
           messageText === 'launch coin' || 
           messageText === 'go ahead' ||
           messageText === 'proceed' ||
           messageText === 'launch now';
  }

  private async handleLaunchCommand(context: FlowContext): Promise<void> {
    const { userState } = context;
    const progress = userState.coinLaunchProgress;
    
    if (!progress || !progress.coinData) {
      // Check if user is in onboarding (first coin) vs existing user
      const isFirstCoin = context.userState.status === 'onboarding' || context.userState.coins.length === 0;
      
      if (isFirstCoin) {
        await this.sendResponse(context, "ready to launch your first coin? give me a name, ticker, and image! 🚀");
      } else {
        await this.sendResponse(context, "ready for another coin launch! what coin do you want to launch?");
      }
      return;
    }

    const coinData = progress.coinData;
    
    // Check if we have all required data
    if (!coinData.name || !coinData.ticker || !coinData.image || !progress.targetGroupId) {
      await this.sendResponse(context, "missing required data. check status first.");
      return;
    }

    // Find the target group
    const targetGroup = userState.groups.find(g => g.id === progress.targetGroupId);
    if (!targetGroup) {
      await this.sendResponse(context, "target group not found. please select a group first.");
      return;
    }

    // Launch the coin
    await this.launchCoin(context, coinData as Required<CoinLaunchData>, targetGroup);
  }

} 
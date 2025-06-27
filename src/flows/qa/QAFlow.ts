import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
import { createLaunchExtractionPrompt, LaunchExtractionResult } from "../onboarding/launchExtractionTemplate";
import { createCoinLaunchExtractionPrompt, CoinLaunchExtractionResult } from "../coin-launch/coinLaunchExtractionTemplate";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";

export class QAFlow extends BaseFlow {
  constructor() {
    super('QAFlow');
  }

  async processMessage(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);
    
    this.log('Processing Q&A message', { 
      userId: context.userState.userId,
      message: messageText.substring(0, 100) + '...'
    });

    // ENHANCED: Check for multiple coin launch requests first
    const isMultipleCoinRequest = await this.detectMultipleCoinRequest(context, messageText);
    if (isMultipleCoinRequest) {
      await this.handleMultipleCoinRequest(context);
      return;
    }

    // Check if user with existing groups is trying to launch a coin
    if (context.userState.groups.length > 0) {
      const extraction = await this.extractCoinLaunchDetails(context);
      if (extraction && extraction.tokenDetails && 
          (extraction.tokenDetails.name || extraction.tokenDetails.ticker || context.hasAttachment)) {
        
        this.log('Coin launch detected in QA flow, redirecting to coin launch', {
          userId: context.userState.userId,
          tokenDetails: extraction.tokenDetails,
          launchParameters: extraction.launchParameters,
          hasAttachment: context.hasAttachment
        });

        // Start coin launch flow by initializing progress
        const coinData = {
          name: extraction.tokenDetails.name || undefined,
          ticker: extraction.tokenDetails.ticker || undefined,
          image: extraction.tokenDetails.image || (context.hasAttachment ? 'attachment_provided' : undefined)
        };

        const launchParameters = {
          startingMarketCap: extraction.launchParameters.startingMarketCap || undefined,
          fairLaunchDuration: extraction.launchParameters.fairLaunchDuration || undefined,
          premineAmount: extraction.launchParameters.premineAmount || undefined,
          buybackPercentage: extraction.launchParameters.buybackPercentage || undefined
        };

        await context.updateState({
          coinLaunchProgress: {
            step: 'collecting_coin_data',
            coinData,
            launchParameters,
            startedAt: new Date()
          }
        });

        // Show groups for selection if user has multiple groups
        if (context.userState.groups.length === 1) {
          const group = context.userState.groups[0];
          const groupDisplay = await GroupCreationUtils.formatAddress(group.id, context.ensResolver);
          await this.sendResponse(context, `launching ${extraction.tokenDetails.name || 'coin'} into your group ${groupDisplay}. what details are missing?`);
        } else {
          let message = `launching ${extraction.tokenDetails.name || 'coin'}! choose a group:\n\n`;
          
          // Resolve all group addresses at once
          const groupAddresses = context.userState.groups.map(g => g.id);
          const addressMap = await GroupCreationUtils.formatAddresses(groupAddresses, context.ensResolver);
          
          for (const group of context.userState.groups) {
            const groupDisplay = addressMap.get(group.id.toLowerCase()) || group.id;
            message += `${groupDisplay}\n`;
            message += `- coins: ${group.coins.length > 0 ? group.coins.join(', ') : 'none yet'}\n\n`;
          }
          message += "specify the contract address (group ID) you want to launch into.";
          await this.sendResponse(context, message);
        }
        return;
      }
    }

    // If user is in onboarding, check for coin details and fee receivers and store them
    if (context.userState.status === 'onboarding' && context.userState.onboardingProgress) {
      const extraction = await this.extractLaunchDetails(context);
      if (extraction) {
        let hasUpdates = false;
        let updatedProgress = { ...context.userState.onboardingProgress };

        // Store coin details if found
        if (extraction.tokenDetails && (extraction.tokenDetails.name || extraction.tokenDetails.ticker || extraction.tokenDetails.image)) {
          const currentCoinData = context.userState.onboardingProgress.coinData || { name: undefined, ticker: undefined, image: undefined };
          const updatedCoinData = {
            name: extraction.tokenDetails.name || currentCoinData.name,
            ticker: extraction.tokenDetails.ticker || currentCoinData.ticker,
            image: extraction.tokenDetails.image || currentCoinData.image
          };

          this.log('Coin details detected in QA flow, storing for onboarding', {
            userId: context.userState.userId,
            coinData: updatedCoinData
          });

          updatedProgress.coinData = updatedCoinData;
          hasUpdates = true;
        }

        // Store fee receiver data if found
        if (extraction.feeReceivers && extraction.feeReceivers.receivers && extraction.feeReceivers.receivers.length > 0) {
          this.log('Fee receivers detected in QA flow, storing for onboarding', {
            userId: context.userState.userId,
            receivers: extraction.feeReceivers.receivers,
            splitType: extraction.feeReceivers.splitType
          });

          // Convert extraction format to onboarding progress format
          const convertedReceivers = extraction.feeReceivers.receivers.map(receiver => ({
            username: receiver.type === 'self' ? context.creatorAddress : receiver.identifier,
            resolvedAddress: receiver.type === 'self' ? context.creatorAddress : undefined,
            percentage: receiver.percentage || undefined
          }));

          updatedProgress.splitData = {
            receivers: convertedReceivers,
            equalSplit: extraction.feeReceivers.splitType === 'equal',
            creatorPercent: 0
          };
          hasUpdates = true;
        }

        // Update state if we found any data
        if (hasUpdates) {
          await context.updateState({
            onboardingProgress: updatedProgress
          });
        }
      }
    }

    // For now, use character to generate a helpful response
    // TODO: Integrate with knowledge base
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User asked: "${messageText}"
        
        User context:
        - Status: ${context.userState.status}
        - Has ${context.userState.coins.length} coins
        - Has ${context.userState.groups.length} groups
        
        CRITICAL: Keep your response concise.
        
        Provide a helpful but concise response based on your knowledge about:
        - Group creation and management
        - Coin launching with Flaunch
        - Fee splitting mechanisms
        - Trading and fair launches
        
        Use your character's voice but prioritize brevity above all else.
      `
    });

    await this.sendResponse(context, response);
  }

  private async extractCoinLaunchDetails(context: FlowContext): Promise<CoinLaunchExtractionResult | null> {
    const messageText = this.extractMessageText(context);
    
    // Allow extraction even with empty message if there's an attachment
    if (!messageText && !context.hasAttachment) {
      return null;
    }

    try {
      const extractionPrompt = createCoinLaunchExtractionPrompt({ 
        message: messageText || '',
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? 'image' : undefined,
        imageUrl: undefined
      });
      
      const completion = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 500
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) {
        return null;
      }

      const result = JSON.parse(response) as CoinLaunchExtractionResult;
      
      this.log('🔍 COIN LAUNCH EXTRACTION RESULT', {
        messageText: messageText || '(empty with attachment)',
        hasAttachment: context.hasAttachment,
        tokenDetails: result.tokenDetails,
        launchParameters: result.launchParameters,
        timestamp: new Date().toISOString()
      });

      return result;
    } catch (error) {
      this.logError('Failed to extract coin launch details', error);
      return null;
    }
  }

  private async extractLaunchDetails(context: FlowContext): Promise<LaunchExtractionResult | null> {
    const messageText = this.extractMessageText(context);
    
    // Allow extraction even with empty message if there's an attachment
    if (!messageText && !context.hasAttachment) {
      return null;
    }

    try {
      const extractionPrompt = createLaunchExtractionPrompt({ 
        message: messageText || '',
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? 'image' : undefined
      });
      
      const completion = await context.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 1000
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) {
        return null;
      }

      const result = JSON.parse(response) as LaunchExtractionResult;
      
      this.log('🔍 LAUNCH EXTRACTION RESULT', {
        messageText: messageText || '(empty with attachment)',
        hasAttachment: context.hasAttachment,
        tokenDetails: result.tokenDetails,
        feeReceivers: result.feeReceivers,
        timestamp: new Date().toISOString()
      });

      return result;
    } catch (error) {
      this.logError('Failed to extract launch details', error);
      return null;
    }
  }

  /**
   * Detect if user is asking to launch multiple coins at once
   */
  private async detectMultipleCoinRequest(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Does this message request launching multiple coins/tokens? "${messageText}"
          
          Look for patterns like:
          - "launch 3 coins"
          - "create multiple tokens"
          - "launch COIN1 and COIN2"
          - "create tokens called X, Y, and Z"
          - "launch several coins"
          - "create a few tokens"
          - Multiple coin names or tickers in one request
          - Asking about batch/bulk coin creation
          
          Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to detect multiple coin request', error);
      return false;
    }
  }

  /**
   * Handle requests for multiple coin launches by explaining the limitation
   */
  private async handleMultipleCoinRequest(context: FlowContext): Promise<void> {
    await this.sendResponse(context, 
      "i can only launch one coin at a time! " +
      "let's start with your first coin - give me a name, ticker, and image. " +
      "after we launch it, we can create another one."
    );
  }
} 
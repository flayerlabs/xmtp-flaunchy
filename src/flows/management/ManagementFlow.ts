import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { validateWalletSendCalls } from "../utils/WalletSendCallsValidator";
import { createPublicClient, http, formatUnits } from "viem";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { getDefaultChain } from "../utils/ChainSelection";
import { CoinLaunchFlow } from "../coin-launch/CoinLaunchFlow";
import { AddressFeeSplitManagerAbi } from "../../../abi/AddressFeeSplitManager";
import { getDisplayName } from "../../../utils/ens";
import { getCharacterResponse } from "../../../utils/character";

type ManagementAction = 'list_groups' | 'list_coins' | 'add_coin' | 'claim_fees' | 'check_fees' | 'cancel_transaction' | 'general_help' | 'answer_question';

export class ManagementFlow extends BaseFlow {
  private coinLaunchFlow: CoinLaunchFlow;

  constructor() {
    super('ManagementFlow');
    this.coinLaunchFlow = new CoinLaunchFlow();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);
    
    this.log('Processing management message', { 
      userId: userState.userId,
      messageText: messageText?.substring(0, 100)
    });

    // Clear any conflicting pending transactions from other flows (but not our own)
    await this.clearCrossFlowTransactions(context);

    // Handle pending transactions
    if (userState.pendingTransaction && messageText) {
      const transactionResponse = await this.handlePendingTransaction(context, messageText);
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
      // If transactionResponse is null, continue to normal flow as fallback
    }

    // Handle ongoing management progress
    if (userState.managementProgress) {
      await this.handleOngoingProcess(context);
      return;
    }

    // Classify and handle the action
    const action = await this.classifyAction(messageText || '', context);
    await this.handleAction(context, action);
  }

  private async handlePendingTransaction(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    
    // Add comprehensive logging for debugging
    if (!userState.pendingTransaction) {
      this.log('No pending transaction found', {
        userId: userState.userId,
        messageText: messageText.substring(0, 100)
      });
      console.log('🚫 No pending transaction found for user:', userState.userId);
      return null;
    }
    
    // Log pending transaction details
    const pendingTx = userState.pendingTransaction;
    this.log('Found pending transaction', {
      userId: userState.userId,
      transactionType: pendingTx.type,
      pendingTransaction: pendingTx,
      messageText: messageText.substring(0, 100)
    });
    
    console.log('💳 PENDING TRANSACTION DETAILS:', {
      userId: userState.userId,
      type: pendingTx.type,
      coinData: pendingTx.coinData,
      launchParameters: pendingTx.launchParameters,
      network: pendingTx.network,
      timestamp: pendingTx.timestamp,
      messageText: messageText
    });
    
    // Use LLM to determine if the message is about the pending transaction
    const isTransactionRelated = await this.isMessageAboutPendingTransaction(context, messageText, userState.pendingTransaction?.type || 'unknown');
    
    console.log('🤖 TRANSACTION RELATION CHECK:', {
      userId: userState.userId,
      messageText,
      isTransactionRelated,
      transactionType: pendingTx.type
    });
    
    // If message is not transaction-related, don't handle it here
    if (!isTransactionRelated) {
      this.log('Message not about pending transaction, passing through', {
        userId: userState.userId,
        messageText: messageText.substring(0, 100)
      });
      console.log('⏭️ Message not transaction-related, passing to normal flow');
      return null;
    }
    
    console.log('✅ Message IS transaction-related, handling...');
    
    // Use LLM to classify the transaction-related intent
    const transactionIntent = await this.classifyTransactionIntent(context, messageText);
    
    console.log('🎯 TRANSACTION INTENT:', {
      userId: userState.userId,
      intent: transactionIntent,
      messageText
    });
    
    switch (transactionIntent) {
      case 'cancel':
        console.log('🚫 CANCELLING TRANSACTION');
        await this.cancelTransaction(context);
        return 'transaction cancelled.';
        
      case 'modify':
        console.log('🔧 MODIFYING TRANSACTION');
        const modifyResult = await this.modifyTransaction(context, messageText);
        console.log('🔧 MODIFY RESULT:', { modifyResult, isNull: modifyResult === null });
        return modifyResult;
        
      case 'inquiry':
        console.log('❓ HANDLING INQUIRY');
        return await this.handleTransactionInquiry(context, messageText);
        
      default:
        console.log('❓ DEFAULT TO INQUIRY');
        return await this.handleTransactionInquiry(context, messageText);
    }
  }

  private async isMessageAboutPendingTransaction(context: FlowContext, messageText: string, transactionType: string): Promise<boolean> {
    const { userState } = context;
    const pendingTx = userState.pendingTransaction;
    
    if (!pendingTx) return false;
    
    // Build comprehensive transaction context
    let transactionContext = `The user has a pending ${transactionType} transaction with the following details:\n\n`;
    
    if (pendingTx.type === 'coin_creation' && pendingTx.coinData) {
      transactionContext += `Coin Details:\n`;
      transactionContext += `- Name: ${pendingTx.coinData.name}\n`;
      transactionContext += `- Ticker: ${pendingTx.coinData.ticker}\n`;
      transactionContext += `- Image: ${pendingTx.coinData.image}\n\n`;
      
      if (pendingTx.launchParameters) {
        transactionContext += `Launch Parameters:\n`;
        transactionContext += `- Starting Market Cap: $${pendingTx.launchParameters.startingMarketCap || 1000}\n`;
        transactionContext += `- Fair Launch Duration: ${pendingTx.launchParameters.fairLaunchDuration || 30} minutes\n`;
        transactionContext += `- Prebuy Amount: ${pendingTx.launchParameters.premineAmount || 0}%\n`;
        transactionContext += `- Buyback Percentage: ${pendingTx.launchParameters.buybackPercentage || 0}%\n`;
        if (pendingTx.launchParameters.targetGroupId) {
          transactionContext += `- Target Group: ${pendingTx.launchParameters.targetGroupId}\n`;
        }
        transactionContext += `\n`;
      }
    } else if (pendingTx.type === 'group_creation') {
      // Get group creation details from progress
      let receivers: any[] = [];
      if (userState.managementProgress?.groupCreationData?.receivers) {
        receivers = userState.managementProgress.groupCreationData.receivers;
      } else if (userState.onboardingProgress?.splitData?.receivers) {
        receivers = userState.onboardingProgress.splitData.receivers;
      }
      
      if (receivers.length > 0) {
        transactionContext += `Group Creation Details:\n`;
        transactionContext += `- Fee Receivers: ${receivers.length}\n`;
        receivers.forEach((r, i) => {
          const displayName = r.username || `${r.resolvedAddress?.slice(0, 6)}...${r.resolvedAddress?.slice(-4)}`;
          transactionContext += `  ${i + 1}. ${displayName}${r.percentage ? ` (${r.percentage}%)` : ''}\n`;
        });
        transactionContext += `\n`;
      }
    }
    
    transactionContext += `Network: ${pendingTx.network}\n`;
    transactionContext += `Created: ${new Date(pendingTx.timestamp).toLocaleString()}\n\n`;
    
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `${transactionContext}Is this message about that pending transaction?

Message: "${messageText}"

Consider the message about the pending transaction if it:
- Contains words like "update", "change", "modify", "set", "adjust", "fix"
- Mentions specific transaction parameters (market cap, duration, prebuy, premine, buyback, etc.)
- Asks about transaction status or details
- Wants to cancel the transaction
- References signing or confirming
- Asks about coin details that are part of the transaction
- Asks about launch parameters or settings
- Contains phrases like "please update", "change to", "set to", "make it"

FOR GROUP CREATION transactions, ALSO consider it about the transaction if it:
- Contains words like "add", "include", "append", "remove", "exclude"
- Mentions adding/removing people, usernames, or addresses
- References group members or fee receivers
- Contains phrases like "add @username", "include everyone", "can you add"

ESPECIALLY if the message mentions:
- "prebuy", "premine", "market cap", "duration", "buyback" with values or percentages
- "update the [parameter] to [value]"
- "change [parameter]"
- "add @username" or "include [person]"

Do NOT consider it about the transaction if it's:
- Asking about existing/completed groups or coins
- General questions about capabilities
- Completely unrelated requests

Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to determine if message is about pending transaction', error);
      // Conservative fallback - assume it's not about the transaction
      return false;
    }
  }

  private async classifyTransactionIntent(context: FlowContext, messageText: string): Promise<'cancel' | 'modify' | 'inquiry'> {
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Classify this transaction-related message:

Message: "${messageText}"

Categories:
- cancel: User wants to cancel/stop the transaction
- modify: User wants to add/change/update transaction details
- inquiry: User is asking about transaction status/details

Respond with only: cancel, modify, or inquiry`
        }],
        temperature: 0.1,
        max_tokens: 10
      });

      const intent = response.choices[0]?.message?.content?.trim().toLowerCase();
      if (intent && ['cancel', 'modify', 'inquiry'].includes(intent)) {
        return intent as 'cancel' | 'modify' | 'inquiry';
      }
    } catch (error) {
      this.logError('Failed to classify transaction intent', error);
    }

    // Default to inquiry
    return 'inquiry';
  }

  private async modifyTransaction(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    const pendingTx = userState.pendingTransaction;
    
    if (!pendingTx) {
      return "no pending transaction to modify.";
    }
    
    // Handle coin creation transaction modifications
    if (pendingTx.type === 'coin_creation') {
      return await this.modifyCoinTransaction(context, messageText);
    }
    
    // Handle group creation transaction modifications
    if (pendingTx.type === 'group_creation') {
      return await this.modifyGroupTransaction(context, messageText);
    }
    
    return "couldn't determine transaction type to modify.";
  }
  
  private async modifyCoinTransaction(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    const pendingTx = userState.pendingTransaction!;
    
    // Use LLM to extract parameter changes from the message
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Extract coin launch parameter changes from this message:

Message: "${messageText}"

Current parameters:
- Starting Market Cap: $${pendingTx.launchParameters?.startingMarketCap || 1000}
- Fair Launch Duration: ${pendingTx.launchParameters?.fairLaunchDuration || 30} minutes
- Prebuy Amount: ${pendingTx.launchParameters?.premineAmount || 0}%
- Buyback Percentage: ${pendingTx.launchParameters?.buybackPercentage || 0}%

IMPORTANT TERMINOLOGY:
- "prebuy", "premine", "pre-buy", "pre-mine" → refers to premineAmount (tokens bought at launch, costs ETH)
- "buyback", "buy back", "automated buybacks" → refers to buybackPercentage (fee allocation for buybacks)

Return ONLY a JSON object with any changed parameters:
{
  "startingMarketCap": number (if mentioned),
  "fairLaunchDuration": number (if mentioned, in minutes),
  "premineAmount": number (if mentioned, as percentage for prebuy/premine),
  "buybackPercentage": number (if mentioned, as percentage for buybacks)
}

If no parameters are mentioned, return: {}`
        }],
        temperature: 0.1,
        max_tokens: 100
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        return "couldn't understand what parameters to change.";
      }

      let parameterChanges;
      try {
        parameterChanges = JSON.parse(content);
      } catch (error) {
        return "couldn't understand what parameters to change.";
      }

      if (Object.keys(parameterChanges).length === 0) {
        return "couldn't understand what parameters to change.";
      }

      // Validate parameter ranges
      if (parameterChanges.startingMarketCap !== undefined) {
        if (parameterChanges.startingMarketCap < 100 || parameterChanges.startingMarketCap > 10000) {
          return "starting market cap must be between $100 and $10,000.";
        }
      }
      
      if (parameterChanges.fairLaunchDuration !== undefined) {
        if (parameterChanges.fairLaunchDuration < 1 || parameterChanges.fairLaunchDuration > 1440) {
          return "fair launch duration must be between 1 minute and 24 hours (1440 minutes).";
        }
      }
      
      if (parameterChanges.premineAmount !== undefined) {
        if (parameterChanges.premineAmount < 0 || parameterChanges.premineAmount > 50) {
          return "prebuy amount must be between 0% and 50%.";
        }
      }
      
      if (parameterChanges.buybackPercentage !== undefined) {
        if (parameterChanges.buybackPercentage < 0 || parameterChanges.buybackPercentage > 100) {
          return "buyback percentage must be between 0% and 100%.";
        }
      }

      // Update the pending transaction with new parameters
      const updatedLaunchParameters = {
        ...pendingTx.launchParameters,
        ...parameterChanges
      };

      // Find the target group
      const targetGroupId = updatedLaunchParameters.targetGroupId || pendingTx.launchParameters?.targetGroupId;
      const targetGroup = userState.groups.find(g => g.id === targetGroupId);
      
      if (!targetGroup) {
        return "couldn't find the target group for your coin launch.";
      }

      // Rebuild the transaction with updated parameters
      const coinData = pendingTx.coinData!;
      
      // Import the CoinLaunchFlow to use its rebuild method
      if (this.coinLaunchFlow) {
        await this.coinLaunchFlow.rebuildAndSendTransaction(context, {
          name: coinData.name,
          ticker: coinData.ticker,
          image: coinData.image,
          targetGroup: targetGroup.id,
          startingMarketCap: updatedLaunchParameters.startingMarketCap || 1000,
          fairLaunchDuration: updatedLaunchParameters.fairLaunchDuration || 30,
          premineAmount: updatedLaunchParameters.premineAmount || 0,
          buybackPercentage: updatedLaunchParameters.buybackPercentage || 0
        } as any, targetGroup);
        
        // CoinLaunchFlow already sends a response, so we don't need to send another one
        return null; // Return null to indicate no additional response needed
      }
      
      return "couldn't update transaction parameters.";
      
    } catch (error) {
      this.logError('Failed to modify coin transaction', error);
      return "failed to update transaction parameters.";
    }
  }
  
  private async modifyGroupTransaction(context: FlowContext, messageText: string): Promise<string> {
    const { userState } = context;
    
    // Get existing receivers
    let existingReceivers: any[] = [];
    if (userState.managementProgress?.groupCreationData?.receivers) {
      existingReceivers = userState.managementProgress.groupCreationData.receivers;
    } else if (userState.onboardingProgress?.splitData?.receivers) {
      existingReceivers = userState.onboardingProgress.splitData.receivers;
    }

    // Check if user wants to add everyone from chat
    const isAddEveryone = await this.isAddEveryone(context, messageText);
    
    if (isAddEveryone) {
      // Add all chat members
      const chatMembers = await context.conversation.members();
      const everyoneReceivers = [];

      for (const member of chatMembers) {
        if (member.inboxId !== context.client.inboxId) {
          const memberInboxState = await context.client.preferences.inboxStateFromInboxIds([member.inboxId]);
          if (memberInboxState.length > 0 && memberInboxState[0].identifiers.length > 0) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            everyoneReceivers.push({
              username: memberAddress,
              resolvedAddress: memberAddress,
              percentage: undefined
            });
          }
        }
      }

      // Combine with existing receivers (avoid duplicates)
      const combinedReceivers = [...existingReceivers];
      for (const newReceiver of everyoneReceivers) {
        const exists = combinedReceivers.some(existing => 
          existing.resolvedAddress?.toLowerCase() === newReceiver.resolvedAddress?.toLowerCase()
        );
        if (!exists && newReceiver.resolvedAddress) {
          combinedReceivers.push(newReceiver);
        }
      }

      // Create new transaction with everyone + existing
      try {
        const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          combinedReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Create Group"
        );

        // Update state
        await context.updateState({
          pendingTransaction: {
            type: 'group_creation',
            network: getDefaultChain().name,
            timestamp: new Date()
          },
          managementProgress: {
            action: 'creating_group',
            step: 'creating_transaction',
            groupCreationData: {
              receivers: combinedReceivers
            },
            startedAt: new Date()
          }
        });

        // Send transaction
        if (validateWalletSendCalls(walletSendCalls)) {
          await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
          
          // Create display names for confirmation
          const displayNames = combinedReceivers.map(r => {
            if (r.username && r.username !== r.resolvedAddress && !r.username.startsWith('0x')) {
              return r.username.startsWith('@') ? r.username : `@${r.username}`;
            } else {
              return `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`;
            }
          }).join(', ');
          
          return `updated group with ${combinedReceivers.length} members: ${displayNames}. sign to create!`;
        }
      } catch (error) {
        this.logError('Failed to modify group transaction with everyone', error);
        return 'failed to update transaction. please try again.';
      }
    }

    // Extract new receivers using shared utility (for specific usernames)
    const extraction = await GroupCreationUtils.extractFeeReceivers(context);
    
    if (extraction && extraction.receivers.length > 0) {
      // Resolve new receivers
      const newReceivers = await GroupCreationUtils.resolveUsernames(context, extraction.receivers);
      
      // Combine with existing (avoid duplicates)
      const combinedReceivers = [...existingReceivers];
      for (const newReceiver of newReceivers) {
        const exists = combinedReceivers.some(existing => 
          existing.resolvedAddress?.toLowerCase() === newReceiver.resolvedAddress?.toLowerCase()
        );
        if (!exists && newReceiver.resolvedAddress) {
          combinedReceivers.push(newReceiver);
        }
      }

      // Create new transaction
      try {
        const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          combinedReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Create Group"
        );

        // Update state
        await context.updateState({
          pendingTransaction: {
            type: 'group_creation',
            network: getDefaultChain().name,
            timestamp: new Date()
          },
          managementProgress: {
            action: 'creating_group',
            step: 'creating_transaction',
            groupCreationData: {
              receivers: combinedReceivers
            },
            startedAt: new Date()
          }
        });

        // Send transaction
        if (validateWalletSendCalls(walletSendCalls)) {
          await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
          
          // Create display names for confirmation
          const displayNames = combinedReceivers.map(r => {
            if (r.username && r.username !== r.resolvedAddress && !r.username.startsWith('0x')) {
              return r.username.startsWith('@') ? r.username : `@${r.username}`;
            } else {
              return `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`;
            }
          }).join(', ');
          
          return `updated group with ${combinedReceivers.length} members: ${displayNames}. sign to create!`;
        }
      } catch (error) {
        this.logError('Failed to modify group transaction', error);
        return 'failed to update transaction. please try again.';
      }
    }
    
    return "couldn't understand who to add. please specify usernames or addresses.";
  }

  private async handleTransactionInquiry(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    
    if (!userState.pendingTransaction) return null;

    const pendingTx = userState.pendingTransaction;
    
    // Use LLM to generate a comprehensive response about the transaction
    let transactionDetails = '';
    
    if (pendingTx.type === 'coin_creation' && pendingTx.coinData) {
      transactionDetails += `Your ${pendingTx.coinData.name} ($${pendingTx.coinData.ticker}) launch transaction:\n\n`;
      
      if (pendingTx.launchParameters) {
        transactionDetails += `Launch Parameters:\n`;
        transactionDetails += `• Starting Market Cap: $${pendingTx.launchParameters.startingMarketCap || 1000}\n`;
        transactionDetails += `• Fair Launch Duration: ${pendingTx.launchParameters.fairLaunchDuration || 30} minutes\n`;
        
        // Calculate fair launch supply (40% of total supply by default)
        const fairLaunchPercent = 10; // This is the default from the system
        const totalSupply = 100; // 100 tokens total supply
        const fairLaunchSupply = (totalSupply * fairLaunchPercent) / 100;
        transactionDetails += `• Fair Launch Supply: ${fairLaunchSupply} ${pendingTx.coinData.ticker} (${fairLaunchPercent}% of total)\n`;
        
        if (pendingTx.launchParameters.premineAmount && pendingTx.launchParameters.premineAmount > 0) {
          transactionDetails += `• Prebuy: ${pendingTx.launchParameters.premineAmount}%\n`;
        }
        if (pendingTx.launchParameters.buybackPercentage && pendingTx.launchParameters.buybackPercentage > 0) {
          transactionDetails += `• Buybacks: ${pendingTx.launchParameters.buybackPercentage}%\n`;
        }
        if (pendingTx.launchParameters.targetGroupId) {
          // Find the group name
          const targetGroup = userState.groups.find(g => g.id === pendingTx.launchParameters?.targetGroupId);
          const groupDisplay = targetGroup ? 
            `${pendingTx.launchParameters.targetGroupId.slice(0, 6)}...${pendingTx.launchParameters.targetGroupId.slice(-4)}` :
            pendingTx.launchParameters.targetGroupId;
          transactionDetails += `• Target Group: ${groupDisplay}\n`;
        }
      }
      
      transactionDetails += `\nready to sign and launch!`;
      
    } else if (pendingTx.type === 'group_creation') {
      // Get group creation details
      let receivers: any[] = [];
      if (userState.managementProgress?.groupCreationData?.receivers) {
        receivers = userState.managementProgress.groupCreationData.receivers;
      } else if (userState.onboardingProgress?.splitData?.receivers) {
        receivers = userState.onboardingProgress.splitData.receivers;
      }

      if (receivers.length > 0) {
        const receiverList = receivers
          .map((r: any) => {
            const displayName = (r.username && r.username.startsWith('0x') && r.username.length === 42)
              ? `${r.username.slice(0, 6)}...${r.username.slice(-4)}`
              : (r.username || `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`);
            return `${displayName}${r.percentage ? ` (${r.percentage}%)` : ''}`;
          })
          .join(', ');
        transactionDetails = `your group creation transaction with ${receivers.length} fee receivers: ${receiverList}\n\nready to sign and create!`;
      } else {
        transactionDetails = 'your group creation transaction is ready to sign.';
      }
    }

    return transactionDetails || 'transaction ready to sign.';
  }

  private async cancelTransaction(context: FlowContext): Promise<void> {
    await context.updateState({
      pendingTransaction: undefined,
      managementProgress: undefined
    });
  }

  private async handleOngoingProcess(context: FlowContext): Promise<void> {
    const progress = context.userState.managementProgress!;
    
    if (progress.action === 'creating_group') {
      await this.handleGroupCreation(context);
    } else if (progress.action === 'adding_coin') {
      await this.coinLaunchFlow.processMessage(context);
    }
  }

  private async handleGroupCreation(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);
    
    // Check for "add everyone"
    if (await this.isAddEveryone(context, messageText)) {
      await this.addEveryoneFromChat(context);
      return;
    }

    // Use shared utility for group creation
    let result;
    try {
      result = await GroupCreationUtils.createGroupFromMessage(
        context,
        getDefaultChain(),
        "Create Additional Group"
      );
    } catch (error) {
      // Handle specific validation errors with user-friendly messages
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('Total shares') && errorMessage.includes('do not equal required total')) {
        // Parse the percentage issue
        await this.sendResponse(context, "percentages must add up to 100%. try again or let me do equal splits.");
        return;
      } else if (errorMessage.includes('Couldn\'t resolve these usernames')) {
        // Handle username resolution failures
        await this.sendResponse(context, errorMessage.toLowerCase());
        return;
      } else {
        // Handle other errors
        this.logError('Group creation error', error);
        await this.sendResponse(context, "something went wrong creating the group. please try again or contact support.");
        return;
      }
    }

    if (result) {
      // Clear management progress and set pending transaction
      await context.updateState({
        managementProgress: undefined,
        pendingTransaction: {
          type: 'group_creation',
          network: result.chainConfig.name,
          timestamp: new Date()
        }
      });

      // Send transaction
      if (validateWalletSendCalls(result.walletSendCalls)) {
        await context.conversation.send(result.walletSendCalls, ContentTypeWalletSendCalls);
        await this.sendResponse(context, "sign to create your new group!");
      }
    } else {
      await this.sendResponse(context, "who should receive trading fees? tag usernames or say 'everyone'.");
    }
  }

  private async classifyAction(messageText: string, context: FlowContext): Promise<ManagementAction> {
    if (!messageText.trim()) {
      return 'general_help';
    }

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Classify this user message into ONE of these exact actions:

Actions:
- list_groups: User wants to see their groups (what groups, show groups, my groups, etc.)
- list_coins: User wants to see their coins (what coins, show coins, my coins, etc.)
- add_coin: User wants to launch/create a coin
- claim_fees: User wants to claim fees
- check_fees: User wants to check available/claimable fees (how much fees, available fees, claimable balance, etc.)
- cancel_transaction: User wants to cancel a transaction
- general_help: User is asking what the bot can do or general capabilities
- answer_question: User is asking a specific question that needs a direct answer (not requesting an action)

User message: "${messageText}"

Respond with ONLY the action name (e.g., "list_coins")`
        }],
        temperature: 0.1,
        max_tokens: 20
      });

      const action = response.choices[0]?.message?.content?.trim() as ManagementAction;
      
      // Validate the response is a valid action
      const validActions: ManagementAction[] = ['list_groups', 'list_coins', 'add_coin', 'claim_fees', 'check_fees', 'cancel_transaction', 'general_help', 'answer_question'];
      if (validActions.includes(action)) {
        return action;
      }
    } catch (error) {
      this.logError('Failed to classify action with LLM', error);
    }

    // Fallback to general help if LLM fails
    return 'general_help';
  }

  private async handleAction(context: FlowContext, action: ManagementAction): Promise<void> {
    switch (action) {
      case 'list_groups':
        await this.listGroups(context);
        break;
      case 'list_coins':
        await this.listCoins(context);
        break;
      case 'add_coin':
        await this.addCoin(context);
        break;
      case 'claim_fees':
        await this.claimFees(context);
        break;
      case 'check_fees':
        await this.checkFees(context);
        break;
      case 'cancel_transaction':
        await this.cancelTransaction(context);
        await this.sendResponse(context, "transaction cancelled!");
        break;
      case 'answer_question':
        await this.answerQuestion(context);
        break;
      default:
        await this.generalHelp(context);
        break;
    }
  }

  private async listGroups(context: FlowContext): Promise<void> {
    const { userState } = context;
    const currentChain = getDefaultChain();
    
    // Only show groups on current network
    const currentNetworkGroups = userState.groups.filter(group => group.chainName === currentChain.name);
    
    if (currentNetworkGroups.length === 0) {
      await this.sendResponse(context, `no groups on ${currentChain.displayName} yet. create one first to get started!`);
      return;
    }

    try {
      // Get detailed information for each group
      const groupDetails = await Promise.all(
        currentNetworkGroups.map(async (group) => {
          const balance = await this.getGroupBalance(group, context.creatorAddress);
          const coinCount = this.getGroupCoinCount(group, userState);
          const receivers = await this.formatGroupReceivers(group);
          
          return {
            id: group.id,
            receivers,
            coinCount,
            balance
          };
        })
      );

      // Format the response
      let message = `your ${currentNetworkGroups.length} group${currentNetworkGroups.length > 1 ? 's' : ''} on ${currentChain.displayName}:\n\n`;
      
      for (const group of groupDetails) {
        message += `• Group ID: ${group.id}\n`;
        message += `  Fee receivers: ${group.receivers}\n`;
        message += `  Coins: ${group.coinCount}\n`;
        message += `  Claimable: ${group.balance.toFixed(6)} ETH\n\n`;
      }
      
      message += `manage at https://mini.flaunch.gg`;
      await this.sendResponse(context, message);
      
    } catch (error) {
      this.logError('Failed to get group details', error);
      await this.sendResponse(context, `you have ${currentNetworkGroups.length} group${currentNetworkGroups.length > 1 ? 's' : ''} on ${currentChain.displayName}. manage at https://mini.flaunch.gg`);
    }
  }

  private async listCoins(context: FlowContext): Promise<void> {
    const { userState } = context;
    const currentChain = getDefaultChain();
    
    // Only show coins on current network
    const currentNetworkCoins = userState.coins.filter(coin => coin.launched && coin.chainName === currentChain.name);
    const currentNetworkGroups = userState.groups.filter(group => group.chainName === currentChain.name);
    
    if (currentNetworkCoins.length === 0) {
      if (currentNetworkGroups.length === 0) {
        await this.sendResponse(context, `no coins or groups on ${currentChain.displayName} yet. create a group first to get started!`);
      } else {
        await this.sendResponse(context, `no coins on ${currentChain.displayName} yet. launch one into your existing group!`);
      }
      return;
    }

    try {
      // Check fee balances for current network groups
      const totalFees = await this.checkFeeBalances(currentNetworkGroups, context.creatorAddress);
      
      let message = `you have ${currentNetworkCoins.length} coin${currentNetworkCoins.length > 1 ? 's' : ''} on ${currentChain.displayName}.`;
      
      if (totalFees > 0) {
        message += ` claimable fees: ${totalFees.toFixed(6)} ETH.`;
      }
      
      message += ` manage at https://mini.flaunch.gg`;
      await this.sendResponse(context, message);
      
    } catch (error) {
      this.logError('Failed to check fee balances', error);
      await this.sendResponse(context, `you have ${currentNetworkCoins.length} coin${currentNetworkCoins.length > 1 ? 's' : ''} on ${currentChain.displayName}. manage at https://mini.flaunch.gg`);
    }
  }

  private async createGroup(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);
    
    // Check for "add everyone" in the message
    if (await this.isAddEveryone(context, messageText)) {
      await this.addEveryoneFromChat(context);
      return;
    }

    // Start group creation progress
    await context.updateState({
      managementProgress: {
        action: 'creating_group',
        step: 'collecting_fee_receivers',
        startedAt: new Date()
      }
    });

    await this.sendResponse(context, "who should receive trading fees? tag usernames or say 'everyone'.");
  }

  private async addCoin(context: FlowContext): Promise<void> {
    // Delegate to CoinLaunchFlow
    await this.coinLaunchFlow.processMessage(context);
  }

  private async claimFees(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "claim fees at https://mini.flaunch.gg");
  }

  private async checkFees(context: FlowContext): Promise<void> {
    const { userState } = context;
    const currentChain = getDefaultChain();
    
    // Only check groups on current network
    const currentNetworkGroups = userState.groups.filter(group => group.chainName === currentChain.name);
    
    if (currentNetworkGroups.length === 0) {
      await this.sendResponse(context, `no groups on ${currentChain.displayName} yet. create a group first to start earning fees!`);
      return;
    }

    try {
      // Check fee balances for current network groups
      const totalFees = await this.checkFeeBalances(currentNetworkGroups, context.creatorAddress);
      
      if (totalFees > 0) {
        await this.sendResponse(context, `you have ${totalFees.toFixed(6)} ETH in claimable fees across ${currentNetworkGroups.length} group${currentNetworkGroups.length > 1 ? 's' : ''}. claim at https://mini.flaunch.gg`);
      } else {
        await this.sendResponse(context, `no claimable fees yet across ${currentNetworkGroups.length} group${currentNetworkGroups.length > 1 ? 's' : ''}. fees accumulate from coin trading!`);
      }
      
    } catch (error) {
      this.logError('Failed to check fee balances', error);
      await this.sendResponse(context, `couldn't check fee balances right now. view at https://mini.flaunch.gg`);
    }
  }

  private async generalHelp(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "i can help you:\n- list coins and groups\n- launch coins and create groups\n- show claimable balances");
  }

  private async answerQuestion(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);
    
    // Check if this is a question about pending transactions
    const isTransactionStatusQuestion = await this.isTransactionStatusQuestion(context, messageText);
    
    if (isTransactionStatusQuestion) {
      if (userState.pendingTransaction) {
        // User has a pending transaction, provide details
        const transactionDetails = await this.handleTransactionInquiry(context, messageText);
        if (transactionDetails) {
          await this.sendResponse(context, transactionDetails);
          return;
        }
      } else {
        // User has no pending transaction
        await this.sendResponse(context, "no pending transactions. you're all set!");
        return;
      }
    }
    
    // For other questions, try to answer with character knowledge
    try {
      // For now, just provide a simple fallback since we don't have character context here
      await this.sendResponse(context, "i can help you list coins/groups, launch coins, create groups, and show claimable balances.");
    } catch (error) {
      this.logError('Failed to get character response', error);
      await this.sendResponse(context, "i can't help with that, i'm focused on coin launches and groups.");
    }
  }
  
  private async isTransactionStatusQuestion(context: FlowContext, messageText: string): Promise<boolean> {
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Is this message asking about transaction status or pending transactions?

Message: "${messageText}"

Look for questions like:
- "do I have a pending transaction?"
- "do I have an existing transaction?"
- "what's my transaction status?"
- "is there a transaction waiting?"
- "any pending transactions?"
- "transaction status?"

Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to determine if message is transaction status question', error);
      return false;
    }
  }

  private async isAddEveryone(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;
    
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Does this message request to include all group chat members? "${messageText}"
          
          Look for requests like:
          - "everyone"
          - "for everyone"
          - "all members"
          - "include everyone"
          - "everyone in the chat"
          - "add everyone"
          - "all"
          
          Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to detect add everyone intent', error);
      return false;
    }
  }

  private async addEveryoneFromChat(context: FlowContext): Promise<void> {
    try {
      // Get conversation members
      const members = await context.conversation.members();
      const feeReceivers = [];

      for (const member of members) {
        if (member.inboxId !== context.client.inboxId) {
          const memberInboxState = await context.client.preferences.inboxStateFromInboxIds([member.inboxId]);
          if (memberInboxState.length > 0 && memberInboxState[0].identifiers.length > 0) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            feeReceivers.push({
              username: memberAddress,
              resolvedAddress: memberAddress,
              percentage: undefined
            });
          }
        }
      }

      if (feeReceivers.length === 0) {
        await this.sendResponse(context, "couldn't find group members. specify receivers manually.");
        return;
      }

      // Create group
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        feeReceivers,
        context.creatorAddress,
        getDefaultChain(),
        "Create Group with All Members"
      );

      // Update state
      await context.updateState({
        managementProgress: undefined,
        pendingTransaction: {
          type: 'group_creation',
          network: getDefaultChain().name,
          timestamp: new Date()
        }
      });

      // Send transaction
      if (validateWalletSendCalls(walletSendCalls)) {
        await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
        
        // Create display names for confirmation
        const displayNames = feeReceivers.map(r => {
          if (r.username && r.username !== r.resolvedAddress && !r.username.startsWith('0x')) {
            return r.username.startsWith('@') ? r.username : `@${r.username}`;
          } else {
            return `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`;
          }
        }).join(', ');
        
        await this.sendResponse(context, `creating group with ${feeReceivers.length} members: ${displayNames}. sign to create!`);
      }

    } catch (error) {
      this.logError('Failed to add everyone', error);
      await this.sendResponse(context, "couldn't add everyone. specify receivers manually.");
    }
  }

  private async checkFeeBalances(userGroups: UserGroup[], userAddress: string): Promise<number> {
    if (userGroups.length > 20) return 0; // Skip for performance
    
    const currentChain = getDefaultChain();
    let totalBalance = 0;
    
    try {
      // Only check groups on the current network
      const currentNetworkGroups = userGroups.filter(group => group.chainName === currentChain.name);
      
      if (currentNetworkGroups.length === 0) return 0;

      const publicClient = createPublicClient({
        chain: currentChain.viemChain,
        transport: http()
      });

      for (const group of currentNetworkGroups) {
        try {
          const balance = await publicClient.readContract({
            address: group.id as `0x${string}`,
            abi: AddressFeeSplitManagerAbi,
            functionName: 'balances',
            args: [userAddress as `0x${string}`]
          });
          
          totalBalance += parseFloat(formatUnits(balance, 18));
        } catch (error) {
          // Skip individual errors
        }
      }
    } catch (error) {
      this.logError('Fee balance check failed', error);
    }
    
    return totalBalance;
  }

  private async getGroupBalance(group: UserGroup, userAddress: string): Promise<number> {
    try {
      const currentChain = getDefaultChain();
      const publicClient = createPublicClient({
        chain: currentChain.viemChain,
        transport: http()
      });

      const balance = await publicClient.readContract({
        address: group.id as `0x${string}`,
        abi: AddressFeeSplitManagerAbi,
        functionName: 'balances',
        args: [userAddress as `0x${string}`]
      });
      
      return parseFloat(formatUnits(balance, 18));
    } catch (error) {
      this.logError('Failed to get group balance', error);
      return 0;
    }
  }

  private getGroupCoinCount(group: UserGroup, userState: any): number {
    // Count coins that belong to this group and are launched
    return userState.coins.filter((coin: any) => 
      coin.groupId === group.id && coin.launched
    ).length;
  }

  private async formatGroupReceivers(group: UserGroup): Promise<string> {
    const receiverCount = group.receivers?.length || 0;
    if (receiverCount === 0) return "no fee receivers";
    if (receiverCount === 1) return "1 fee receiver";
    return `${receiverCount} fee receivers`;
  }

  /**
   * Clear pending transactions from other flows when starting management operations
   * Only clears coin_creation transactions since management handles group_creation
   */
  private async clearCrossFlowTransactions(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    // Only clear coin_creation transactions, since management flow handles group_creation
    if (userState.pendingTransaction && userState.pendingTransaction.type === 'coin_creation') {
      const pendingTx = userState.pendingTransaction;
      
      this.log('Clearing cross-flow pending transaction', {
        userId: userState.userId,
        transactionType: pendingTx.type,
        reason: 'User explicitly started management operation'
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateState({
        pendingTransaction: undefined,
        // Clear coin launch progress if it exists (user switching from coin launch to management)
        coinLaunchProgress: undefined
      });

      // NO USER MESSAGE - clearing should be invisible to the user
      // They just want their management action completed, not to hear about technical cleanup
    }
  }
} 
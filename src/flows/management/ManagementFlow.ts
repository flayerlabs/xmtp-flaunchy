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

type ManagementAction = 'list_groups' | 'list_coins' | 'add_coin' | 'create_group' | 'claim_fees' | 'check_fees' | 'cancel_transaction' | 'general_help' | 'answer_question';

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

    // Handle pending transactions
    if (userState.pendingTransaction && messageText) {
      const transactionResponse = await this.handlePendingTransaction(context, messageText);
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
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
    
    // Simple intent detection for pending transactions
    const lowerMessage = messageText.toLowerCase();
    
    if (lowerMessage.includes('cancel') || lowerMessage.includes('stop')) {
      await this.cancelTransaction(context);
      return 'transaction cancelled!';
    }
    
    if (lowerMessage.includes('add') || lowerMessage.includes('include')) {
      return await this.modifyTransaction(context, messageText);
    }
    
    // Transaction inquiry
    return await this.handleTransactionInquiry(context, messageText);
  }

  private async modifyTransaction(context: FlowContext, messageText: string): Promise<string> {
    const { userState } = context;
    
    // Get existing receivers
    let existingReceivers: any[] = [];
    if (userState.managementProgress?.groupCreationData?.receivers) {
      existingReceivers = userState.managementProgress.groupCreationData.receivers;
    } else if (userState.onboardingProgress?.splitData?.receivers) {
      existingReceivers = userState.onboardingProgress.splitData.receivers;
    }

    // Extract new receivers using shared utility
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
          }
        });

        // Send transaction
        if (validateWalletSendCalls(walletSendCalls)) {
          await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
          return `updated your group with ${combinedReceivers.length} receivers. sign to create!`;
        }
      } catch (error) {
        this.logError('Failed to modify transaction', error);
        return 'failed to update transaction. please try again.';
      }
    }
    
    return "couldn't understand who to add. please specify usernames or addresses.";
  }

  private async handleTransactionInquiry(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    
    if (!userState.pendingTransaction) return null;

    // Get transaction details
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
      return `your group has ${receivers.length} fee receivers: ${receiverList}`;
    }

    return 'your group creation transaction is ready to sign.';
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
    if (await this.isAddEveryone(messageText)) {
      await this.addEveryoneFromChat(context);
      return;
    }

    // Use shared utility for group creation
    const result = await GroupCreationUtils.createGroupFromMessage(
      context,
      getDefaultChain(),
      "Create Additional Group"
    );

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
- create_group: User wants to create a new group
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
      const validActions: ManagementAction[] = ['list_groups', 'list_coins', 'add_coin', 'create_group', 'claim_fees', 'check_fees', 'cancel_transaction', 'general_help', 'answer_question'];
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
      case 'create_group':
        await this.createGroup(context);
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
    if (await this.isAddEveryone(messageText)) {
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
    const messageText = this.extractMessageText(context);
    
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `User asked: "${messageText}"

You are a Flaunch bot with these specific capabilities:
- List user's coins and groups
- Launch new coins into existing groups  
- Create new groups for fee splitting
- Show claimable fee balances from trading

Analyze the user's question and respond appropriately:

1. If they're asking about something you CAN do, explain briefly how.

2. If they're asking about a reasonable feature that would improve Flaunch (like setting defaults, preferences, advanced settings, automation, etc.), respond with: "no, but that's a great idea! i'll pass it to the team."

3. If they're asking about something completely unrelated to Flaunch or crypto/token launching, respond with: "i can't help with that, i'm focused on coin launches and groups."

4. If they're asking about something you can't do but it's not a reasonable feature request (like asking you to do impossible things), respond with: "i can't do that."

Keep your response short and conversational. Use lowercase and be helpful.`
        }],
        temperature: 0.1,
        max_tokens: 150
      });

      const answer = response.choices[0]?.message?.content?.trim();
      if (answer) {
        await this.sendResponse(context, answer);
      } else {
        await this.sendResponse(context, "i can help you list coins/groups, launch coins, create groups, and show claimable balances.");
      }
    } catch (error) {
      this.logError('Failed to answer question', error);
      await this.sendResponse(context, "i can help you list coins/groups, launch coins, create groups, and show claimable balances.");
    }
  }

  private async isAddEveryone(messageText: string): Promise<boolean> {
    if (!messageText) return false;
    
    const lowerMessage = messageText.toLowerCase();
    return lowerMessage.includes('everyone') || lowerMessage.includes('all members') || lowerMessage.includes('all');
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
        await this.sendResponse(context, `sign to create group with all ${feeReceivers.length} members!`);
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
    try {
      const receiverNames = await Promise.all(
        group.receivers.map(async (receiver) => {
          try {
            // Try to get display name (ENS or formatted address)
            const displayName = await getDisplayName(receiver.resolvedAddress);
            return displayName || `${receiver.resolvedAddress.slice(0, 6)}...${receiver.resolvedAddress.slice(-4)}`;
          } catch (error) {
            // Fall back to username or formatted address
            if (receiver.username && !receiver.username.startsWith('0x')) {
              return receiver.username;
            }
            return `${receiver.resolvedAddress.slice(0, 6)}...${receiver.resolvedAddress.slice(-4)}`;
          }
        })
      );
      
      return receiverNames.join(', ');
    } catch (error) {
      this.logError('Failed to format group receivers', error);
      return group.receivers.map(r => 
        r.username && !r.username.startsWith('0x') 
          ? r.username 
          : `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`
      ).join(', ');
    }
  }
} 
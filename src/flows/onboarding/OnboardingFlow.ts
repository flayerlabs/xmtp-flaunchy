import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { getDefaultChain } from "../utils/ChainSelection";
import { CoinLaunchFlow } from "../coin-launch/CoinLaunchFlow";

export class OnboardingFlow extends BaseFlow {
  private coinLaunchFlow: CoinLaunchFlow;

  constructor() {
    super('OnboardingFlow');
    this.coinLaunchFlow = new CoinLaunchFlow();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
      const messageText = this.extractMessageText(context);
      
    this.log('Processing onboarding message', {
          userId: userState.userId,
      status: userState.status,
      hasGroups: userState.groups.length > 0,
      messageText: messageText?.substring(0, 100)
    });

    // Handle pending transaction inquiries
    if (userState.pendingTransaction && messageText) {
      const transactionResponse = await this.handlePendingTransactionInquiry(context, messageText);
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
    }

    // If user is new, start onboarding
    if (userState.status === 'new') {
        await this.startOnboarding(context);
        return;
    }

    // If user has no groups, they need to create one first
    if (userState.groups.length === 0) {
      await this.handleGroupCreation(context);
      return;
    }

    // User has groups - they can launch coins
    await this.handleCoinLaunch(context);
  }

  private async startOnboarding(context: FlowContext): Promise<void> {
    // Update user to onboarding status
    await context.updateState({ 
      status: 'onboarding',
      onboardingProgress: {
        step: 'group_creation',
        startedAt: new Date()
      }
    });

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Give a very short welcome message. Tell them to tag who they want in their Group and then launch coins to split trading fees with Group members.
        
        Keep it extremely brief - 1-2 sentences max. Use your character's voice.
      `
    });
    
    await this.sendResponse(context, response);
  }

  private async handleGroupCreation(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);

    // Check if user wants to add everyone from the chat
    const isAddEveryone = await this.detectAddEveryone(context, messageText);
    if (isAddEveryone) {
      await this.addEveryoneFromChat(context);
      return;
    }

    // Check if user is trying to add to existing group creation
    const existingReceivers = context.userState.onboardingProgress?.splitData?.receivers;
    if (existingReceivers && existingReceivers.length > 0 && messageText) {
      const isAddingToExisting = await this.detectAddToExistingGroup(context, messageText);
      if (isAddingToExisting) {
        await this.addToExistingGroup(context, messageText);
      return;
    }
    }

    // Try to create group from message using shared utility
    const result = await GroupCreationUtils.createGroupFromMessage(
      context,
      getDefaultChain(),
      "Create Group"
    );

    if (result) {
      // Update onboarding progress
          await context.updateState({
            onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: {
            receivers: result.resolvedReceivers,
            equalSplit: !result.resolvedReceivers.some(r => r.percentage),
            creatorPercent: 0
          }
        },
        pendingTransaction: {
          type: 'group_creation',
          network: result.chainConfig.name,
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(result.walletSendCalls, ContentTypeWalletSendCalls);

      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Very briefly tell them to sign the transaction to create their group.
          Keep it short - 1 sentence max.
        `
      });

      await this.sendResponse(context, response);
    } else {
      // Ask for fee receivers
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Briefly ask who should receive trading fees. Mention they can:
          - Tag usernames (@alice)
          - Use addresses (0x123...)
          - Say "everyone" for all chat members
          
          Keep it very short.
        `
      });

      await this.sendResponse(context, response);
    }
  }

  private async handleCoinLaunch(context: FlowContext): Promise<void> {
    // Delegate to CoinLaunchFlow for coin creation
    await this.coinLaunchFlow.processMessage(context);
    
    // Complete onboarding if coin was launched successfully
    if (!context.userState.coinLaunchProgress && !context.userState.pendingTransaction) {
      await context.updateState({
        status: 'active',
        onboardingProgress: undefined
      });
    }
  }

  private async detectAddEveryone(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;

    // Simple pattern check for obvious cases
    const lowerMessage = messageText.toLowerCase().trim();
    const obviousPatterns = [
      'everyone', 'everyone!', 'for everyone', 'all', 'all members',
      'include everyone', 'everyone in the chat', 'everyone here'
    ];

    if (obviousPatterns.some(pattern => lowerMessage === pattern || lowerMessage.includes(pattern))) {
      return true;
    }

    // Use LLM for more complex cases
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Does this message request to include all group chat members? "${messageText}" Answer only "yes" or "no".`
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
      // Get all conversation members
      const members = await context.conversation.members();
      const feeReceivers = [];

      for (const member of members) {
        // Skip the bot
        if (member.inboxId !== context.client.inboxId) {
          const memberInboxState = await context.client.preferences.inboxStateFromInboxIds([member.inboxId]);
          if (memberInboxState.length > 0 && memberInboxState[0].identifiers.length > 0) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            feeReceivers.push({
              username: memberAddress,
              resolvedAddress: memberAddress,
              percentage: undefined // Equal split
            });
          }
        }
      }

      if (feeReceivers.length === 0) {
        await this.sendResponse(context, "couldn't find any group members. please specify fee receivers manually.");
      return;
    }

      // Create group with all members
      const defaultChain = getDefaultChain();
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        feeReceivers,
        context.creatorAddress,
        defaultChain,
        "Create Group with All Members"
      );

      // Update state
          await context.updateState({
                  onboardingProgress: {
                    ...context.userState.onboardingProgress!,
          splitData: {
            receivers: feeReceivers,
            equalSplit: true,
                  creatorPercent: 0
          }
        },
        pendingTransaction: {
          type: 'group_creation',
          network: defaultChain.name,
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

            const response = await getCharacterResponse({
              openai: context.openai,
              character: context.character,
              prompt: `
          Very briefly tell them to sign the transaction to create their group with all ${feeReceivers.length} members.
          Keep it short - 1 sentence max.
              `
            });

            await this.sendResponse(context, response);
        
      } catch (error) {
      this.logError('Failed to add everyone from chat', error);
      await this.sendResponse(context, "couldn't add everyone. please specify fee receivers manually.");
    }
  }

  private async detectAddToExistingGroup(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;

    // Simple pattern check for adding to existing
    const lowerMessage = messageText.toLowerCase().trim();
    const addPatterns = [
      'add', 'include', 'also add', 'can you add', 'please add', 'and add'
    ];

    if (addPatterns.some(pattern => lowerMessage.includes(pattern))) {
      return true;
    }

    // Use LLM for more complex cases
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Does this message request to ADD someone to an existing group? "${messageText}" Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to detect add to existing intent', error);
      return false;
    }
  }

  private async addToExistingGroup(context: FlowContext, messageText: string): Promise<void> {
    try {
      // Extract new receivers from the message
      const result = await GroupCreationUtils.createGroupFromMessage(
        context,
        getDefaultChain(),
        "Add to Group"
      );

      if (result && result.resolvedReceivers.length > 0) {
        const existingReceivers = context.userState.onboardingProgress?.splitData?.receivers || [];
        
        // Combine existing and new receivers, avoiding duplicates
        const combinedReceivers = [...existingReceivers];
        
        for (const newReceiver of result.resolvedReceivers) {
          const isDuplicate = existingReceivers.some(existing => 
            existing.resolvedAddress?.toLowerCase() === newReceiver.resolvedAddress?.toLowerCase()
          );
          
          if (!isDuplicate) {
            combinedReceivers.push(newReceiver);
          }
        }

        // Recalculate equal percentages
        const equalPercentage = 100 / combinedReceivers.length;
        const updatedReceivers = combinedReceivers.map(receiver => ({
          ...receiver,
          percentage: equalPercentage
        }));

        // Create new group deployment with combined receivers
        const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          updatedReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Create Group with Added Members"
        );

        // Update state with combined receivers
      await context.updateState({
        onboardingProgress: {
            ...context.userState.onboardingProgress!,
          splitData: {
              receivers: updatedReceivers,
              equalSplit: true,
              creatorPercent: 0
            }
          },
          pendingTransaction: {
            type: 'group_creation',
            network: getDefaultChain().name,
          timestamp: new Date()
        }
      });

        // Send new transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

        const newReceiverNames = result.resolvedReceivers.map(r => r.username).join(', ');
        const response = await getCharacterResponse({
          openai: context.openai,
          character: context.character,
          prompt: `
            Very briefly confirm you added ${newReceiverNames} to the group and tell them to sign the updated transaction.
            Keep it short - 1 sentence max.
          `
        });

        await this.sendResponse(context, response);
      } else {
        await this.sendResponse(context, "couldn't find anyone to add. try again with @username or address.");
      }
        } catch (error) {
      this.logError('Failed to add to existing group', error);
      await this.sendResponse(context, "couldn't add to group. please try again.");
    }
  }

  private async handlePendingTransactionInquiry(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState } = context;
    
    // Check if user is asking about the pending transaction
    const lowerMessage = messageText.toLowerCase();
    const isTransactionInquiry = lowerMessage.includes('address') || 
                                lowerMessage.includes('receiver') || 
                                lowerMessage.includes('group') ||
                                lowerMessage.includes('who') ||
                                lowerMessage.includes('what') ||
                                lowerMessage.includes('which');
    
    if (!isTransactionInquiry) return null;

    // Get transaction details from onboarding progress
    let receivers: any[] = [];
    if (userState.onboardingProgress?.splitData?.receivers) {
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
} 
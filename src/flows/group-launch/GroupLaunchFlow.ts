import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { getDefaultChain } from "../utils/ChainSelection";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { validateWalletSendCalls } from "../utils/WalletSendCallsValidator";

/**
 * GroupLaunchFlow handles group creation for users who already have existing groups.
 * This provides better separation of concerns from the ManagementFlow.
 * 
 * This flow handles group creation directly instead of delegating to ManagementFlow
 * to avoid classification conflicts and provide cleaner group creation logic.
 */
export class GroupLaunchFlow extends BaseFlow {

  constructor() {
    super('GroupLaunchFlow');
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);
    
    this.log('Processing group launch message', { 
      userId: userState.userId,
      messageText: messageText?.substring(0, 100),
      groupCount: userState.groups.length
    });

    // Validate that this user should be in group launch flow (has existing groups)
    if (userState.groups.length === 0) {
      this.log('User has no groups - should be in onboarding instead', {
        userId: userState.userId
      });
      await this.sendResponse(context, "let's get you started with your first group! who should receive trading fees?");
      return;
    }

    // Clear any conflicting pending transactions from other flows
    await this.clearCrossFlowTransactions(context);

    // Handle group creation directly
    await this.handleGroupCreation(context);
  }

  /**
   * Handle group creation logic directly instead of delegating to ManagementFlow
   */
  private async handleGroupCreation(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);

    // Check if user wants to add everyone from the chat
    const isAddEveryone = await this.detectAddEveryone(context, messageText);
    
    if (isAddEveryone) {
      // Check if there are additional receivers mentioned beyond "everyone"
      const additionalReceivers = await this.extractAdditionalReceivers(context, messageText);
      await this.addEveryoneFromChat(context, additionalReceivers);
      return;
    }

    // Try to create group from message using shared utility
    let result;
    try {
      result = await GroupCreationUtils.createGroupFromMessage(
        context,
        getDefaultChain(),
        "Create Group"
      );
    } catch (error) {
      // Use shared error handling for consistency
      const errorMessage = GroupCreationUtils.handleGroupCreationError(error);
      await this.sendResponse(context, errorMessage);
      return;
    }

    if (result) {
      // Set pending transaction for group creation
      await context.updateState({
        pendingTransaction: {
          type: 'group_creation',
          network: result.chainConfig.name,
          timestamp: new Date()
        },
        managementProgress: {
          action: 'creating_group',
          step: 'creating_transaction',
          groupCreationData: {
            receivers: result.resolvedReceivers
          },
          startedAt: new Date()
        }
      });

      // Send transaction
      if (validateWalletSendCalls(result.walletSendCalls)) {
        await context.conversation.send(result.walletSendCalls, ContentTypeWalletSendCalls);
        
        // Use ENS-resolved transaction message
        const message = await GroupCreationUtils.createTransactionMessageWithENS(
          result.resolvedReceivers, 
          'created',
          context.ensResolver
        );
        await this.sendResponse(context, message);
      }
    } else {
      // Ask for fee receivers
      await this.sendResponse(context, "who should receive trading fees? tag usernames or say 'everyone'.");
    }
  }

  /**
   * Detect if user wants to add everyone from the group chat
   * ENHANCED: More comprehensive detection patterns
   */
  private async detectAddEveryone(context: FlowContext, messageText: string): Promise<boolean> {
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
          - "everyone in this chat"
          - "add everyone"
          - "create a group for everyone"
          - "let's create a group for everyone"
          - "group for everyone"
          - "all of us"
          - "all people in this chat"
          
          Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to detect add everyone request', error);
      return false;
    }
  }

  /**
   * Extract additional receivers mentioned beyond "everyone"
   */
  private async extractAdditionalReceivers(context: FlowContext, messageText: string): Promise<string[]> {
    if (!messageText) return [];

    const additionalReceivers = [];
    const words = messageText.split(' ');

    for (const word of words) {
      if (word.startsWith('@')) {
        const username = word.slice(1);
        additionalReceivers.push(username);
      }
    }

    return additionalReceivers;
  }

  /**
   * Add everyone from the current group chat as fee receivers
   * ENHANCED: Better one-shot handling with clear messaging
   */
  private async addEveryoneFromChat(context: FlowContext, additionalReceivers: string[] = []): Promise<void> {
    try {
      this.log('Adding everyone from chat to group', {
        userId: context.userState.userId,
        additionalReceivers: additionalReceivers.length
      });

      // Get conversation members
      const members = await context.conversation.members();
      const feeReceivers = [];

      for (const member of members) {
        if (member.inboxId !== context.client.inboxId) {
          const memberInboxState = await context.client.preferences.inboxStateFromInboxIds([member.inboxId]);
          if (memberInboxState.length > 0 && memberInboxState[0].identifiers.length > 0) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            
            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName = await context.ensResolver.resolveSingleAddress(memberAddress);
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              // If resolution fails, use address as fallback
              this.log(`Could not resolve address ${memberAddress}, using address as username`);
            }
            
            feeReceivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: undefined
            });
          }
        }
      }

      // Add additional receivers if any
      const resolvedAdditionalReceivers = [];
      for (const username of additionalReceivers) {
        try {
          const resolvedAddress = await context.resolveUsername(username);
          if (resolvedAddress) {
            resolvedAdditionalReceivers.push({
              username: username,
              resolvedAddress: resolvedAddress,
              percentage: undefined
            });
          }
        } catch (error) {
          this.log(`Failed to resolve additional receiver: ${username}`, error);
        }
      }

      const allReceivers = [...feeReceivers, ...resolvedAdditionalReceivers];

      if (allReceivers.length === 0) {
        await this.sendResponse(context, "couldn't find group members. specify receivers manually.");
        return;
      }

      this.log('Creating group with all members', {
        userId: context.userState.userId,
        totalReceivers: allReceivers.length,
        chatMembers: feeReceivers.length,
        additionalMembers: resolvedAdditionalReceivers.length
      });

      // Create group
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        allReceivers,
        context.creatorAddress,
        getDefaultChain(),
        "Create Group with All Members"
      );

      // Set pending transaction
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
            receivers: allReceivers
          },
          startedAt: new Date()
        }
      });

      // Send transaction
      if (validateWalletSendCalls(walletSendCalls)) {
        await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
        
        // ENHANCED: Use ENS resolution for confirmation message
        const confirmationMessage = await GroupCreationUtils.createTransactionMessageWithENS(
          allReceivers,
          'creating',
          context.ensResolver
        );
        
        await this.sendResponse(context, confirmationMessage);
      }

    } catch (error) {
      this.logError('Failed to add everyone from chat', error);
      await this.sendResponse(context, "failed to add everyone from chat. please try again or specify individual usernames.");
    }
  }

  /**
   * Clear pending transactions from other flows when starting group creation
   * This prevents conflicts when users switch between different actions
   */
  private async clearCrossFlowTransactions(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    if (userState.pendingTransaction) {
      const pendingTx = userState.pendingTransaction;
      
      this.log('Clearing cross-flow pending transaction', {
        userId: userState.userId,
        transactionType: pendingTx.type,
        reason: 'User explicitly started group creation'
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateState({
        pendingTransaction: undefined,
        // Clear coin launch progress if it exists (user switching from coin launch to group creation)
        coinLaunchProgress: undefined
      });

      // NO USER MESSAGE - clearing should be invisible to the user
      // They just want their group created, not to hear about technical cleanup
    }
  }
} 
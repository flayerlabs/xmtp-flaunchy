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
      await this.addEveryoneFromChat(context);
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
      // Handle specific validation errors with user-friendly messages
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('Total shares') && errorMessage.includes('do not equal required total')) {
        await this.sendResponse(context, "percentages need to add up to 100%. try again with equal splits or percentages that total 100%.");
        return;
      } else if (errorMessage.includes('Couldn\'t resolve these usernames')) {
        await this.sendResponse(context, errorMessage.toLowerCase());
        return;
      } else {
        this.logError('Group creation error', error);
        await this.sendResponse(context, "something went wrong creating the group. please try again or contact support.");
        return;
      }
    }

    if (result) {
      // Set pending transaction for group creation
      await context.updateState({
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
      // Ask for fee receivers
      await this.sendResponse(context, "who should receive trading fees? tag usernames or say 'everyone'.");
    }
  }

  /**
   * Detect if user wants to add everyone from the group chat
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
          - "add everyone"
          
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
   * Add everyone from the current group chat as fee receivers
   */
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

      // Set pending transaction
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
        await this.sendResponse(context, `creating group with ${feeReceivers.length} members from this chat. sign to create!`);
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
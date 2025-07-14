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
import { GroupStorageService } from "../../services/GroupStorageService";
import { safeParseJSON } from "../../core/utils/jsonUtils";

type ManagementAction =
  | "list_groups"
  | "list_coins"
  | "claim_fees"
  | "check_fees"
  | "cancel_transaction"
  | "general_help"
  | "answer_question";

export class ManagementFlow extends BaseFlow {
  private coinLaunchFlow: CoinLaunchFlow;
  private groupStorageService?: GroupStorageService;

  constructor() {
    super("ManagementFlow");
    this.coinLaunchFlow = new CoinLaunchFlow();
  }

  private getGroupStorageService(context: FlowContext): GroupStorageService {
    if (!this.groupStorageService) {
      this.groupStorageService = new GroupStorageService(
        context.sessionManager
      );
    }
    return this.groupStorageService;
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);

    this.log("Processing management message", {
      userId: userState.userId,
      messageText: messageText?.substring(0, 100),
    });

    // Handle invited users with welcome message
    if (userState.status === "invited") {
      await this.handleInvitedUserWelcome(context);
      return;
    }

    // Clear any conflicting pending transactions from other flows (but not our own)
    await this.clearCrossFlowTransactions(context);

    // Handle pending transactions
    if (context.groupState.pendingTransaction && messageText) {
      const transactionResponse = await this.handlePendingTransaction(
        context,
        messageText
      );
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
      // If transactionResponse is null, continue to normal flow as fallback
    }

    // Handle ongoing management progress
    if (context.groupState.managementProgress) {
      await this.handleOngoingProcess(context);
      return;
    }

    // Classify and handle the action
    const action = await this.classifyAction(messageText || "", context);
    await this.handleAction(context, action);
  }

  private async handlePendingTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { groupState } = context;

    if (!groupState.pendingTransaction) {
      return null;
    }

    const pendingTx = groupState.pendingTransaction;

    // Use LLM to determine if the message is about the pending transaction
    const isTransactionRelated = await this.isMessageAboutPendingTransaction(
      context,
      messageText,
      groupState.pendingTransaction?.type || "unknown"
    );

    // If message is not transaction-related, don't handle it here
    if (!isTransactionRelated) {
      return null;
    }

    // Use LLM to classify the transaction-related intent
    const transactionIntent = await this.classifyTransactionIntent(
      context,
      messageText
    );

    switch (transactionIntent) {
      case "cancel":
        console.log(`[Management] 🚫 Cancelling ${pendingTx.type} transaction`);
        await this.cancelTransaction(context);
        return "transaction cancelled.";

      case "modify":
        console.log(`[Management] 🔧 Modifying ${pendingTx.type} transaction`);
        const modifyResult = await this.modifyTransaction(context, messageText);
        return modifyResult;

      case "inquiry":
        return await this.handleTransactionInquiry(context, messageText);

      default:
        return await this.handleTransactionInquiry(context, messageText);
    }
  }

  private async isMessageAboutPendingTransaction(
    context: FlowContext,
    messageText: string,
    transactionType: string
  ): Promise<boolean> {
    const { groupState } = context;
    const pendingTx = groupState.pendingTransaction;

    if (!pendingTx) return false;

    // Build comprehensive transaction context
    let transactionContext = `The user has a pending ${transactionType} transaction with the following details:\n\n`;

    if (pendingTx.type === "coin_creation" && pendingTx.coinData) {
      transactionContext += `Coin Details:\n`;
      transactionContext += `- Name: ${pendingTx.coinData.name}\n`;
      transactionContext += `- Ticker: ${pendingTx.coinData.ticker}\n`;
      transactionContext += `- Image: ${pendingTx.coinData.image}\n\n`;

      if (pendingTx.launchParameters) {
        transactionContext += `Launch Parameters:\n`;
        transactionContext += `- Starting Market Cap: $${
          pendingTx.launchParameters.startingMarketCap || 1000
        }\n`;
        transactionContext += `- Fair Launch Duration: ${
          pendingTx.launchParameters.fairLaunchDuration || 30
        } minutes\n`;
        transactionContext += `- Prebuy Amount: ${
          pendingTx.launchParameters.premineAmount || 0
        }%\n`;
        transactionContext += `- Buyback Percentage: ${
          pendingTx.launchParameters.buybackPercentage || 0
        }%\n`;
        if (pendingTx.launchParameters.targetGroupId) {
          transactionContext += `- Target Group: ${pendingTx.launchParameters.targetGroupId}\n`;
        }
        transactionContext += `\n`;
      }
    } else if (pendingTx.type === "group_creation") {
      // Get group creation details from progress
      let receivers: any[] = [];
      if (groupState.managementProgress?.groupCreationData?.receivers) {
        receivers = groupState.managementProgress.groupCreationData.receivers;
      } else if (groupState.onboardingProgress?.splitData?.receivers) {
        receivers = groupState.onboardingProgress.splitData.receivers;
      }

      if (receivers.length > 0) {
        transactionContext += `Group Creation Details:\n`;
        transactionContext += `- Fee Receivers: ${receivers.length}\n`;
        receivers.forEach((r, i) => {
          const displayName =
            r.username ||
            `${r.resolvedAddress?.slice(0, 6)}...${r.resolvedAddress?.slice(
              -4
            )}`;
          transactionContext += `  ${i + 1}. ${displayName}${
            r.percentage ? ` (${r.percentage}%)` : ""
          }\n`;
        });
        transactionContext += `\n`;
      }
    }

    transactionContext += `Network: ${pendingTx.network}\n`;
    transactionContext += `Created: ${new Date(
      pendingTx.timestamp
    ).toLocaleString()}\n\n`;

    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
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

Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      return (
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes"
      );
    } catch (error) {
      this.logError(
        "Failed to determine if message is about pending transaction",
        error
      );
      // Conservative fallback - assume it's not about the transaction
      return false;
    }
  }

  private async classifyTransactionIntent(
    context: FlowContext,
    messageText: string
  ): Promise<"cancel" | "modify" | "inquiry"> {
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Classify this transaction-related message:

Message: "${messageText}"

Categories:
- cancel: User wants to cancel/stop the transaction
- modify: User wants to add/change/update transaction details
- inquiry: User is asking about transaction status/details

Respond with only: cancel, modify, or inquiry`,
          },
        ],
        temperature: 0.1,
        max_tokens: 10,
      });

      const intent = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();
      if (intent && ["cancel", "modify", "inquiry"].includes(intent)) {
        return intent as "cancel" | "modify" | "inquiry";
      }
    } catch (error) {
      this.logError("Failed to classify transaction intent", error);
    }

    // Default to inquiry
    return "inquiry";
  }

  private async modifyTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { groupState } = context;
    const pendingTx = groupState.pendingTransaction;

    if (!pendingTx) {
      return "no pending transaction to modify.";
    }

    // Handle coin creation transaction modifications
    if (pendingTx.type === "coin_creation") {
      return await this.modifyCoinTransaction(context, messageText);
    }

    // Handle group creation transaction modifications
    if (pendingTx.type === "group_creation") {
      return await this.modifyGroupTransaction(context, messageText);
    }

    return "couldn't determine transaction type to modify.";
  }

  private async modifyCoinTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { groupState, userState } = context;
    const pendingTx = groupState.pendingTransaction!;

    // Use LLM to extract parameter changes from the message
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Extract coin launch parameter changes from this message:

Message: "${messageText}"

Current parameters:
- Starting Market Cap: $${pendingTx.launchParameters?.startingMarketCap || 1000}
- Fair Launch Duration: ${
              pendingTx.launchParameters?.fairLaunchDuration || 30
            } minutes
- Prebuy Amount: ${pendingTx.launchParameters?.premineAmount || 0}%
- Buyback Percentage: ${pendingTx.launchParameters?.buybackPercentage || 0}%

IMPORTANT TERMINOLOGY:
- "prebuy", "premine", "pre-buy", "pre-mine" → refers to premineAmount (tokens bought at launch, costs ETH)
- "buyback", "buy back", "automated buybacks" → refers to buybackPercentage (fee allocation for buybacks)

Return your response in this exact format:

\`\`\`json
{
  "startingMarketCap": number (if mentioned),
  "fairLaunchDuration": number (if mentioned, in minutes),
  "premineAmount": number (if mentioned, as percentage for prebuy/premine),
  "buybackPercentage": number (if mentioned, as percentage for buybacks)
}
\`\`\`

If no parameters are mentioned, return:

\`\`\`json
{}
\`\`\``,
          },
        ],
        temperature: 0.1,
        max_tokens: 100,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        return "couldn't understand what parameters to change.";
      }

      let parameterChanges;
      try {
        parameterChanges = safeParseJSON(content);
      } catch (error) {
        return "couldn't understand what parameters to change.";
      }

      if (Object.keys(parameterChanges).length === 0) {
        return "couldn't understand what parameters to change.";
      }

      // Validate parameter ranges
      if (parameterChanges.startingMarketCap !== undefined) {
        if (
          parameterChanges.startingMarketCap < 100 ||
          parameterChanges.startingMarketCap > 10000
        ) {
          return "starting market cap must be between $100 and $10,000.";
        }
      }

      if (parameterChanges.fairLaunchDuration !== undefined) {
        if (
          parameterChanges.fairLaunchDuration < 1 ||
          parameterChanges.fairLaunchDuration > 1440
        ) {
          return "fair launch duration must be between 1 minute and 24 hours (1440 minutes).";
        }
      }

      if (parameterChanges.premineAmount !== undefined) {
        if (
          parameterChanges.premineAmount < 0 ||
          parameterChanges.premineAmount > 50
        ) {
          return "prebuy amount must be between 0% and 50%.";
        }
      }

      if (parameterChanges.buybackPercentage !== undefined) {
        if (
          parameterChanges.buybackPercentage < 0 ||
          parameterChanges.buybackPercentage > 100
        ) {
          return "buyback percentage must be between 0% and 100%.";
        }
      }

      // Update the pending transaction with new parameters
      const updatedLaunchParameters = {
        ...pendingTx.launchParameters,
        ...parameterChanges,
      };

      // Find the target group
      const targetGroupId =
        updatedLaunchParameters.targetGroupId ||
        pendingTx.launchParameters?.targetGroupId;
      const targetGroup = userState.groups.find(
        (g: any) => g.id === targetGroupId
      );

      if (!targetGroup) {
        return "couldn't find the target group for your coin launch.";
      }

      // Rebuild the transaction with updated parameters
      const coinData = pendingTx.coinData!;

      // Import the CoinLaunchFlow to use its rebuild method
      if (this.coinLaunchFlow) {
        await this.coinLaunchFlow.rebuildAndSendTransaction(
          context,
          {
            name: coinData.name,
            ticker: coinData.ticker,
            image: coinData.image,
            targetGroup: targetGroup.id,
            startingMarketCap:
              updatedLaunchParameters.startingMarketCap || 1000,
            fairLaunchDuration:
              updatedLaunchParameters.fairLaunchDuration || 30,
            premineAmount: updatedLaunchParameters.premineAmount || 0,
            buybackPercentage: updatedLaunchParameters.buybackPercentage || 0,
          } as any,
          targetGroup.id
        );

        // CoinLaunchFlow already sends a response, so we don't need to send another one
        return null; // Return null to indicate no additional response needed
      }

      return "couldn't update transaction parameters.";
    } catch (error) {
      this.logError("Failed to modify coin transaction", error);
      return "failed to update transaction parameters.";
    }
  }

  private async modifyGroupTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { groupState } = context;

    // Get existing receivers
    let existingReceivers: any[] = [];
    if (groupState.managementProgress?.groupCreationData?.receivers) {
      existingReceivers =
        groupState.managementProgress.groupCreationData.receivers;
    } else if (groupState.onboardingProgress?.splitData?.receivers) {
      existingReceivers = groupState.onboardingProgress.splitData.receivers;
    }

    // Check if this is a removal request
    const isRemovalRequest = await this.detectRemovalRequest(
      context,
      messageText
    );

    if (isRemovalRequest) {
      return await this.handleReceiverRemoval(
        context,
        messageText,
        existingReceivers
      );
    }

    // Check if user wants to add everyone from chat
    const isAddEveryone = await this.isAddEveryone(context, messageText);

    if (isAddEveryone) {
      // Add all chat members
      const chatMembers = await context.conversation.members();
      const everyoneReceivers = [];

      for (const member of chatMembers) {
        if (member.inboxId !== context.client.inboxId) {
          const memberInboxState =
            await context.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await context.ensResolver.resolveSingleAddress(memberAddress);
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              // If resolution fails, use address as fallback
              this.log(
                `Could not resolve address ${memberAddress}, using address as username`
              );
            }

            everyoneReceivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: undefined,
            });
          }
        }
      }

      // Combine with existing receivers (avoid duplicates)
      const combinedReceivers = [...existingReceivers];
      for (const newReceiver of everyoneReceivers) {
        const exists = combinedReceivers.some(
          (existing) =>
            existing.resolvedAddress?.toLowerCase() ===
            newReceiver.resolvedAddress?.toLowerCase()
        );
        if (!exists && newReceiver.resolvedAddress) {
          combinedReceivers.push(newReceiver);
        }
      }

      // Equal split among all receivers
      const equalPercentage = 100 / combinedReceivers.length;
      const updatedReceivers = combinedReceivers.map((receiver) => ({
        ...receiver,
        percentage: equalPercentage,
      }));

      // Create new transaction with everyone + existing
      try {
        const walletSendCalls =
          await GroupCreationUtils.createGroupDeploymentCalls(
            updatedReceivers,
            context.creatorAddress,
            getDefaultChain(),
            "Create Group"
          );

        // Update state
        await context.updateGroupState({
          pendingTransaction: {
            type: "group_creation",
            network: getDefaultChain().name,
            timestamp: new Date(),
          },
          managementProgress: {
            action: "creating_group",
            step: "creating_transaction",
            groupCreationData: {
              receivers: updatedReceivers,
            },
            startedAt: new Date(),
          },
        });

        // Send transaction
        if (validateWalletSendCalls(walletSendCalls)) {
          await context.conversation.send(
            walletSendCalls,
            ContentTypeWalletSendCalls
          );

          // Create display names with ENS resolution
          const message =
            await GroupCreationUtils.createTransactionMessageWithENS(
              updatedReceivers,
              "updated",
              context.ensResolver
            );

          return message;
        }
      } catch (error) {
        this.logError(
          "Failed to modify group transaction with everyone",
          error
        );
        return "failed to update transaction. please try again.";
      }
    }

    // Extract new receivers using shared utility (for specific usernames)
    const extraction = await GroupCreationUtils.extractFeeReceivers(context);

    if (extraction && extraction.receivers.length > 0) {
      // Resolve new receivers
      const newReceivers = await GroupCreationUtils.resolveUsernames(
        context,
        extraction.receivers
      );

      // Check for resolution failures
      const failed = newReceivers.filter((r) => !r.resolvedAddress);
      if (failed.length > 0) {
        return `couldn't resolve these usernames: ${failed
          .map((r) => r.username)
          .join(", ")}`;
      }

      // Combine with existing (avoid duplicates)
      const combinedReceivers = [...existingReceivers];

      // Check if any new receiver has a specified percentage
      const newReceiversWithPercentage = newReceivers.filter(
        (r) => r.percentage !== undefined
      );
      const newReceiversWithoutPercentage = newReceivers.filter(
        (r) => r.percentage === undefined
      );

      // Add new receivers, avoiding duplicates
      for (const newReceiver of newReceivers) {
        const exists = combinedReceivers.some(
          (existing) =>
            existing.resolvedAddress?.toLowerCase() ===
            newReceiver.resolvedAddress?.toLowerCase()
        );
        if (!exists && newReceiver.resolvedAddress) {
          combinedReceivers.push(newReceiver);
        }
      }

      let updatedReceivers;

      if (newReceiversWithPercentage.length > 0) {
        // Handle percentage-based addition
        const totalSpecifiedPercentage = newReceiversWithPercentage.reduce(
          (sum, r) => sum + (r.percentage || 0),
          0
        );

        if (totalSpecifiedPercentage >= 100) {
          return "specified percentage is too high. please use a lower percentage to leave room for existing members.";
        }

        // Calculate remaining percentage for existing and new non-percentage receivers
        const remainingPercentage = 100 - totalSpecifiedPercentage;
        const receiversForEqualSplit =
          existingReceivers.length + newReceiversWithoutPercentage.length;
        const equalPercentage =
          receiversForEqualSplit > 0
            ? remainingPercentage / receiversForEqualSplit
            : 0;

        updatedReceivers = combinedReceivers.map((receiver) => {
          // If this is a new receiver with specified percentage, use it
          const newReceiverWithPercentage = newReceiversWithPercentage.find(
            (nr) =>
              nr.resolvedAddress?.toLowerCase() ===
              receiver.resolvedAddress?.toLowerCase()
          );
          if (newReceiverWithPercentage) {
            return {
              ...receiver,
              percentage: newReceiverWithPercentage.percentage,
            };
          }

          // Otherwise, assign equal share of remaining percentage
          return {
            ...receiver,
            percentage: equalPercentage,
          };
        });
      } else {
        // No percentage specified for new receivers
        // Check if existing receivers have percentages
        const existingReceiversWithPercentage = existingReceivers.filter(
          (r) => r.percentage !== undefined
        );

        if (existingReceiversWithPercentage.length > 0) {
          // Existing receivers have percentages - new receivers should split the remaining
          const existingTotalPercentage =
            existingReceiversWithPercentage.reduce(
              (sum, r) => sum + (r.percentage || 0),
              0
            );
          const remainingPercentage = 100 - existingTotalPercentage;

          if (remainingPercentage <= 0) {
            return "existing receivers already use 100% of fees. please adjust percentages or replace some receivers.";
          }

          // New receivers split the remaining percentage equally
          const newReceiversCount = newReceiversWithoutPercentage.length;
          const percentagePerNewReceiver =
            newReceiversCount > 0 ? remainingPercentage / newReceiversCount : 0;

          updatedReceivers = combinedReceivers.map((receiver) => {
            // If this is an existing receiver with percentage, keep it
            const existingWithPercentage = existingReceiversWithPercentage.find(
              (er) =>
                er.resolvedAddress?.toLowerCase() ===
                receiver.resolvedAddress?.toLowerCase()
            );
            if (existingWithPercentage) {
              return {
                ...receiver,
                percentage: existingWithPercentage.percentage,
              };
            }

            // If this is a new receiver, give it share of remaining percentage
            const isNewReceiver = newReceiversWithoutPercentage.some(
              (nr) =>
                nr.resolvedAddress?.toLowerCase() ===
                receiver.resolvedAddress?.toLowerCase()
            );
            if (isNewReceiver) {
              return {
                ...receiver,
                percentage: percentagePerNewReceiver,
              };
            }

            // For existing receivers without percentage, give them equal share of remaining
            return {
              ...receiver,
              percentage: percentagePerNewReceiver,
            };
          });
        } else {
          // No existing percentages - do equal split among all receivers
          const equalPercentage = 100 / combinedReceivers.length;
          updatedReceivers = combinedReceivers.map((receiver) => ({
            ...receiver,
            percentage: equalPercentage,
          }));
        }
      }

      // Create new transaction
      try {
        const walletSendCalls =
          await GroupCreationUtils.createGroupDeploymentCalls(
            updatedReceivers,
            context.creatorAddress,
            getDefaultChain(),
            "Create Group"
          );

        // Update state
        await context.updateGroupState({
          pendingTransaction: {
            type: "group_creation",
            network: getDefaultChain().name,
            timestamp: new Date(),
          },
          managementProgress: {
            action: "creating_group",
            step: "creating_transaction",
            groupCreationData: {
              receivers: updatedReceivers,
            },
            startedAt: new Date(),
          },
        });

        // Send transaction
        if (validateWalletSendCalls(walletSendCalls)) {
          await context.conversation.send(
            walletSendCalls,
            ContentTypeWalletSendCalls
          );

          // Create display names with ENS resolution
          const message =
            await GroupCreationUtils.createTransactionMessageWithENS(
              updatedReceivers,
              "updated",
              context.ensResolver
            );

          return message;
        }
      } catch (error) {
        this.logError("Failed to modify group transaction", error);
        return "failed to update transaction. please try again.";
      }
    }

    return "couldn't understand who to add. please specify usernames or addresses.";
  }

  /**
   * Detect if the user wants to remove someone from the fee receivers
   */
  private async detectRemovalRequest(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Does this message request to REMOVE someone from a group or fee receiver list? "${messageText}"
          
          Look for requests like:
          - "remove @username"
          - "remove nobi"
          - "take out @alice"
          - "exclude @bob"
          - "drop @charlie"
          - "remove user from group"
          - "take @dave out"
          - "get rid of @eve"
          - "remove them"
          - "kick @user"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      return (
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes"
      );
    } catch (error) {
      this.logError("Failed to detect removal request", error);
      return false;
    }
  }

  /**
   * Handle removal of specific receivers from the fee receiver list
   */
  private async handleReceiverRemoval(
    context: FlowContext,
    messageText: string,
    existingReceivers: any[]
  ): Promise<string | null> {
    if (existingReceivers.length === 0) {
      return "no receivers to remove. please create a group first.";
    }

    // Extract usernames/addresses to remove using a simple extraction approach
    const usersToRemove = await this.extractUsersToRemove(context, messageText);

    if (usersToRemove.length === 0) {
      return "couldn't understand who to remove. please specify usernames like '@alice' or 'nobi'.";
    }

    // Resolve usernames to addresses for matching
    const resolvedUsersToRemove = await this.resolveUsersToRemove(
      context,
      usersToRemove
    );

    if (resolvedUsersToRemove.length === 0) {
      return `couldn't resolve these usernames: ${usersToRemove.join(", ")}`;
    }

    // Filter out the users to remove
    const updatedReceivers = existingReceivers.filter((receiver) => {
      const shouldRemove = resolvedUsersToRemove.some((userToRemove) => {
        // Match by resolved address
        if (receiver.resolvedAddress && userToRemove.resolvedAddress) {
          return (
            receiver.resolvedAddress.toLowerCase() ===
            userToRemove.resolvedAddress.toLowerCase()
          );
        }

        // Match by username (case-insensitive)
        if (receiver.username && userToRemove.username) {
          return (
            receiver.username.toLowerCase() ===
            userToRemove.username.toLowerCase()
          );
        }

        return false;
      });

      return !shouldRemove;
    });

    // Check if any users were actually removed
    if (updatedReceivers.length === existingReceivers.length) {
      const userList = resolvedUsersToRemove.map((u) => u.username).join(", ");
      return `couldn't find ${userList} in the current receiver list.`;
    }

    // Check if all users would be removed
    if (updatedReceivers.length === 0) {
      return "cannot remove all receivers. at least one fee receiver is required.";
    }

    // Redistribute percentages equally among remaining receivers
    const equalPercentage = 100 / updatedReceivers.length;
    const finalReceivers = updatedReceivers.map((receiver) => ({
      ...receiver,
      percentage: equalPercentage,
    }));

    // Create new transaction with updated receivers
    try {
      const walletSendCalls =
        await GroupCreationUtils.createGroupDeploymentCalls(
          finalReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Remove Group Members"
        );

      // Update state
      await context.updateGroupState({
        pendingTransaction: {
          type: "group_creation",
          network: getDefaultChain().name,
          timestamp: new Date(),
        },
        managementProgress: {
          action: "creating_group",
          step: "creating_transaction",
          groupCreationData: {
            receivers: finalReceivers,
          },
          startedAt: new Date(),
        },
      });

      // Send transaction
      if (validateWalletSendCalls(walletSendCalls)) {
        await context.conversation.send(
          walletSendCalls,
          ContentTypeWalletSendCalls
        );

        // Create display names with ENS resolution
        const removedUsernames = resolvedUsersToRemove
          .map((u) => u.username)
          .join(", ");
        const message =
          await GroupCreationUtils.createTransactionMessageWithENS(
            finalReceivers,
            `removed ${removedUsernames} from`,
            context.ensResolver
          );

        return message;
      }
    } catch (error) {
      this.logError("Failed to create transaction after removal", error);
      return "failed to update transaction. please try again.";
    }

    return null;
  }

  /**
   * Extract users to remove from the message
   */
  private async extractUsersToRemove(
    context: FlowContext,
    messageText: string
  ): Promise<string[]> {
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Extract usernames or identifiers to remove from this message: "${messageText}"
          
          Look for:
          - @username patterns like "@alice", "@bob"
          - ENS names like "alice.eth", "bob.eth"
          - Simple usernames like "alice", "bob", "nobi"
          - Ethereum addresses like "0x123..."
          
          Return ONLY a JSON array of the identifiers to remove:
          ["@alice", "bob", "charlie.eth"]
          
          If no identifiers found, return: []`,
          },
        ],
        temperature: 0.1,
        max_tokens: 100,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return [];

      try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        this.logError("Failed to parse removal extraction result", error);
        return [];
      }
    } catch (error) {
      this.logError("Failed to extract users to remove", error);
      return [];
    }
  }

  /**
   * Resolve usernames to addresses for removal matching
   */
  private async resolveUsersToRemove(
    context: FlowContext,
    usersToRemove: string[]
  ): Promise<Array<{ username: string; resolvedAddress?: string }>> {
    const resolved = [];

    for (const user of usersToRemove) {
      let resolvedAddress: string | undefined;

      // Clean up the username
      const cleanUsername = user.startsWith("@") ? user.slice(1) : user;

      // Try to resolve to address
      try {
        if (cleanUsername.startsWith("0x") && cleanUsername.length === 42) {
          // Already an address
          resolvedAddress = cleanUsername;
        } else {
          // Try to resolve username
          resolvedAddress = await context.resolveUsername(cleanUsername);
        }
      } catch (error) {
        this.log(`Failed to resolve username for removal: ${cleanUsername}`);
      }

      resolved.push({
        username: user,
        resolvedAddress,
      });
    }

    return resolved.filter((r) => r.resolvedAddress || r.username);
  }

  private async handleTransactionInquiry(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { userState, groupState } = context;

    if (!groupState.pendingTransaction) return null;

    const pendingTx = groupState.pendingTransaction;

    // Use LLM to generate a comprehensive response about the transaction
    let transactionDetails = "";

    if (pendingTx.type === "coin_creation" && pendingTx.coinData) {
      transactionDetails += `Your ${pendingTx.coinData.name} ($${pendingTx.coinData.ticker}) launch transaction:\n\n`;

      if (pendingTx.launchParameters) {
        transactionDetails += `Launch Parameters:\n`;
        transactionDetails += `• Starting Market Cap: $${
          pendingTx.launchParameters.startingMarketCap || 1000
        }\n`;
        transactionDetails += `• Fair Launch Duration: ${
          pendingTx.launchParameters.fairLaunchDuration || 30
        } minutes\n`;

        // Calculate fair launch supply (40% of total supply by default)
        const fairLaunchPercent = 10; // This is the default from the system
        const totalSupply = 100; // 100 tokens total supply
        const fairLaunchSupply = (totalSupply * fairLaunchPercent) / 100;
        transactionDetails += `• Fair Launch Supply: ${fairLaunchSupply} ${pendingTx.coinData.ticker} (${fairLaunchPercent}% of total)\n`;

        if (
          pendingTx.launchParameters.premineAmount &&
          pendingTx.launchParameters.premineAmount > 0
        ) {
          transactionDetails += `• Prebuy: ${pendingTx.launchParameters.premineAmount}%\n`;
        }
        if (
          pendingTx.launchParameters.buybackPercentage &&
          pendingTx.launchParameters.buybackPercentage > 0
        ) {
          transactionDetails += `• Buybacks: ${pendingTx.launchParameters.buybackPercentage}%\n`;
        }
        if (pendingTx.launchParameters.targetGroupId) {
          // Find the group name
          const targetGroup = userState.groups.find(
            (g) => g.id === pendingTx.launchParameters?.targetGroupId
          );
          const groupDisplay = targetGroup
            ? `${pendingTx.launchParameters.targetGroupId.slice(
                0,
                6
              )}...${pendingTx.launchParameters.targetGroupId.slice(-4)}`
            : pendingTx.launchParameters.targetGroupId;
          transactionDetails += `• Target Group: ${groupDisplay}\n`;
        }
      }

      transactionDetails += `\nready to sign and launch!`;
    } else if (pendingTx.type === "group_creation") {
      // Get group creation details
      let receivers: any[] = [];
      if (groupState.managementProgress?.groupCreationData?.receivers) {
        receivers = groupState.managementProgress.groupCreationData.receivers;
      } else if (groupState.onboardingProgress?.splitData?.receivers) {
        receivers = groupState.onboardingProgress.splitData.receivers;
      }

      if (receivers.length > 0) {
        const receiverList = receivers
          .map((r: any) => {
            const displayName =
              r.username &&
              r.username.startsWith("0x") &&
              r.username.length === 42
                ? `${r.username.slice(0, 6)}...${r.username.slice(-4)}`
                : r.username ||
                  `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(
                    -4
                  )}`;
            return `${displayName}${r.percentage ? ` (${r.percentage}%)` : ""}`;
          })
          .join(", ");
        transactionDetails = `your group creation transaction with ${receivers.length} fee receivers: ${receiverList}\n\nready to sign and create!`;
      } else {
        transactionDetails =
          "your group creation transaction is ready to sign.";
      }
    }

    return transactionDetails || "transaction ready to sign.";
  }

  // Use centralized cancellation from BaseFlow
  // private async cancelTransaction method is now inherited from BaseFlow

  private async handleOngoingProcess(context: FlowContext): Promise<void> {
    // Management progress is now simplified - no group creation
    // Any ongoing processes should be cleared since groups are auto-created
    await context.updateGroupState({
      managementProgress: undefined,
    });

    await this.sendResponse(
      context,
      "what would you like to do? you can check your groups, coins, or fees."
    );
  }

  private async classifyAction(
    messageText: string,
    context: FlowContext
  ): Promise<ManagementAction> {
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Classify this message into one of these actions: "${messageText}"

          Actions:
          - list_groups: Show user's groups, group info, "my groups", "show groups"
          - list_coins: Show user's coins, coin info, "my coins", "show coins"  
          - claim_fees: Claim/withdraw fees, "claim fees", "withdraw"
          - check_fees: Check fee balances, "how much fees", "check balance"
          - cancel_transaction: Cancel pending transaction, "cancel", "stop transaction"
          - general_help: General help requests, "help", "what can you do"
          - answer_question: Answer questions about the system, explain features

          Answer with just the action name.`,
          },
        ],
        temperature: 0.1,
        max_tokens: 20,
      });

      const action =
        response.choices[0]?.message?.content?.trim() as ManagementAction;
      return action || "answer_question";
    } catch (error) {
      this.logError("Failed to classify action", error);
      return "answer_question";
    }
  }

  private async handleAction(
    context: FlowContext,
    action: ManagementAction
  ): Promise<void> {
    switch (action) {
      case "list_groups":
        await this.listGroups(context);
        break;
      case "list_coins":
        await this.listCoins(context);
        break;
      case "claim_fees":
        await this.claimFees(context);
        break;
      case "check_fees":
        await this.checkFees(context);
        break;
      case "cancel_transaction":
        await this.cancelTransaction(context);
        await this.sendResponse(context, "transaction cancelled!");
        break;
      case "general_help":
        await this.generalHelp(context);
        break;
      case "answer_question":
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
    const currentNetworkGroups = userState.groups.filter(
      (group) => group.chainName === currentChain.name
    );

    if (currentNetworkGroups.length === 0) {
      await this.sendResponse(
        context,
        `no group for this chat group on ${currentChain.displayName} yet. launch a coin and I'll automatically create a group for everyone in this chat!`
      );
      return;
    }

    try {
      // Format the response using standardized display
      let message = `this chat group's group${
        currentNetworkGroups.length > 1 ? "s" : ""
      } on ${currentChain.displayName}:\n\n`;

      for (const group of currentNetworkGroups) {
        const balance = await this.getGroupBalance(
          group,
          context.creatorAddress
        );
        const groupDisplay = await GroupCreationUtils.formatGroupDisplayWithENS(
          group,
          userState,
          context.ensResolver,
          {
            showClaimable: true,
            claimableAmount: balance,
            includeEmoji: false, // Use bullet points for list format
          }
        );
        message += groupDisplay + "\n";
      }

      await this.sendResponse(context, message);
      await this.sendMiniAppUrl(context);
    } catch (error) {
      this.logError("Failed to get group details", error);
      await this.sendResponse(
        context,
        `this chat group has ${currentNetworkGroups.length} group${
          currentNetworkGroups.length > 1 ? "s" : ""
        } on ${currentChain.displayName}.`
      );
      await this.sendMiniAppUrl(context);
    }
  }

  private async listCoins(context: FlowContext): Promise<void> {
    const currentChain = getDefaultChain();

    console.log(
      `[ManagementFlow] 🪙 Listing coins for user ${context.userState.userId}`
    );
    console.log(`[ManagementFlow] Current chain: ${currentChain.displayName}`);
    console.log(
      `[ManagementFlow] Cached coins: ${context.userState.coins.length}`
    );
    console.log(
      `[ManagementFlow] Cached groups: ${context.userState.groups.length}`
    );

    try {
      // Fetch live data from blockchain
      console.log(`[ManagementFlow] 📡 Fetching live data from blockchain...`);
      const userStateWithLiveData =
        await context.sessionManager.getUserStateWithLiveData(
          context.userState.userId
        );

      console.log(
        `[ManagementFlow] ✅ Got live data - coins: ${userStateWithLiveData.coins.length}, groups: ${userStateWithLiveData.groups.length}`
      );

      // Only show coins on current network
      const currentNetworkCoins = userStateWithLiveData.coins.filter(
        (coin) => coin.launched && coin.chainName === currentChain.name
      );
      const currentNetworkGroups = userStateWithLiveData.groups.filter(
        (group) => group.chainName === currentChain.name
      );

      console.log(
        `[ManagementFlow] Filtered coins for ${currentChain.displayName}: ${currentNetworkCoins.length}`
      );
      console.log(
        `[ManagementFlow] Filtered groups for ${currentChain.displayName}: ${currentNetworkGroups.length}`
      );

      if (currentNetworkCoins.length === 0) {
        if (currentNetworkGroups.length === 0) {
          console.log(`[ManagementFlow] No coins or groups found`);
          await this.sendResponse(
            context,
            `no coins launched in this chat group on ${currentChain.displayName} yet. launch a coin and I'll automatically create a group for everyone!`
          );
        } else {
          console.log(`[ManagementFlow] No coins found but groups exist`);
          await this.sendResponse(
            context,
            `no coins launched in this chat group on ${currentChain.displayName} yet. launch one and it'll use the chat group's group!`
          );
        }
        return;
      }

      // Log coin details for debugging
      console.log(
        `[ManagementFlow] Found coins:`,
        currentNetworkCoins.map((coin) => ({
          name: coin.name,
          ticker: coin.ticker,
          contractAddress: coin.contractAddress,
          groupId: coin.groupId,
          hasLiveData: !!coin.liveData,
        }))
      );

      // Check fee balances for current network groups
      const totalFees = await this.checkFeeBalances(
        currentNetworkGroups,
        context.creatorAddress
      );

      // Build detailed message with coin information
      let message = `you have ${currentNetworkCoins.length} coin${
        currentNetworkCoins.length > 1 ? "s" : ""
      } on ${currentChain.displayName}:\n\n`;

      // Add coin details
      for (const coin of currentNetworkCoins) {
        message += `🪙 ${coin.name} (${coin.ticker})\n`;

        if (coin.liveData) {
          message += `  • holders: ${coin.liveData.totalHolders}\n`;
          message += `  • market cap: $${parseFloat(
            coin.liveData.marketCapUSDC
          ).toLocaleString()}\n`;
          if (
            coin.liveData.priceChangePercentage &&
            parseFloat(coin.liveData.priceChangePercentage) !== 0
          ) {
            const priceChangeNum = parseFloat(
              coin.liveData.priceChangePercentage
            );
            const change = priceChangeNum > 0 ? "+" : "";
            message += `  • 24h change: ${change}${priceChangeNum.toFixed(
              2
            )}%\n`;
          }
        }

        if (coin.contractAddress) {
          message += `  • contract: ${coin.contractAddress.slice(
            0,
            8
          )}...${coin.contractAddress.slice(-6)}\n`;
        }

        message += `\n`;
      }

      if (totalFees > 0) {
        message += `\n💰 claimable fees: ${totalFees.toFixed(6)} ETH`;
      }

      await this.sendResponse(context, message);
      await this.sendMiniAppUrl(context);
    } catch (error) {
      this.logError("Failed to list coins", error);
      console.error(`[ManagementFlow] ❌ Error listing coins:`, error);

      // Fallback to cached state if live data fails
      const currentNetworkCoins = context.userState.coins.filter(
        (coin) => coin.launched && coin.chainName === currentChain.name
      );

      await this.sendResponse(
        context,
        `having trouble fetching live data. from cached state: you have ${
          currentNetworkCoins.length
        } coin${currentNetworkCoins.length > 1 ? "s" : ""} on ${
          currentChain.displayName
        }. try again in a moment.`
      );
      await this.sendMiniAppUrl(context);
    }
  }

  private async createGroup(context: FlowContext): Promise<void> {
    // Groups are no longer created manually - they're created automatically when launching coins
    await this.sendResponse(
      context,
      "groups are created automatically when you launch coins! each chat group has one group shared by everyone. just launch a coin and I'll handle the group creation behind the scenes."
    );
  }

  private async addCoin(context: FlowContext): Promise<void> {
    // Delegate to CoinLaunchFlow
    await this.coinLaunchFlow.processMessage(context);
  }

  private async claimFees(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "claim fees at:");
    await this.sendMiniAppUrl(context);
  }

  private async checkFees(context: FlowContext): Promise<void> {
    const { userState } = context;
    const currentChain = getDefaultChain();

    // Only check groups on current network
    const currentNetworkGroups = userState.groups.filter(
      (group) => group.chainName === currentChain.name
    );

    if (currentNetworkGroups.length === 0) {
      await this.sendResponse(
        context,
        `no group for this chat group on ${currentChain.displayName} to check fees for.`
      );
      return;
    }

    try {
      const totalBalance = await this.checkFeeBalances(
        currentNetworkGroups,
        context.creatorAddress
      );

      if (totalBalance > 0) {
        await this.sendResponse(
          context,
          `you have ${totalBalance.toFixed(6)} ETH in claimable fees across ${
            currentNetworkGroups.length
          } group${currentNetworkGroups.length > 1 ? "s" : ""} on ${
            currentChain.displayName
          }.`
        );
      } else {
        await this.sendResponse(
          context,
          `no claimable fees available on ${currentChain.displayName}.`
        );
      }
    } catch (error) {
      this.logError("Failed to check fees", error);
      await this.sendResponse(
        context,
        "couldn't check fee balances. please try again."
      );
    }
  }

  private async generalHelp(context: FlowContext): Promise<void> {
    await this.sendResponse(
      context,
      "i can help you:\n- list coins and groups\n- launch coins (groups created automatically)\n- show claimable balances"
    );
  }

  private async answerQuestion(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);

    // Check if this is a question about pending transactions
    const isTransactionStatusQuestion = await this.isTransactionStatusQuestion(
      context,
      messageText
    );

    if (isTransactionStatusQuestion) {
      if (context.groupState.pendingTransaction) {
        // User has a pending transaction, provide details
        const transactionDetails = await this.handleTransactionInquiry(
          context,
          messageText
        );
        if (transactionDetails) {
          await this.sendResponse(context, transactionDetails);
          return;
        }
      } else {
        // User has no pending transaction
        await this.sendResponse(
          context,
          "no pending transactions. you're all set!"
        );
        return;
      }
    }

    // For other questions, try to answer with character knowledge
    try {
      // For now, just provide a simple fallback since we don't have character context here
      await this.sendResponse(
        context,
        "i can help you list coins/groups, launch coins, create groups, and show claimable balances."
      );
    } catch (error) {
      this.logError("Failed to get character response", error);
      await this.sendResponse(
        context,
        "i can't help with that, i'm focused on coin launches and groups."
      );
    }
  }

  private async isTransactionStatusQuestion(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Is this message asking about transaction status or pending transactions?

Message: "${messageText}"

Look for questions like:
- "do I have a pending transaction?"
- "do I have an existing transaction?"
- "what's my transaction status?"
- "is there a transaction waiting?"
- "any pending transactions?"
- "transaction status?"

Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      return (
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes"
      );
    } catch (error) {
      this.logError(
        "Failed to determine if message is transaction status question",
        error
      );
      return false;
    }
  }

  private async isAddEveryone(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Does this message request to include all group chat members? "${messageText}"
          
          Look for requests like:
          - "everyone"
          - "for everyone"
          - "all members"
          - "include everyone"
          - "everyone in the chat"
          - "add everyone"
          - "all"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      return (
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes"
      );
    } catch (error) {
      this.logError("Failed to detect add everyone intent", error);
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
          const memberInboxState =
            await context.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await context.ensResolver.resolveSingleAddress(memberAddress);
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              // If resolution fails, use address as fallback
              this.log(
                `Could not resolve address ${memberAddress}, using address as username`
              );
            }

            feeReceivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: undefined,
            });
          }
        }
      }

      if (feeReceivers.length === 0) {
        await this.sendResponse(
          context,
          "couldn't find group members. specify receivers manually."
        );
        return;
      }

      // Create group
      const walletSendCalls =
        await GroupCreationUtils.createGroupDeploymentCalls(
          feeReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Create Group with All Members"
        );

      // Update state
      await context.updateGroupState({
        managementProgress: undefined,
        pendingTransaction: {
          type: "group_creation",
          network: getDefaultChain().name,
          timestamp: new Date(),
        },
      });

      // Send transaction
      if (validateWalletSendCalls(walletSendCalls)) {
        await context.conversation.send(
          walletSendCalls,
          ContentTypeWalletSendCalls
        );

        // No confirmation message - just create the transaction silently
        return;
      }
    } catch (error) {
      this.logError("Failed to add everyone", error);
      await this.sendResponse(
        context,
        "couldn't add everyone. specify receivers manually."
      );
    }
  }

  private async checkFeeBalances(
    userGroups: UserGroup[],
    userAddress: string
  ): Promise<number> {
    if (userGroups.length > 20) return 0; // Skip for performance

    const currentChain = getDefaultChain();
    let totalBalance = 0;

    try {
      // Only check groups on the current network
      const currentNetworkGroups = userGroups.filter(
        (group) => group.chainName === currentChain.name
      );

      if (currentNetworkGroups.length === 0) return 0;

      const publicClient = createPublicClient({
        chain: currentChain.viemChain,
        transport: http(),
      });

      for (const group of currentNetworkGroups) {
        try {
          const balance = await publicClient.readContract({
            address: group.id as `0x${string}`,
            abi: AddressFeeSplitManagerAbi,
            functionName: "balances",
            args: [userAddress as `0x${string}`],
          });

          totalBalance += parseFloat(formatUnits(balance, 18));
        } catch (error) {
          // Skip individual errors
        }
      }
    } catch (error) {
      this.logError("Fee balance check failed", error);
    }

    return totalBalance;
  }

  private async getGroupBalance(
    group: UserGroup,
    userAddress: string
  ): Promise<number> {
    try {
      const currentChain = getDefaultChain();
      const publicClient = createPublicClient({
        chain: currentChain.viemChain,
        transport: http(),
      });

      const balance = await publicClient.readContract({
        address: group.id as `0x${string}`,
        abi: AddressFeeSplitManagerAbi,
        functionName: "balances",
        args: [userAddress as `0x${string}`],
      });

      return parseFloat(formatUnits(balance, 18));
    } catch (error) {
      this.logError("Failed to get group balance", error);
      return 0;
    }
  }

  private getGroupCoinCount(group: UserGroup, userState: any): number {
    // Count coins that belong to this group and are launched
    const groupCoins = userState.coins.filter(
      (coin: any) =>
        coin.groupId?.toLowerCase() === group.id.toLowerCase() && coin.launched
    );

    return groupCoins.length;
  }

  /**
   * Clear pending transactions from other flows when starting management operations
   * Only clears coin_creation transactions since management handles group_creation
   */
  private async handleInvitedUserWelcome(context: FlowContext): Promise<void> {
    const { userState } = context;

    // Generate welcome message with group and coin information
    const groupCount = userState.groups.length;
    const coinCount = userState.coins.length;

    let welcomeMessage = `hey! 👋 someone added you to a flaunchy group and you now have access to ${groupCount} group${
      groupCount !== 1 ? "s" : ""
    }`;

    if (coinCount > 0) {
      welcomeMessage += ` with ${coinCount} coin${coinCount !== 1 ? "s" : ""}`;
    }

    welcomeMessage += `!\n\n`;

    // List groups with ENS-resolved names
    if (groupCount > 0) {
      welcomeMessage += `your groups:\n`;
      for (const group of userState.groups) {
        const receiverNames = await Promise.all(
          group.receivers.map(
            async (r) =>
              await GroupCreationUtils.formatAddress(
                r.resolvedAddress,
                context.ensResolver
              )
          )
        );
        welcomeMessage += `• ${group.name} (${receiverNames.join(", ")})\n`;
      }
      welcomeMessage += `\n`;
    }

    // List coins if any
    if (coinCount > 0) {
      welcomeMessage += `your coins:\n`;
      for (const coin of userState.coins) {
        welcomeMessage += `• ${coin.name} (${coin.ticker})\n`;
      }
      welcomeMessage += `\n`;
    }

    welcomeMessage += `you can now:\n`;
    welcomeMessage += `• launch new coins for your groups\n`;
    welcomeMessage += `• check your fee earnings\n`;
    welcomeMessage += `• create new groups\n`;
    welcomeMessage += `• ask me anything about your groups or coins\n\n`;
    welcomeMessage += `what would you like to do?`;

    // Update user status to active (they've been welcomed)
    await context.sessionManager.updateUserState(userState.userId, {
      status: "active",
    });

    await this.sendResponse(context, welcomeMessage);
  }

  private async clearCrossFlowTransactions(
    context: FlowContext
  ): Promise<void> {
    const { groupState } = context;

    // Only clear coin_creation transactions, since management flow handles group_creation
    if (
      groupState.pendingTransaction &&
      groupState.pendingTransaction.type === "coin_creation"
    ) {
      const pendingTx = groupState.pendingTransaction;

      this.log("Clearing cross-flow pending transaction", {
        userId: context.userState.userId,
        transactionType: pendingTx.type,
        reason: "User explicitly started management operation",
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateGroupState({
        pendingTransaction: undefined,
        // Clear coin launch progress if it exists (user switching from coin launch to management)
        coinLaunchProgress: undefined,
      });

      // NO USER MESSAGE - clearing should be invisible to the user
      // They just want their management action completed, not to hear about technical cleanup
    }
  }

  /**
   * Send the mini app URL as a separate message for proper embedding
   */
  private async sendMiniAppUrl(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "https://mini.flaunch.gg");
  }
}

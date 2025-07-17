import { createPublicClient, http, formatUnits } from "viem";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { getDefaultChain } from "../utils/ChainSelection";
import { CoinLaunchFlow } from "../coin-launch/CoinLaunchFlow";
import { AddressFeeSplitManagerAbi } from "../../data/abi/AddressFeeSplitManager";
import { safeParseJSON } from "../../core/utils/jsonUtils";
import { LLMResponse } from "../../core/messaging/LLMResponse";
import {
  ManagementFlow_classifyTransactionIntentPrompt,
  ManagementFlow_modifyCoinTransactionPrompt,
  ManagementFlow_classifyActionPrompt,
  ManagementFlow_isTransactionStatusQuestionPrompt,
  ManagementFlow_isMessageAboutPendingTransactionPrompt,
} from "../../data/prompts";

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

  constructor() {
    super("ManagementFlow");
    this.coinLaunchFlow = new CoinLaunchFlow();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { participantState, messageText } = context;

    this.log("Processing management message", {
      participantAddress: context.creatorAddress,
      messageText: messageText?.substring(0, 100),
    });

    // Clear any conflicting pending transactions from other flows (but not our own)
    await this.clearCrossFlowTransactions(context);

    // Handle pending transactions
    if (participantState.pendingTransaction && messageText) {
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

    // Classify and handle the action
    const action = await this.classifyAction(messageText || "", context);
    await this.handleAction(context, action);
  }

  private async handlePendingTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { participantState } = context;

    if (!participantState.pendingTransaction) {
      return null;
    }

    const pendingTx = participantState.pendingTransaction;

    // Use LLM to determine if the message is about the pending transaction
    const isTransactionRelated = await this.isMessageAboutPendingTransaction(
      context,
      messageText,
      participantState.pendingTransaction?.type || "unknown"
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
    const { participantState } = context;
    const pendingTx = participantState.pendingTransaction;

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
    }

    transactionContext += `Network: ${pendingTx.network}\n`;
    transactionContext += `Created: ${new Date(
      pendingTx.timestamp
    ).toLocaleString()}\n\n`;

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: ManagementFlow_isMessageAboutPendingTransactionPrompt({
          transactionContext,
          messageText,
        }),
        max_tokens: 5,
      });

      return response?.toLowerCase() === "yes";
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
      const response = await LLMResponse.getResponse({
        context,
        prompt: ManagementFlow_classifyTransactionIntentPrompt({ messageText }),
        max_tokens: 10,
      });

      const intent = response?.toLowerCase();
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
    const { participantState } = context;
    const pendingTx = participantState.pendingTransaction;

    if (!pendingTx) {
      return "no pending transaction to modify.";
    }

    // Handle coin creation transaction modifications
    if (pendingTx.type === "coin_creation") {
      return await this.modifyCoinTransaction(context, messageText);
    }

    return "couldn't determine transaction type to modify.";
  }

  private async modifyCoinTransaction(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { participantState } = context;
    const pendingTx = participantState.pendingTransaction!;

    // Use LLM to extract parameter changes from the message
    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: ManagementFlow_modifyCoinTransactionPrompt({
          messageText,
          pendingTx,
        }),
        max_tokens: 100,
      });

      if (!response) {
        return "couldn't understand what parameters to change.";
      }

      let parameterChanges;
      try {
        parameterChanges = safeParseJSON(response);
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

      if (!targetGroupId) {
        return "couldn't find target group for your coin launch.";
      }

      // Use the current group or verify the target group exists in aggregated data
      const aggregatedData = await context.getUserAggregatedData();
      const targetGroup = aggregatedData.allGroups.find(
        (group) => group.groupId === targetGroupId
      );

      if (!targetGroup) {
        return "couldn't find the specified target group for your coin launch.";
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
            targetGroup: targetGroup.groupId,
            startingMarketCap:
              updatedLaunchParameters.startingMarketCap || 1000,
            fairLaunchDuration:
              updatedLaunchParameters.fairLaunchDuration || 30,
            premineAmount: updatedLaunchParameters.premineAmount || 0,
            buybackPercentage: updatedLaunchParameters.buybackPercentage || 0,
          } as any,
          targetGroup.groupId
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

  private async handleTransactionInquiry(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { participantState } = context;

    if (!participantState.pendingTransaction) return null;

    const pendingTx = participantState.pendingTransaction;

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
          // Use simplified group display for now since we don't store group names in the same way
          const groupDisplay = `${pendingTx.launchParameters.targetGroupId.slice(
            0,
            6
          )}...${pendingTx.launchParameters.targetGroupId.slice(-4)}`;
          transactionDetails += `• Target Group: ${groupDisplay}\n`;
        }
      }

      transactionDetails += `\nready to sign and launch!`;
    }

    return transactionDetails || "transaction ready to sign.";
  }

  private async classifyAction(
    messageText: string,
    context: FlowContext
  ): Promise<ManagementAction> {
    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: ManagementFlow_classifyActionPrompt({ messageText }),
        max_tokens: 20,
      });

      const action = response as ManagementAction;
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
    // Get aggregated user data from group states
    const aggregatedUserData = await context.getUserAggregatedData();
    const currentChain = getDefaultChain();

    // Only show groups on current network
    const currentNetworkGroups = aggregatedUserData.allGroups.filter(
      (group) => group.groupId // Access groupId from AggregatedUserData structure
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
          { id: group.groupId, chainName: currentChain.name } as any,
          context.creatorAddress
        );
        // For now, just show basic group info
        message += `• ${group.groupId.slice(0, 8)}...${group.groupId.slice(
          -6
        )}\n`;
        if (balance > 0) {
          message += `  • claimable: ${balance.toFixed(6)} ETH\n`;
        }
        message += "\n";
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
      `[ManagementFlow] 🪙 Listing coins for participant ${context.creatorAddress}`
    );
    console.log(`[ManagementFlow] Current chain: ${currentChain.displayName}`);

    try {
      // Fetch aggregated data from group states
      console.log(
        `[ManagementFlow] 📡 Fetching aggregated data from group states...`
      );
      const aggregatedUserData = await context.getUserAggregatedData();

      console.log(
        `[ManagementFlow] ✅ Got aggregated data - coins: ${aggregatedUserData.allCoins.length}, groups: ${aggregatedUserData.allGroups.length}`
      );

      // Only show coins on current network
      const currentNetworkCoins = aggregatedUserData.allCoins.filter(
        (coinWrapper) => coinWrapper.coin.chainId === currentChain.id
      );
      const currentNetworkGroups = aggregatedUserData.allGroups.filter(
        (group) => group.groupId // Use groupId from AggregatedUserData structure
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
        currentNetworkCoins.map((coinWrapper) => ({
          name: coinWrapper.coin.name,
          ticker: coinWrapper.coin.ticker,
          contractAddress: coinWrapper.coin.contractAddress,
          groupId: coinWrapper.groupId,
          hasLiveData: !!coinWrapper.coin.liveData,
        }))
      );

      // Check fee balances for current network groups
      const totalFees = await this.checkFeeBalances(
        currentNetworkGroups.map((g) => ({
          id: g.groupId,
          chainName: currentChain.name,
        })) as any,
        context.creatorAddress
      );

      // Build detailed message with coin information
      let message = `you have ${currentNetworkCoins.length} coin${
        currentNetworkCoins.length > 1 ? "s" : ""
      } on ${currentChain.displayName}:\n\n`;

      // Add coin details
      for (const coinWrapper of currentNetworkCoins) {
        const coin = coinWrapper.coin;
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
          message += `  • https://flaunch.gg/${currentChain.slug}/coin/${coin.contractAddress}\n`;
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

      // Fallback to aggregated data if live data fails
      const aggregatedUserData = await context.getUserAggregatedData();
      const currentNetworkCoins = aggregatedUserData.allCoins.filter(
        (coinWrapper) => coinWrapper.coin.chainId === currentChain.id
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

  private async claimFees(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "claim fees at:");
    await this.sendMiniAppUrl(context);
  }

  private async checkFees(context: FlowContext): Promise<void> {
    // Get aggregated user data from group states
    const aggregatedUserData = await context.getUserAggregatedData();
    const currentChain = getDefaultChain();

    // Only check groups on current network
    const currentNetworkGroups = aggregatedUserData.allGroups.filter(
      (group) => group.groupId // Use groupId from AggregatedUserData structure
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
        currentNetworkGroups.map((g) => ({
          id: g.groupId,
          chainName: currentChain.name,
        })) as any,
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
    const { participantState, messageText } = context;

    // Check if this is a question about pending transactions
    const isTransactionStatusQuestion = await this.isTransactionStatusQuestion(
      context,
      messageText
    );

    if (isTransactionStatusQuestion) {
      if (participantState.pendingTransaction) {
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
      const response = await LLMResponse.getResponse({
        context,
        prompt: ManagementFlow_isTransactionStatusQuestionPrompt({
          messageText,
        }),
        max_tokens: 5,
      });

      return response?.toLowerCase() === "yes";
    } catch (error) {
      this.logError(
        "Failed to determine if message is transaction status question",
        error
      );
      return false;
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

  private async clearCrossFlowTransactions(
    context: FlowContext
  ): Promise<void> {
    const { participantState } = context;

    // Only clear coin_creation transactions
    if (
      participantState.pendingTransaction &&
      participantState.pendingTransaction.type === "coin_creation"
    ) {
      const pendingTx = participantState.pendingTransaction;

      this.log("Clearing cross-flow pending transaction", {
        participantAddress: context.creatorAddress,
        transactionType: pendingTx.type,
        reason: "User explicitly started management operation",
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateParticipantState({
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

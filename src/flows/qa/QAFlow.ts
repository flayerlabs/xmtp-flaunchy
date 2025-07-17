import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
import {
  createCoinLaunchExtractionPrompt,
  CoinLaunchExtractionResult,
} from "../coin-launch/coinLaunchExtractionTemplate";
import { safeParseJSON, cleanTickerSymbol } from "../../core/utils/jsonUtils";
import { ChainConfig, getDefaultChain } from "../utils/ChainSelection";
import { LLMResponse } from "../../core/messaging/LLMResponse";
import {
  QAFlow_detectMultipleCoinRequestPrompt,
  QAFlow_detectMiniAppRequestPrompt,
  QAFlow_detectStatusInquiryPrompt,
  QAFlow_detectGroupsOrCoinsQueryPrompt,
  QAFlow_shouldSendMiniAppForGroupsCoinsPrompt,
  QAFlow_handleCapabilityQuestionPrompt,
  QAFlow_handleGeneralQuestionPrompt,
  QAFlow_handleStatusInquiryPrompt,
} from "../../data/prompts";
import { AddressUtils } from "../utils/AddressUtils";

export class QAFlow extends BaseFlow {
  constructor() {
    super("QAFlow");
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { messageText } = context;

    this.log("Processing Q&A message", {
      participantAddress: context.creatorAddress,
      message: messageText.substring(0, 100) + "...",
    });

    // ENHANCED: Check for multiple coin launch requests first
    const isMultipleCoinRequest = await this.detectMultipleCoinRequest(
      context,
      messageText
    );
    if (isMultipleCoinRequest) {
      await this.handleMultipleCoinRequest(context);
      return;
    }

    // Check if user with existing groups is trying to launch a coin
    const aggregatedUserData = await context.getUserAggregatedData();
    if (aggregatedUserData.allGroups.length > 0) {
      const extraction = await this.extractCoinLaunchDetails(context);
      if (
        extraction &&
        extraction.tokenDetails &&
        (extraction.tokenDetails.name ||
          extraction.tokenDetails.ticker ||
          context.hasAttachment)
      ) {
        // GUARD: Don't override existing coin launch progress
        if (context.participantState.coinLaunchProgress) {
          console.log(
            "🚨 QAFlow detected coin launch but existing progress exists - not overriding"
          );
          this.log(
            "Existing coin launch progress detected, not overriding in QA flow",
            {
              participantAddress: context.creatorAddress,
              existingStep: context.participantState.coinLaunchProgress.step,
              existingCoinData:
                context.participantState.coinLaunchProgress.coinData,
            }
          );

          // Send a message acknowledging the existing progress
          await this.sendResponse(
            context,
            "you already have a coin launch in progress! continue with the current launch or type 'cancel' to start over."
          );
          return;
        }

        this.log(
          "Coin launch detected in QA flow, redirecting to coin launch",
          {
            participantAddress: context.creatorAddress,
            tokenDetails: extraction.tokenDetails,
            launchParameters: extraction.launchParameters,
            hasAttachment: context.hasAttachment,
          }
        );

        // Start coin launch flow by initializing progress
        const coinData = {
          name: extraction.tokenDetails.name || undefined,
          ticker:
            cleanTickerSymbol(extraction.tokenDetails.ticker) || undefined,
          image:
            extraction.tokenDetails.image ||
            (context.hasAttachment ? "attachment_provided" : undefined),
        };

        const launchParameters = {
          startingMarketCap:
            extraction.launchParameters.startingMarketCap || undefined,
          fairLaunchDuration:
            extraction.launchParameters.fairLaunchDuration || undefined,
          premineAmount: extraction.launchParameters.premineAmount || undefined,
          buybackPercentage:
            extraction.launchParameters.buybackPercentage || undefined,
        };

        await context.updateParticipantState({
          coinLaunchProgress: {
            step: "collecting_coin_data",
            coinData,
            launchParameters,
            startedAt: new Date(),
          },
        });

        // Show groups for selection if user has multiple groups
        if (aggregatedUserData.allGroups.length === 1) {
          const group = aggregatedUserData.allGroups[0];
          const groupDisplay = await AddressUtils.formatAddress(
            group.groupId,
            context.ensResolver
          );
          await this.sendResponse(
            context,
            `launching ${
              extraction.tokenDetails.name || "coin"
            } into your group ${groupDisplay}. what details are missing?`
          );
        } else {
          let message = `launching ${
            extraction.tokenDetails.name || "coin"
          }! choose a group:\n\n`;

          // Resolve all group addresses at once
          const groupAddresses = aggregatedUserData.allGroups.map(
            (g) => g.groupId
          );
          const addressMap = await AddressUtils.formatAddresses(
            groupAddresses,
            context.ensResolver
          );

          for (const group of aggregatedUserData.allGroups) {
            const groupDisplay =
              addressMap.get(group.groupId.toLowerCase()) || group.groupId;
            message += `${groupDisplay}\n`;

            // Get coins for this group by matching manager addresses
            const groupManagerAddresses = group.managers.map((m) =>
              m.contractAddress.toLowerCase()
            );
            const groupCoins = aggregatedUserData.allCoins.filter((coinData) =>
              groupManagerAddresses.includes(
                coinData.coin.managerAddress.toLowerCase()
              )
            );

            if (groupCoins.length > 0) {
              message += `- coins: ${groupCoins
                .map((coinData) => coinData.coin.ticker)
                .join(", ")}\n\n`;
            } else {
              message += `- coins: none yet\n\n`;
            }
          }
          message +=
            "specify the contract address (group ID) you want to launch into.";
          await this.sendResponse(context, message);
        }
        return;
      }
    }

    // Note: Onboarding flow has been removed - users now launch coins directly with automatic group creation

    // Check if this is a capability question about how the agent/system works
    const isCapabilityQuestion =
      context.detectionResult?.questionType === "capability";

    // Check if this is a mini app share request
    const isMiniAppRequest = await this.detectMiniAppRequest(
      context,
      messageText
    );
    if (isMiniAppRequest) {
      await this.handleMiniAppRequest(context);
      return;
    }

    // Check if this is a status/transaction inquiry (use FlowRouter's detection result first)
    const isStatusInquiry =
      context.multiIntentResult?.flags?.isStatusInquiry ||
      (await this.detectStatusInquiry(context, messageText));

    if (isStatusInquiry) {
      await this.handleStatusInquiry(context, messageText);
      return;
    }

    if (isCapabilityQuestion) {
      await this.handleCapabilityQuestion(context, messageText);
      return;
    }

    // Default to general question handling
    await this.handleGeneralQuestion(context, messageText);
  }

  private async extractCoinLaunchDetails(
    context: FlowContext
  ): Promise<CoinLaunchExtractionResult | null> {
    const { messageText } = context;

    // Allow extraction even with empty message if there's an attachment
    if (!messageText && !context.hasAttachment) {
      return null;
    }

    try {
      const extractionPrompt = createCoinLaunchExtractionPrompt({
        message: messageText || "",
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? "image" : undefined,
        imageUrl: undefined,
      });

      const response = await LLMResponse.getResponse({
        context,
        prompt: extractionPrompt,
        max_tokens: 500,
      });
      if (!response) {
        return null;
      }

      const result = safeParseJSON<CoinLaunchExtractionResult>(response);

      this.log("🔍 COIN LAUNCH EXTRACTION RESULT", {
        messageText: messageText || "(empty with attachment)",
        hasAttachment: context.hasAttachment,
        tokenDetails: result.tokenDetails,
        launchParameters: result.launchParameters,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      this.logError("Failed to extract coin launch details", error);
      return null;
    }
  }

  // Note: extractLaunchDetails method removed - was used for onboarding flow which has been removed

  /**
   * Detect if user is asking to launch multiple coins at once
   */
  private async detectMultipleCoinRequest(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: QAFlow_detectMultipleCoinRequestPrompt({ messageText }),
        max_tokens: 5,
      });

      const result = response?.toLowerCase();
      return result?.startsWith("yes") || false;
    } catch (error) {
      this.logError("Failed to detect multiple coin request", error);
      return false;
    }
  }

  /**
   * Handle requests for multiple coin launches by explaining the limitation
   */
  private async handleMultipleCoinRequest(context: FlowContext): Promise<void> {
    await this.sendResponse(
      context,
      "i can only launch one coin at a time! " +
        "let's start with your first coin - give me a name, ticker, and image. " +
        "after we launch it, we can create another one."
    );
  }

  /**
   * Handle capability questions about how the agent/system works
   */
  private async handleCapabilityQuestion(
    context: FlowContext,
    messageText: string
  ): Promise<void> {
    // Check if this is a direct message
    if (context.isDirectMessage) {
      // For direct messages, provide structured guidance to group chats
      const directMessageResponse =
        "gmeow! i work in group chats where i can launch coins with fee splitting for all members.\n\n" +
        "to get started:\n" +
        "1. create a group chat with your friends\n" +
        "2. add me to the group\n" +
        "3. then i can help you launch coins with automatic fee splitting!\n\n" +
        "4. tag me @flaunchy or reply to my messages in the group to interact.\n\n" +
        "the magic happens when everyone's together in a group. stay based!";

      await this.sendResponse(context, directMessageResponse);
      return;
    }

    // Handle questions about how the agent/system works in group chats
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: QAFlow_handleCapabilityQuestionPrompt({ messageText }),
    });

    await this.sendResponse(context, response);
  }

  /**
   * Handle general guidance questions about using the system
   */
  private async handleGeneralQuestion(
    context: FlowContext,
    messageText: string
  ): Promise<void> {
    const aggregatedUserData = await context.getUserAggregatedData();

    // Handle general guidance questions about using the system in group chats
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: QAFlow_handleGeneralQuestionPrompt({
        messageText,
        coinsCount: aggregatedUserData.allCoins.length,
        groupsCount: aggregatedUserData.allGroups.length,
      }),
    });

    await this.sendResponse(context, response);
  }

  /**
   * Detect if user is asking to share mini app
   */
  private async detectMiniAppRequest(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: QAFlow_detectMiniAppRequestPrompt({ messageText }),
        max_tokens: 5,
      });

      const result = response?.toLowerCase();
      return result?.startsWith("yes") || false;
    } catch (error) {
      this.logError("Failed to detect mini app request", error);
      return false;
    }
  }

  /**
   * Handle mini app share requests
   */
  private async handleMiniAppRequest(context: FlowContext): Promise<void> {
    await this.sendResponse(context, "https://mini.flaunch.gg");
  }

  /**
   * Detect if user is asking about their current status, transactions, or progress
   */
  private async detectStatusInquiry(
    context: FlowContext,
    messageText: string
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: QAFlow_detectStatusInquiryPrompt({ messageText }),
        max_tokens: 5,
      });

      const result = response?.toLowerCase();
      return result?.startsWith("yes") || false;
    } catch (error) {
      this.logError("Failed to detect status inquiry", error);
      return false;
    }
  }

  /**
   * Handle status inquiries about user's current state and progress
   */
  private async handleStatusInquiry(
    context: FlowContext,
    messageText: string
  ): Promise<void> {
    console.log(`[QAFlow] 📊 Handling status inquiry: "${messageText}"`);
    console.log(`[QAFlow] Is direct message: ${context.isDirectMessage}`);

    const aggregatedUserData = await context.getUserAggregatedData();
    console.log(
      `[QAFlow] Participant ${context.creatorAddress} - Groups: ${aggregatedUserData.allGroups.length}, Coins: ${aggregatedUserData.allCoins.length}`
    );

    // Check if user is specifically asking about groups or coins (both DMs and group chats)
    console.log(`[QAFlow] 🔍 Detecting groups/coins query...`);
    const isGroupsOrCoinsQuery = await this.detectGroupsOrCoinsQuery(
      messageText,
      context
    );

    console.log(
      `[QAFlow] Groups/coins query detected: ${isGroupsOrCoinsQuery}`
    );

    if (isGroupsOrCoinsQuery) {
      // Get live data - we'll use the aggregated data approach instead of getUserStateWithLiveData
      console.log(`[QAFlow] 📡 Using aggregated user data...`);

      await this.handleGroupsOrCoinsQuery(
        context,
        messageText,
        aggregatedUserData
      );
      return;
    }

    // Handle other status inquiries differently for DMs vs group chats
    if (context.isDirectMessage) {
      // For other status inquiries in DMs, provide structured guidance to group chats
      console.log(`[QAFlow] 💬 Sending DM guidance message`);
      const directMessageResponse =
        "gmeow! i work in group chats where i can launch coins with fee splitting for all members.\n\n" +
        "to get started:\n" +
        "1. create a group chat with your friends\n" +
        "2. add me to the group\n" +
        "3. then i can help you launch coins with automatic fee splitting!\n\n" +
        "4. tag me @flaunchy or reply to my messages in the group to interact.\n\n" +
        "the magic happens when everyone's together in a group. stay based!";

      await this.sendResponse(context, directMessageResponse);
      return;
    }

    const { participantState } = context;

    // Build status information
    let statusInfo = [];

    // Groups
    if (aggregatedUserData.allGroups.length > 0) {
      statusInfo.push(`Groups: ${aggregatedUserData.allGroups.length} active`);
    } else {
      statusInfo.push(`Groups: none created yet`);
    }

    // Coins
    if (aggregatedUserData.allCoins.length > 0) {
      statusInfo.push(`Coins: ${aggregatedUserData.allCoins.length} launched`);
    } else {
      statusInfo.push(`Coins: none launched yet`);
    }

    // Pending transaction (participant-specific)
    if (participantState.pendingTransaction) {
      const txType = participantState.pendingTransaction.type.replace("_", " ");
      statusInfo.push(`Pending: ${txType} transaction ready to sign`);
    } else {
      statusInfo.push(`Pending: no transactions`);
    }

    // Coin launch progress (participant-specific)
    if (participantState.coinLaunchProgress) {
      const step = participantState.coinLaunchProgress.step || "unknown";
      statusInfo.push(`Coin launch: ${step} step`);
    }

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: QAFlow_handleStatusInquiryPrompt({
        messageText,
        statusInfo,
      }),
    });

    await this.sendResponse(context, response);
  }

  /**
   * Detect if user is specifically asking about groups or coins
   */
  private async detectGroupsOrCoinsQuery(
    messageText: string,
    context: FlowContext
  ): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: QAFlow_detectGroupsOrCoinsQueryPrompt({ messageText }),
        max_tokens: 5,
      });

      const result = response?.toLowerCase();

      return result?.startsWith("yes") || false;
    } catch (error) {
      this.logError("Failed to detect groups/coins query", error);
      return false;
    }
  }

  /**
   * Handle groups or coins query by fetching and displaying actual data
   */
  private async handleGroupsOrCoinsQuery(
    context: FlowContext,
    messageText: string,
    aggregatedUserData: any // Using AggregatedUserData interface
  ): Promise<void> {
    console.log(`[QAFlow] 🔍 Handling groups/coins query: "${messageText}"`);
    console.log(
      `[QAFlow] AggregatedUserData - Groups: ${aggregatedUserData.allGroups.length}, Coins: ${aggregatedUserData.allCoins.length}`
    );

    // Check if asking about groups specifically vs coins specifically
    const isGroupsQuery = messageText.toLowerCase().includes("group");
    const isCoinsQuery =
      messageText.toLowerCase().includes("coin") ||
      messageText.toLowerCase().includes("token");

    // Check if asking about coins IN a group (should prioritize coins over groups)
    const isCoinsInGroupQuery =
      (isCoinsQuery && isGroupsQuery) ||
      messageText.toLowerCase().includes("coins in") ||
      messageText.toLowerCase().includes("tokens in") ||
      messageText.toLowerCase().includes("what's in");

    console.log(
      `[QAFlow] Query type - Groups: ${isGroupsQuery}, Coins: ${isCoinsQuery}, CoinsInGroup: ${isCoinsInGroupQuery}`
    );

    let response = "";

    if (
      isCoinsInGroupQuery ||
      (isCoinsQuery && !isGroupsQuery) ||
      (!isGroupsQuery &&
        !isCoinsQuery &&
        aggregatedUserData.allCoins.length > 0)
    ) {
      // Handle coins query (including coins in group)
      console.log(
        `[QAFlow] 🪙 Processing coins query - found ${aggregatedUserData.allCoins.length} total coins`
      );

      const currentChain = getDefaultChain();

      // Filter coins for current chain only
      let currentNetworkCoins = aggregatedUserData.allCoins.filter(
        (coinWrapper: any) => coinWrapper.coin.chainName === currentChain.name
      );

      // If asking about coins in "this group", filter to only coins in the current group
      if (isCoinsInGroupQuery) {
        currentNetworkCoins = currentNetworkCoins.filter(
          (coinWrapper: any) => coinWrapper.groupId === context.groupId
        );
      }

      console.log(`[QAFlow] 🌐 Current chain: ${currentChain.displayName}`);
      if (isCoinsInGroupQuery) {
        console.log(
          `[QAFlow] 🏠 Filtering to current group: ${context.groupId}`
        );
      }
      console.log(
        `[QAFlow] 📊 Coins after filtering: ${currentNetworkCoins.length}`
      );

      if (currentNetworkCoins.length === 0) {
        console.log(
          `[QAFlow] ⚠️  No coins found ${
            isCoinsInGroupQuery ? "in this group" : "on current chain"
          } ${currentChain.displayName}`
        );
        if (isCoinsInGroupQuery) {
          response = `no coins launched in this group yet! launch your first coin and i'll handle the fee splitting automatically for everyone in this chat.`;
        } else {
          response = `you haven't launched any coins on ${currentChain.displayName} yet! launch your first coin and i'll handle the fee splitting automatically.`;
        }
      } else {
        console.log(
          `[QAFlow] 📊 Coins found on ${currentChain.displayName}:`,
          currentNetworkCoins.map((coinWrapper: any) => ({
            name: coinWrapper.coin.name,
            ticker: coinWrapper.coin.ticker,
            contractAddress: coinWrapper.coin.contractAddress,
            hasLiveData: !!coinWrapper.coin.liveData,
            chainName: coinWrapper.coin.chainName,
          }))
        );

        // Customize response based on query type
        if (isCoinsInGroupQuery) {
          response = `coins in this group (${currentNetworkCoins.length}):\n\n`;
        } else {
          response = `you have ${currentNetworkCoins.length} coin${
            currentNetworkCoins.length > 1 ? "s" : ""
          } on ${currentChain.displayName}:\n\n`;
        }

        for (const coinWrapper of currentNetworkCoins) {
          const coinDisplay = await this.formatCoinDisplay(
            coinWrapper.coin,
            currentChain
          );
          response += `${coinDisplay}\n`;
        }
      }
    } else if (
      isGroupsQuery ||
      (!isCoinsQuery && aggregatedUserData.allGroups.length > 0)
    ) {
      // Handle groups query
      // Filter groups to only include those with managers
      const groupsWithManagers = aggregatedUserData.allGroups.filter(
        (group: any) => group.managers && group.managers.length > 0
      );

      if (groupsWithManagers.length === 0) {
        response =
          "you don't have any groups yet! when you launch coins, i'll automatically create groups for fee splitting.";
      } else {
        response = `you have ${groupsWithManagers.length} group${
          groupsWithManagers.length > 1 ? "s" : ""
        }:\n\n`;

        const currentChain = getDefaultChain();

        // Reorder groups to put current group first (if it exists)
        let orderedGroups = [...groupsWithManagers];
        const currentGroupIndex = groupsWithManagers.findIndex(
          (group: any) => group.groupId === context.groupId
        );

        if (currentGroupIndex > 0) {
          // Move current group to the front
          const currentGroup = orderedGroups.splice(currentGroupIndex, 1)[0];
          orderedGroups.unshift(currentGroup);
        }

        for (let i = 0; i < orderedGroups.length; i++) {
          const group = orderedGroups[i];
          const groupDisplay = await this.formatGroupDisplay(group, context);
          const isCurrent = group.groupId === context.groupId;

          response += `${i + 1}. group chat: ${groupDisplay}${
            isCurrent ? " (current)" : ""
          } having managers:\n`;

          // Show block explorer links for all managers in the group
          for (const manager of group.managers) {
            if (manager.contractAddress) {
              response += `- ${currentChain.viemChain.blockExplorers.default.url}/address/${manager.contractAddress}\n`;
            }
          }
          response += `\n`; // Add spacing between groups
        }
      }
    } else {
      // General status if neither groups nor coins specified
      response = `status summary:\n`;
      response += `• groups: ${aggregatedUserData.allGroups.length}\n`;
      response += `• coins: ${aggregatedUserData.allCoins.length}\n`;

      if (
        aggregatedUserData.allGroups.length === 0 &&
        aggregatedUserData.allCoins.length === 0
      ) {
        response +=
          "\nlaunch your first coin and i'll automatically set up fee splitting!";
      }
    }

    console.log(`[QAFlow] 📤 Sending response: ${response.length} chars`);
    await this.sendResponse(context, response);

    // Check if we should send the mini app link as a separate message
    const shouldSendMiniApp = await this.shouldSendMiniAppForGroupsCoins(
      context,
      messageText,
      aggregatedUserData
    );

    if (shouldSendMiniApp) {
      console.log(`[QAFlow] 📱 Sending mini app link as separate message`);
      await this.sendResponse(
        context,
        "View more detailed info in the mini app:"
      );
      await this.sendResponse(context, "https://mini.flaunch.gg");
    }
  }

  /**
   * Determine if we should send the mini app link for groups/coins queries
   */
  private async shouldSendMiniAppForGroupsCoins(
    context: FlowContext,
    messageText: string,
    aggregatedUserData: any
  ): Promise<boolean> {
    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: QAFlow_shouldSendMiniAppForGroupsCoinsPrompt({
          messageText,
          groupsCount: aggregatedUserData.allGroups.length,
          coinsCount: aggregatedUserData.allCoins.length,
        }),
        max_tokens: 5,
      });

      const result = response?.toLowerCase();
      return result?.startsWith("yes") || false;
    } catch (error) {
      this.logError("Failed to determine if mini app should be sent", error);
      return false;
    }
  }

  /**
   * Format group display with live data
   */
  private async formatGroupDisplay(
    group: any,
    context: FlowContext
  ): Promise<string> {
    let display = "";

    // First, try to get the group name from local group state
    try {
      const groupState = await context.sessionManager
        .getGroupStateManager()
        .getGroupState(group.groupId);

      if (groupState?.metadata?.name) {
        display = groupState.metadata.name;
        console.log(`[QAFlow] Using group name from local state: ${display}`);
        return display;
      }
    } catch (error) {
      console.warn(
        `[QAFlow] Could not fetch group state for ${group.groupId}:`,
        error
      );
    }

    // If no group name in local state, try to get it from XMTP conversation metadata
    // try {
    //   const conversation =
    //     await context.client.conversations.getConversationById(group.groupId);
    //   if (conversation) {
    //     // Note: XMTP conversation metadata methods might not be available yet
    //     // This is a placeholder for when they become available
    //     // Uncomment and modify when XMTP adds group name support:
    //     // if (conversation.metadata?.name) {
    //     //   display = conversation.metadata.name;
    //     //   console.log(`[QAFlow] Using group name from XMTP: ${display}`);
    //     //   return display;
    //     // }
    //   }
    // } catch (error) {
    //   console.warn(
    //     `[QAFlow] Could not fetch XMTP conversation for ${group.groupId}:`,
    //     error
    //   );
    // }

    // Fallback to formatAddress as before
    const groupDisplay = await AddressUtils.formatAddress(
      group.groupId,
      context.ensResolver
    );

    display = `${groupDisplay}`;

    // Note: Keep existing logic for backward compatibility
    if (group.groupName) {
      display += ` (${group.groupName})`;
    }

    console.log(`[QAFlow] Using fallback address format: ${display}`);
    return display;
  }

  /**
   * Format coin display with live data
   */
  private async formatCoinDisplay(
    coin: any,
    currentChain: ChainConfig
  ): Promise<string> {
    console.log(
      `[QAFlow] 🎨 Formatting coin display for ${coin.name} (${coin.ticker})`
    );
    console.log(`[QAFlow] Coin has live data: ${!!coin.liveData}`);

    let display = `🪙 ${coin.name} (${coin.ticker})\n`;

    if (coin.liveData) {
      console.log(`[QAFlow] 📊 Live data:`, {
        holders: coin.liveData.totalHolders,
        marketCap: coin.liveData.marketCapUSDC,
        priceChange: coin.liveData.priceChangePercentage,
        fees: coin.liveData.totalFeesUSDC,
      });

      display += `  • holders: ${coin.liveData.totalHolders}\n`;
      display += `  • market cap: $${parseFloat(
        coin.liveData.marketCapUSDC
      ).toLocaleString()}\n`;

      if (
        coin.liveData.priceChangePercentage &&
        parseFloat(coin.liveData.priceChangePercentage) !== 0
      ) {
        const priceChangeNum = parseFloat(coin.liveData.priceChangePercentage);
        const change = priceChangeNum > 0 ? "+" : "";
        display += `  • 24h change: ${change}${priceChangeNum.toFixed(2)}%\n`;
      }

      if (
        coin.liveData.totalFeesUSDC &&
        parseFloat(coin.liveData.totalFeesUSDC) > 0
      ) {
        display += `  • fees: $${parseFloat(
          coin.liveData.totalFeesUSDC
        ).toLocaleString()}\n`;
      }
    } else {
      console.log(`[QAFlow] ⚠️  No live data available for ${coin.name}`);
      display += `  • no live data available\n`;
    }

    if (coin.contractAddress) {
      display += `  • contract: ${coin.contractAddress.slice(
        0,
        8
      )}...${coin.contractAddress.slice(-6)}\n`;
      // add flaunch link
      display += `  • https://flaunch.gg/${currentChain.slug}/coin/${coin.contractAddress}\n`;
    }

    return display;
  }
}

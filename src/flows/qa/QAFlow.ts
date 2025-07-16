import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
// Note: createLaunchExtractionPrompt import removed - was used for onboarding flow which has been removed
import {
  createCoinLaunchExtractionPrompt,
  CoinLaunchExtractionResult,
} from "../coin-launch/coinLaunchExtractionTemplate";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { safeParseJSON, cleanTickerSymbol } from "../../core/utils/jsonUtils";
import { ChainConfig, getDefaultChain } from "../utils/ChainSelection";

export class QAFlow extends BaseFlow {
  constructor() {
    super("QAFlow");
  }

  async processMessage(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);

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
          const groupDisplay = await GroupCreationUtils.formatAddress(
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
          const addressMap = await GroupCreationUtils.formatAddresses(
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
    const messageText = this.extractMessageText(context);

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

      const completion = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 500,
      });

      const response = completion.choices[0]?.message?.content;
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
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
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
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();
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
      prompt: `
        User is asking a CAPABILITY question about how you (the agent) or the system works: "${messageText}"
        
        This is a GROUP CHAT (not a direct message).
        
        SIMPLIFIED WORKFLOW TO EXPLAIN:
        "Launch coins with me and you'll split the trading fees with everyone in this chat group. Tag me @flaunchy or reply to my messages to interact."
        
        Key points about the new system:
        - You automatically create groups for everyone in the chat when they launch coins
        - No manual group creation needed - it's all handled automatically
        - Users just need to launch coins and the fee splitting happens automatically
        - Everyone in the chat group becomes part of the group and splits trading fees
        
        Common capability questions and how to answer them:
        - "How do you make money?" → Explain that you're a bot that helps launch coins, you don't make money yourself
        - "What do you do?" → Explain your role as a simplified coin launcher that automatically handles groups
        - "How does this work?" → Explain the simplified workflow: just launch coins and automatic group creation
        - "What can you do?" → Explain coin launching with automatic fee splitting
        
        IMPORTANT:
        - Answer about YOU (the agent) and the SYSTEM, not about how users make money
        - Be clear you're an AI assistant that launches coins and automatically creates groups
        - Emphasize the simplicity - no complex setup needed
        - Keep it concise but informative
        
        FORMATTING REQUIREMENTS:
        - Use \n to separate different concepts and create line breaks
        - Break up long explanations into multiple paragraphs
        - Use bullet points or numbered lists when appropriate
        - Make the response easy to read and scan, but keep it short and concise
        - DON'T use markdown (like **bold** or *italic*)
        
        Use your character's voice but focus on explaining your role and the simplified workflow.
      `,
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
      prompt: `
        User asked: "${messageText}"
        
        User context:
        - Status: ${aggregatedUserData.status}
        - Has ${aggregatedUserData.allCoins.length} coins
        - Has ${aggregatedUserData.allGroups.length} groups
        - This is a GROUP CHAT (not a direct message)
        
        This is a GENERAL question about using the system (not about your capabilities).
        
        SIMPLIFIED WORKFLOW TO EXPLAIN:
        "Launch coins with me and you'll split the trading fees with everyone in this chat group. Tag me @flaunchy or reply to my messages to interact."
        
        Provide helpful guidance about:
        - Coin launching with automatic group creation
        - Fee splitting mechanisms (automatic for everyone in chat)
        - Trading and fair launches
        - No complex setup needed - just launch coins
        
        IMPORTANT: Emphasize the simplicity - users just need to launch coins and everything else is handled automatically.
        
        FORMATTING REQUIREMENTS:
        - Use \n to separate different concepts and create line breaks
        - Break up long explanations into multiple paragraphs
        - Use bullet points or numbered lists when appropriate
        - Make the response easy to read and scan, but keep it short and concise
        - DON'T use markdown (like **bold** or *italic*)
        
        Use your character's voice but prioritize brevity and helpfulness.
      `,
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
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Is this message asking to share the mini app? <message>"${messageText}"</message>
          
          Look for patterns like:
          - "share mini app"
          - "share the mini app"
          - "what's the mini-app link?"
          - "share app"
          - "share the app"
          - "give me the mini app"
          - "where is the mini app"
          - "mini app url"
          - "share mini"
          - "mini app"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();
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
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Is this message asking about the user's current status, progress, or pending transactions? "${messageText}"
          
          Look for questions like:
          - "do I have a group being created?"
          - "what's my status?"
          - "do I have any pending transactions?"
          - "what groups do I have?"
          - "what coins have I launched?"
          - "am I in onboarding?"
          - "what's happening with my transaction?"
          - "where am I in the process?"
          - "what's my current state?"
          - "do I have anything pending?"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();
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

    // Current status
    statusInfo.push(`Status: ${aggregatedUserData.status}`);

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

    // Management progress (participant-specific)
    if (participantState.managementProgress) {
      const action = participantState.managementProgress.action || "unknown";
      statusInfo.push(`Management: ${action} in progress`);
    }

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User asked: "${messageText}"
        
        Current status information:
        ${statusInfo.join("\n")}
        
        Answer their question about their current status/progress using this information.
        Be direct and informative. If they have a pending transaction, mention they need to sign it.
        If they're in onboarding, briefly explain what step they're on.
        
        FORMATTING REQUIREMENTS:
        - Use \n to separate different status items and create line breaks
        - Make the response easy to read and scan, but keep it short and concise
        - Use bullet points or numbered lists when appropriate
        - DON'T use markdown (like **bold** or *italic*)
        
        Use your character's voice but prioritize clarity and helpfulness.
      `,
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
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Is this message specifically asking about groups or coins/tokens? "${messageText}"
          
          Look for patterns like but not limited to:
          - "list my groups"
          - "show my groups"
          - "what groups do I have"
          - "what are my groups"
          - "my groups"
          - "list my coins"
          - "show my coins"
          - "what coins do I have"
          - "what are my coins"
          - "my coins"
          - "what tokens do I have"
          - "what are my tokens"
          - "my tokens"
          - "show my holdings"
          - "what coins are in this group"
          - "what coins are in the group"
          - "what's in this group"
          - "what's in the group"
          - "coins in this group"
          - "coins in the group"
          - "show coins in this group"
          - "list coins in this group"
          - "what coins does this group have"
          - "what tokens are in this group"
          - "what tokens are in the group"
          - "group coins"
          - "group tokens"
          - "this group's coins"
          - "this group's tokens"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();

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
      if (aggregatedUserData.allGroups.length === 0) {
        response =
          "you don't have any groups yet! when you launch coins, i'll automatically create groups for fee splitting.";
      } else {
        response = `you have ${aggregatedUserData.allGroups.length} group${
          aggregatedUserData.allGroups.length > 1 ? "s" : ""
        }:\n\n`;

        const currentChain = getDefaultChain();

        for (const group of aggregatedUserData.allGroups) {
          const groupDisplay = await this.formatGroupDisplay(group, context);
          response += `${groupDisplay}\n`;
          response += `  ${currentChain.viemChain.blockExplorers.default.url}/address/${group.groupId}\n`;
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
  }

  /**
   * Format group display with live data
   */
  private async formatGroupDisplay(
    group: any,
    context: FlowContext
  ): Promise<string> {
    const groupDisplay = await GroupCreationUtils.formatAddress(
      group.groupId,
      context.ensResolver
    );

    let display = `• ${groupDisplay}`;

    // Note: Live data access would need to be implemented based on group structure
    // For now, just show basic info
    if (group.groupName) {
      display += ` (${group.groupName})`;
    }

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

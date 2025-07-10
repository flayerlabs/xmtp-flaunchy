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
    super("OnboardingFlow");
    this.coinLaunchFlow = new CoinLaunchFlow();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);

    this.log("Processing onboarding message", {
      userId: userState.userId,
      status: userState.status,
      hasGroups: userState.groups.length > 0,
      hasCoins: userState.coins.length > 0,
      messageText: messageText?.substring(0, 50),
    });

    // Priority 0: Check for high-priority action intents first
    // These should override greetings and be processed immediately
    if (context.detectionResult && this.isHighPriorityActionIntent(context.detectionResult)) {
      this.log("High-priority action intent detected, processing action over greeting", {
        actionType: context.detectionResult.actionType,
        confidence: context.detectionResult.confidence,
        isGreeting: context.detectionResult.isGreeting,
      });
      
      // Handle the high-priority action intent
      if (context.detectionResult.actionType === 'create_group' || 
          context.detectionResult.isGroupForEveryone || 
          context.detectionResult.isAddEveryone ||
          context.detectionResult.isNewGroupCreation ||
          context.detectionResult.isGroupCreationResponse) {
        // Process group creation immediately
        await this.handleGroupCreation(context);
        return;
      }
      
      // For other high-priority actions, continue with normal flow
      // but don't handle greeting
    } else if (context.detectionResult?.isGreeting) {
      // Only handle greeting if no high-priority action intent is detected
      await this.handleGreeting(context);
      return;
    }

    // Handle pending transaction updates first
    if (userState.pendingTransaction) {
      // Check if user wants to cancel the transaction
      const isCancellation = await this.detectCancellation(
        context,
        messageText
      );
      if (isCancellation) {
        await this.cancelTransaction(context);
        await this.sendResponse(context, "transaction cancelled.");
        return;
      }

      const transactionResponse = await this.handlePendingTransactionInquiry(
        context,
        messageText
      );
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
    }

    // Fix users who are marked as active but don't have coins (incomplete onboarding)
    if (userState.status === "active" && userState.coins.length === 0) {
      await context.updateState({
        status: "onboarding",
        onboardingProgress: {
          step: "coin_creation",
          startedAt: new Date(),
        },
      });

      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Welcome back! I see you have groups set up but haven't launched any coins yet.
          Let's get your first coin launched so you can start earning from trading fees.
          What coin would you like to create?
        `,
      });

      await this.sendResponse(context, response);
      return;
    }

    // If user is new, check if they're making a specific group creation request
    if (userState.status === "new") {
      // Check if this message contains a group creation request
      const hasGroupCreationRequest = await this.detectGroupCreationInMessage(
        context,
        messageText
      );

      if (hasGroupCreationRequest) {
        // Update to onboarding status and process the group creation
        await context.updateState({
          status: "onboarding",
          onboardingProgress: {
            step: "group_creation",
            startedAt: new Date(),
          },
        });

        // Process the group creation request
        await this.handleGroupCreation(context);
        return;
      } else {
        // No specific request, give general welcome
        await this.startOnboarding(context);
        return;
      }
    }

    // If user has no groups, they need to create one first
    if (userState.groups.length === 0) {
      await this.handleGroupCreation(context);
      return;
    }

    // Check if user wants to create an additional group during onboarding
    if (userState.status === "onboarding" && messageText) {
      const wantsNewGroup = await this.detectNewGroupCreation(
        context,
        messageText
      );
      if (wantsNewGroup) {
        await this.handleGroupCreation(context);
        return;
      }
    }

    // User has groups - handle onboarding flow
    if (userState.status === "onboarding") {
      // Note: Onboarding completion is handled automatically when first coin is successfully launched
      // (in EnhancedMessageCoordinator transaction processing)

      // Check if user wants to modify fee splits for pending transactions
      if (userState.pendingTransaction && messageText) {
        const isFeeSplitModification = await this.detectFeeSplitModification(
          context,
          messageText
        );
        if (isFeeSplitModification) {
          await this.handleFeeSplitModification(context);
          return;
        }
      }

      // They have groups but no coins - guide them to coin launch
      await this.handleCoinLaunch(context);
    } else {
      // User is active and has both groups and coins, shouldn't be in onboarding flow
      await this.sendResponse(
        context,
        "you're all set up! create more groups or launch coins anytime."
      );
    }
  }

  private async startOnboarding(context: FlowContext): Promise<void> {
    // Update user to onboarding status
    await context.updateState({
      status: "onboarding",
      onboardingProgress: {
        step: "group_creation",
        startedAt: new Date(),
      },
    });

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Give a welcome message that explains:
        
        * You're here to help them launch coins and earn passive income from the trading fees
        * First you create a group for them and their friends. That group splits all the trading fees of all the coins they launch.
        * Once their group is up and running, they can launch coins for free.
        * To get started - they should just @ the people they want to bring into their group or just create it for themselves
        
        Use your character's voice and personality. Be informative but engaging. Split into paragraphs for readability.
      `,
    });

    await this.sendResponse(context, response);
  }

  private async handleGroupCreation(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);

    // Get existing receivers from the onboarding progress if available
    const existingReceivers =
      context.userState.onboardingProgress?.splitData?.receivers || [];

    // Check if user is asking about existing receivers
    const isAskingAboutExisting = await this.detectExistingReceiversInquiry(
      context,
      messageText
    );
    if (isAskingAboutExisting) {
      await this.handleExistingReceiversInquiry(context);
      return;
    }

    // Check if this is a removal request
    const isRemovalRequest = await this.detectRemovalRequest(context, messageText);
    
    if (isRemovalRequest) {
      if (existingReceivers.length === 0) {
        await this.sendResponse(context, "no receivers to remove. please specify who should receive trading fees first.");
        return;
      }
      
      await this.handleReceiverRemoval(context, messageText, existingReceivers);
      return;
    }

    // Check if this is a request to add everyone from the chat
    const isAddEveryone = await this.detectAddEveryone(context, messageText);

    if (isAddEveryone) {
      await this.addEveryoneFromChat(context);
      return;
    }

    // Check if user is trying to add to an existing group (ONLY when pending transaction exists)
    // Without a pending transaction, treat all messages as complete new group specifications
    const isAddToExisting = await this.detectAddToExistingGroup(
      context,
      messageText
    );
    if (
      isAddToExisting &&
      existingReceivers.length > 0 &&
      context.userState.pendingTransaction
    ) {
      await this.addToExistingGroup(context, messageText);
      return;
    }

    // If no pending transaction exists, treat any group specification as a complete replacement
    // This prevents accumulation of receivers across separate messages
    if (!context.userState.pendingTransaction && existingReceivers.length > 0) {
      // Clear existing receivers - this is a new group specification
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: undefined,
        },
      });
    }

    // Check if this is a complete group replacement (e.g. "ok add user1, user2, user3, user4 equal split")
    const isCompleteReplacement = await this.detectCompleteGroupReplacement(
      context,
      messageText
    );
    if (
      isCompleteReplacement &&
      existingReceivers.length > 0 &&
      context.userState.pendingTransaction
    ) {
      // Clear existing receivers and create new group
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: undefined,
        },
      });
      // Continue to regular group creation logic
    }

    // Check if user is trying to modify existing receiver percentages (ONLY when pending transaction exists)
    const isPercentageUpdate = await this.detectPercentageUpdate(
      context,
      messageText
    );
    if (
      isPercentageUpdate &&
      existingReceivers.length > 0 &&
      context.userState.pendingTransaction
    ) {
      await this.handlePercentageUpdate(context, messageText);
      return;
    }

    // Special case: Check if this is an "add me with X%" request ONLY when no pending transaction
    // This handles partial percentage specifications that need completion
    if (
      (!existingReceivers || existingReceivers.length === 0) &&
      !context.userState.pendingTransaction
    ) {
      const isAddingToExisting = await this.detectAddToExistingGroup(
        context,
        messageText
      );
      if (isAddingToExisting) {
        // Try to extract the receivers to see if it's a partial percentage
        let result;
        try {
          result = await GroupCreationUtils.createGroupFromMessage(
            context,
            getDefaultChain(),
            "Extract Receivers"
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          if (
            errorMessage.includes("Total shares") &&
            errorMessage.includes("do not equal required total")
          ) {
            // This is a partial percentage - save it as the first receiver
            try {
              const extraction = await GroupCreationUtils.extractFeeReceivers(
                context
              );
              if (extraction && extraction.receivers.length > 0) {
                const resolvedReceivers =
                  await GroupCreationUtils.resolveUsernames(
                    context,
                    extraction.receivers
                  );

                // Save this as the first receiver even though percentages don't add up
                await context.updateState({
                  onboardingProgress: {
                    ...context.userState.onboardingProgress!,
                    splitData: {
                      receivers: resolvedReceivers,
                      equalSplit: false,
                      creatorPercent: 0,
                    },
                  },
                });

                // Calculate total percentage used by all receivers
                const totalUsedPercentage = resolvedReceivers.reduce(
                  (sum, r) => sum + (r.percentage || 0),
                  0
                );
                const remainingPercentage = 100 - totalUsedPercentage;

                // Create a list of the receivers for the message
                const receiverNames = resolvedReceivers
                  .map((r) =>
                    r.username && r.username.startsWith("@")
                      ? r.username
                      : `@${r.username}`
                  )
                  .join(", ");

                await this.sendResponse(
                  context,
                  `got it! ${receiverNames} will get ${totalUsedPercentage}% of trading fees. who else should get the remaining ${remainingPercentage}%?`
                );
                return;
              }
            } catch (extractError) {
              this.logError(
                "Failed to extract partial receivers",
                extractError
              );
            }
          }
        }
      }
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("Total shares") &&
        errorMessage.includes("do not equal required total")
      ) {
        // Parse the percentage issue
        const response = await getCharacterResponse({
          openai: context.openai,
          character: context.character,
          prompt: `
            The user provided percentages that don't add up to 100%. 
            Briefly explain they need to specify percentages that total 100%, or let the system do equal splits.
            Be helpful and concise.
          `,
        });
        await this.sendResponse(context, response);
        return;
      } else if (errorMessage.includes("Couldn't resolve these usernames")) {
        // Handle username resolution failures
        await this.sendResponse(context, errorMessage.toLowerCase());
        return;
      } else {
        // Handle other errors
        this.logError("Group creation error", error);
        await this.sendResponse(
          context,
          "something went wrong creating the group. please try again or contact support."
        );
        return;
      }
    }

    if (result) {
      // Send transaction FIRST
      await context.conversation.send(
        result.walletSendCalls,
        ContentTypeWalletSendCalls
      );

      // Update onboarding progress AFTER successful transaction send
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: {
            receivers: result.resolvedReceivers,
            equalSplit: !result.resolvedReceivers.some((r) => r.percentage),
            creatorPercent: 0,
          },
        },
        pendingTransaction: {
          type: "group_creation",
          network: result.chainConfig.name,
          timestamp: new Date(),
        },
      });

      // Create message with ENS-resolved names
      const response = await GroupCreationUtils.createTransactionMessageWithENS(
        result.resolvedReceivers,
        "created",
        context.ensResolver
      );

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
        `,
      });

      await this.sendResponse(context, response);
    }
  }

  private async handleCoinLaunch(context: FlowContext): Promise<void> {
    // Delegate to CoinLaunchFlow for coin creation
    await this.coinLaunchFlow.processMessage(context);

    // Check if onboarding should be completed after successful coin launch
    // Only complete when: no coin launch progress, no pending transaction, and coins exist
    if (
      context.userState.status === "onboarding" &&
      !context.userState.coinLaunchProgress &&
      !context.userState.pendingTransaction &&
      context.userState.groups.length > 0 &&
      context.userState.coins.length > 0
    ) {
      await context.updateState({
        status: "active",
        onboardingProgress: undefined,
      });

      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Congratulate the user on completing onboarding! They successfully created groups and launched their first coin.
          Let them know they can create more groups, launch more coins, or ask questions.
          Keep it brief and celebratory.
        `,
      });

      await this.sendResponse(context, response);
    }
  }

  private async detectAddEveryone(
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
            content: `Does this message request to include ALL group chat members? "${messageText}" 
          
          Look for requests like:
          - "everyone"
          - "for everyone" 
          - "all members"
          - "include everyone"
          - "everyone in the chat"
          - "add everyone"
          - "create a group for everyone"
          - "launch a group for everyone"
          - "start a group for everyone"
          - "make a group for everyone"
          - "set up a group for everyone"
          - "flaunchy create a group for everyone"
          - "group for everyone"
          - "everyone in this chat"
          - "all of us"
          - "all people here"
          - "launch group for everyone"
          - "create group for everyone"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result =
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes";

      console.log("[OnboardingFlow] Everyone detection:", {
        messageText: messageText.substring(0, 50),
        result,
        userId: context.userState.userId.substring(0, 8) + "...",
      });

      return result;
    } catch (error) {
      this.logError("Failed to detect add everyone intent", error);
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
              percentage: undefined, // Equal split
            });
          }
        }
      }

      if (feeReceivers.length === 0) {
        await this.sendResponse(
          context,
          "couldn't find any group members. please specify fee receivers manually."
        );
        return;
      }

      // Create group with all members
      const defaultChain = getDefaultChain();
      let walletSendCalls;
      try {
        walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          feeReceivers,
          context.creatorAddress,
          defaultChain,
          "Create Group with All Members"
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes("Total shares") &&
          errorMessage.includes("do not equal required total")
        ) {
          await this.sendResponse(
            context,
            "error creating group with all members - percentages don't add up. please specify receivers manually."
          );
          return;
        } else {
          this.logError("Group deployment error", error);
          await this.sendResponse(
            context,
            "couldn't add everyone. please specify fee receivers manually."
          );
          return;
        }
      }

      // Update state
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: {
            receivers: feeReceivers,
            equalSplit: true,
            creatorPercent: 0,
          },
        },
        pendingTransaction: {
          type: "group_creation",
          network: defaultChain.name,
          timestamp: new Date(),
        },
      });

      // Send transaction
      await context.conversation.send(
        walletSendCalls,
        ContentTypeWalletSendCalls
      );

      const response = await GroupCreationUtils.createTransactionMessageWithENS(
        feeReceivers,
        `sign the transaction to create your group with all`,
        context.ensResolver
      );

      await this.sendResponse(context, response);
    } catch (error) {
      this.logError("Failed to add everyone from chat", error);
      await this.sendResponse(
        context,
        "couldn't add everyone. please specify fee receivers manually."
      );
    }
  }

  private async detectAddToExistingGroup(
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
            content: `Does this message request to ADD a single person or small number of people to an existing group? "${messageText}" 
          
          Look for requests like:
          - "add @alice"
          - "include @bob" 
          - "also add @charlie"
          - "can you add @david"
          - "please add @eve"
          - "and add @frank"
          - "add me with X%"
          - "add me with X% of the fees"
          - "oh wait add me"
          - "add myself"
          - "add @alice and @bob" (small addition)
          
          DO NOT match these (these are new group creation):
          - "add @user1, @user2, @user3, @user4 equal split" (multiple users with split instruction)
          - "ok add @a, @b, @c, @d all equal" (complete group specification)
          - Messages that mention "all equal split" or "equal split" with many users
          - Messages that list 3+ users with splitting instructions
          
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
      this.logError("Failed to detect add to existing intent", error);
      return false;
    }
  }

  private async addToExistingGroup(
    context: FlowContext,
    messageText: string
  ): Promise<void> {
    try {
      // Get existing receivers from pending transaction
      const existingReceivers =
        context.userState.onboardingProgress?.splitData?.receivers || [];

      // Extract new receivers from the message (without creating transaction yet)
      let extraction;
      try {
        extraction = await GroupCreationUtils.extractFeeReceivers(context);
      } catch (error) {
        this.logError("Failed to extract fee receivers", error);
        await this.sendResponse(
          context,
          "couldn't understand who to add. try again with @username or address."
        );
        return;
      }

      if (
        !extraction ||
        !extraction.receivers ||
        extraction.receivers.length === 0
      ) {
        await this.sendResponse(
          context,
          "couldn't find anyone to add. try again with @username or address."
        );
        return;
      }

      // Resolve usernames to addresses
      let newReceivers;
      try {
        newReceivers = await GroupCreationUtils.resolveUsernames(
          context,
          extraction.receivers
        );
      } catch (error) {
        this.logError("Failed to resolve usernames", error);
        await this.sendResponse(
          context,
          "couldn't resolve usernames. please try again."
        );
        return;
      }

      // Check for resolution failures
      const failed = newReceivers.filter((r) => !r.resolvedAddress);
      if (failed.length > 0) {
        await this.sendResponse(
          context,
          `couldn't resolve these usernames: ${failed
            .map((r) => r.username)
            .join(", ")}`
        );
        return;
      }

      if (newReceivers.length > 0) {
        // Combine existing and new receivers
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
          const isDuplicate = existingReceivers.some(
            (existing) =>
              existing.resolvedAddress?.toLowerCase() ===
              newReceiver.resolvedAddress?.toLowerCase()
          );

          if (!isDuplicate) {
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
            await this.sendResponse(
              context,
              "specified percentage is too high. please use a lower percentage to leave room for existing members."
            );
            return;
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
              await this.sendResponse(
                context,
                "existing receivers already use 100% of fees. please adjust percentages or replace some receivers."
              );
              return;
            }

            // New receivers split the remaining percentage equally
            const newReceiversCount = newReceiversWithoutPercentage.length;
            const percentagePerNewReceiver =
              newReceiversCount > 0
                ? remainingPercentage / newReceiversCount
                : 0;

            updatedReceivers = combinedReceivers.map((receiver) => {
              // If this is an existing receiver with percentage, keep it
              const existingWithPercentage =
                existingReceiversWithPercentage.find(
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

        // NOW create the transaction with the combined receivers
        let walletSendCalls;
        try {
          walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
            updatedReceivers,
            context.creatorAddress,
            getDefaultChain(),
            "Create Group with Added Members"
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("Total shares") &&
            errorMessage.includes("do not equal required total")
          ) {
            await this.sendResponse(
              context,
              "error combining receivers - percentages don't add up to 100%. please try again."
            );
            return;
          } else {
            this.logError("Group deployment error", error);
            await this.sendResponse(
              context,
              "couldn't create group deployment. please try again."
            );
            return;
          }
        }

        // Send new transaction FIRST
        await context.conversation.send(
          walletSendCalls,
          ContentTypeWalletSendCalls
        );

        // Update state with combined receivers AFTER successful transaction send
        await context.updateState({
          onboardingProgress: {
            ...context.userState.onboardingProgress!,
            splitData: {
              receivers: updatedReceivers,
              equalSplit: !updatedReceivers.some((r) => r.percentage),
              creatorPercent: 0,
            },
          },
          pendingTransaction: {
            type: "group_creation",
            network: getDefaultChain().name,
            timestamp: new Date(),
          },
        });

        // Create message based on ACTUAL transaction data
        const response = await this.createTransactionMessage(
          context,
          walletSendCalls,
          updatedReceivers,
          "updated"
        );

        await this.sendResponse(context, response);
      } else {
        await this.sendResponse(
          context,
          "couldn't find anyone to add. try again with @username or address."
        );
      }
    } catch (error) {
      this.logError("Failed to add to existing group", error);
      await this.sendResponse(
        context,
        "couldn't add to group. please try again."
      );
    }
  }

  private async handlePendingTransactionInquiry(
    context: FlowContext,
    messageText: string
  ): Promise<string | null> {
    const { userState } = context;

    // Check if user is asking about the pending transaction using LLM
    try {
      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Is this message asking about transaction details, group members, or fee receivers? "${messageText}"
          
          Look for questions about:
          - "who are the receivers?"
          - "what addresses are in the group?"
          - "who gets the fees?"
          - "what percentage does each get?"
          - "show me the transaction details"
          - "who is included?"
          
          Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const isTransactionInquiry =
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes";
      if (!isTransactionInquiry) return null;
    } catch (error) {
      this.logError("Failed to detect transaction inquiry", error);
      return null;
    }

    // Get transaction details from onboarding progress
    let receivers: any[] = [];
    if (userState.onboardingProgress?.splitData?.receivers) {
      receivers = userState.onboardingProgress.splitData.receivers;
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
      return `your group has ${receivers.length} fee receivers: ${receiverList}`;
    }

    return "your group creation transaction is ready to sign.";
  }

  /**
   * Clear pending transactions from other flows when starting onboarding
   * This prevents conflicts when users switch between different actions
   */
  private async clearCrossFlowTransactions(
    context: FlowContext
  ): Promise<void> {
    const { userState } = context;

    if (
      userState.pendingTransaction &&
      userState.pendingTransaction.type !== "group_creation"
    ) {
      const pendingTx = userState.pendingTransaction;

      this.log("Clearing cross-flow pending transaction", {
        userId: userState.userId,
        transactionType: pendingTx.type,
        reason: "User explicitly started onboarding",
      });

      // Clear the pending transaction and related progress SILENTLY
      await context.updateState({
        pendingTransaction: undefined,
        // Clear coin launch progress if it exists (user switching from coin launch to onboarding)
        coinLaunchProgress: undefined,
      });

      // NO USER MESSAGE - clearing should be invisible to the user
      // They just want to complete onboarding, not to hear about technical cleanup
    }
  }

  private async detectNewGroupCreation(
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
            content: `Does this message request to CREATE a new/additional group? "${messageText}" 
          
          Look for requests like:
          - "create another group"
          - "new group" 
          - "create new group"
          - "make another group"
          - "additional group"
          - "another group"
          - "create group" (when they already have one)
          - "make a group"
          - "setup another group"
          - "add another group"
          
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
      this.logError("Failed to detect new group creation intent", error);
      return false;
    }
  }

  private async detectFeeSplitModification(
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
            content: `Does this message request to MODIFY fee splits or fee distribution? "${messageText}" 
          
          Look for requests like:
          - "change the fee split"
          - "modify fee splits"
          - "update fee splits"
          - "adjust fee splits"
          - "give @user X%"
          - "change fee distribution"
          - "update fee distribution"
          - "adjust fee distribution"
          - "can I change the fee split"
          - "@user should get X%"
          - "split it differently"
          
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
      this.logError("Failed to detect fee split modification intent", error);
      return false;
    }
  }

  private async handleFeeSplitModification(
    context: FlowContext
  ): Promise<void> {
    const messageText = this.extractMessageText(context);
    const { userState } = context;

    if (!userState.pendingTransaction) {
      await this.sendResponse(context, "no pending transaction to modify.");
      return;
    }

    // Try to parse fee split modifications from the message
    try {
      const result = await GroupCreationUtils.createGroupFromMessage(
        context,
        getDefaultChain(),
        "Modify Fee Splits"
      );

      if (result && result.resolvedReceivers.length > 0) {
        // Update the pending transaction with new fee splits
        if (userState.pendingTransaction.type === "group_creation") {
          // Update onboarding progress with new receivers
          await context.updateState({
            onboardingProgress: {
              ...userState.onboardingProgress!,
              splitData: {
                receivers: result.resolvedReceivers,
                equalSplit: !result.resolvedReceivers.some((r) => r.percentage),
                creatorPercent: 0,
              },
            },
            pendingTransaction: {
              ...userState.pendingTransaction,
              timestamp: new Date(), // Update timestamp to show it was modified
            },
          });

          // Send new transaction with updated splits FIRST
          await context.conversation.send(
            result.walletSendCalls,
            ContentTypeWalletSendCalls
          );

          // Create message based on ACTUAL transaction data
          const response = await this.createTransactionMessage(
            context,
            result.walletSendCalls,
            result.resolvedReceivers,
            "updated"
          );

          await this.sendResponse(context, response);
        } else {
          await this.sendResponse(
            context,
            "fee split modifications for coin transactions not yet supported."
          );
        }
      } else {
        await this.sendResponse(
          context,
          "couldn't parse the fee split modification. please specify usernames and percentages."
        );
      }
    } catch (error) {
      this.logError("Fee split modification error", error);
      await this.sendResponse(
        context,
        "couldn't modify fee splits. please try again with clear usernames and percentages."
      );
    }
  }

  private async detectPercentageUpdate(
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
            content: `Does this message request to UPDATE/CHANGE the percentage of an existing receiver? "${messageText}" 
          
          Look for requests like:
          - "give [name] X%"
          - "set [name] to X%"
          - "[name] should get X%"
          - "give [name] 50%"
          - "make [name] 30%"
          - "change [name] to 25%"
          - "could you give [name] X%"
          - "can [name] get X%"
          
          This is different from adding new receivers - this is about changing existing percentages.
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
      this.logError("Failed to detect percentage update intent", error);
      return false;
    }
  }

  private async handlePercentageUpdate(
    context: FlowContext,
    messageText: string
  ): Promise<void> {
    try {
      // Get existing receivers from pending transaction
      const existingReceivers =
        context.userState.onboardingProgress?.splitData?.receivers || [];

      if (existingReceivers.length === 0) {
        await this.sendResponse(
          context,
          "no existing receivers to update. please create the group first."
        );
        return;
      }

      // Extract percentage updates from the message
      let extraction;
      try {
        extraction = await GroupCreationUtils.extractFeeReceivers(context);
      } catch (error) {
        this.logError("Failed to extract percentage updates", error);
        await this.sendResponse(
          context,
          "couldn't understand the percentage update. try something like 'give @alice 50%'."
        );
        return;
      }

      if (
        !extraction ||
        !extraction.receivers ||
        extraction.receivers.length === 0
      ) {
        await this.sendResponse(
          context,
          "couldn't find any percentage updates. try something like 'give @alice 50%'."
        );
        return;
      }

      // Resolve usernames to addresses
      let updatedReceivers;
      try {
        updatedReceivers = await GroupCreationUtils.resolveUsernames(
          context,
          extraction.receivers
        );
      } catch (error) {
        this.logError(
          "Failed to resolve usernames for percentage update",
          error
        );
        await this.sendResponse(
          context,
          "couldn't resolve usernames. please try again."
        );
        return;
      }

      // Check for resolution failures
      const failed = updatedReceivers.filter((r) => !r.resolvedAddress);
      if (failed.length > 0) {
        await this.sendResponse(
          context,
          `couldn't resolve these usernames: ${failed
            .map((r) => r.username)
            .join(", ")}`
        );
        return;
      }

      // Find receivers with specified percentages
      const receiversWithPercentage = updatedReceivers.filter(
        (r) => r.percentage !== undefined
      );

      if (receiversWithPercentage.length === 0) {
        await this.sendResponse(
          context,
          "no percentage specified. try something like 'give @alice 50%'."
        );
        return;
      }

      // Calculate total specified percentage
      const totalSpecifiedPercentage = receiversWithPercentage.reduce(
        (sum, r) => sum + (r.percentage || 0),
        0
      );

      if (totalSpecifiedPercentage >= 100) {
        await this.sendResponse(
          context,
          "specified percentage is too high. please use a lower percentage to leave room for other members."
        );
        return;
      }

      // Create final receiver list with updated percentages
      const finalReceivers = existingReceivers.map((existing) => {
        // Check if this receiver has a percentage update
        const update = receiversWithPercentage.find(
          (updated) =>
            updated.resolvedAddress?.toLowerCase() ===
              existing.resolvedAddress?.toLowerCase() ||
            (updated.username &&
              updated.username.toLowerCase() ===
                existing.username?.toLowerCase())
        );

        if (update) {
          return {
            ...existing,
            percentage: update.percentage,
          };
        }

        return existing;
      });

      // Calculate remaining percentage for receivers without explicit percentages
      const remainingPercentage = 100 - totalSpecifiedPercentage;
      const receiversWithoutPercentage = finalReceivers.filter(
        (r) =>
          !receiversWithPercentage.some(
            (updated) =>
              updated.resolvedAddress?.toLowerCase() ===
                r.resolvedAddress?.toLowerCase() ||
              (updated.username &&
                updated.username.toLowerCase() === r.username?.toLowerCase())
          )
      );

      const equalPercentage =
        receiversWithoutPercentage.length > 0
          ? remainingPercentage / receiversWithoutPercentage.length
          : 0;

      // Apply equal split to remaining receivers
      const redistributedReceivers = finalReceivers.map((receiver) => {
        const hasSpecificPercentage = receiversWithPercentage.some(
          (updated) =>
            updated.resolvedAddress?.toLowerCase() ===
              receiver.resolvedAddress?.toLowerCase() ||
            (updated.username &&
              updated.username.toLowerCase() ===
                receiver.username?.toLowerCase())
        );

        if (!hasSpecificPercentage) {
          return {
            ...receiver,
            percentage: equalPercentage,
          };
        }

        return receiver;
      });

      // Create transaction with updated percentages
      let walletSendCalls;
      try {
        walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          redistributedReceivers,
          context.creatorAddress,
          getDefaultChain(),
          "Update Group Percentages"
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes("Total shares") &&
          errorMessage.includes("do not equal required total")
        ) {
          await this.sendResponse(
            context,
            "error updating percentages - they don't add up to 100%. please try again."
          );
          return;
        } else {
          this.logError("Group deployment error in percentage update", error);
          await this.sendResponse(
            context,
            "couldn't update group percentages. please try again."
          );
          return;
        }
      }

      // Send new transaction FIRST
      await context.conversation.send(
        walletSendCalls,
        ContentTypeWalletSendCalls
      );

      // Update state with new percentages AFTER successful transaction send
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: {
            receivers: redistributedReceivers,
            equalSplit: false, // Percentages are now explicit
            creatorPercent: 0,
          },
        },
        pendingTransaction: {
          type: "group_creation",
          network: getDefaultChain().name,
          timestamp: new Date(),
        },
      });

      // Create message based on ACTUAL transaction data
      const response = await this.createTransactionMessage(
        context,
        walletSendCalls,
        redistributedReceivers,
        "updated"
      );

      await this.sendResponse(context, response);
    } catch (error) {
      this.logError("Failed to handle percentage update", error);
      await this.sendResponse(
        context,
        "couldn't update percentages. please try again."
      );
    }
  }

  /**
   * Extract receiver information from walletSendCalls transaction data
   * This ensures the message matches exactly what's being sent in the transaction
   */
  private extractReceiversFromTransaction(
    walletSendCalls: any,
    originalReceivers: any[]
  ): any[] {
    try {
      // For now, we'll use the original receivers as the source of truth
      // since they were used to create the transaction
      // In the future, we could decode the transaction data to extract the exact values

      // Validate that the transaction was created successfully
      if (
        !walletSendCalls ||
        !walletSendCalls.calls ||
        walletSendCalls.calls.length === 0
      ) {
        throw new Error("Invalid transaction structure");
      }

      // The transaction exists, so the receivers should match what was used to create it
      return originalReceivers;
    } catch (error) {
      this.logError("Failed to extract receivers from transaction", error);
      // Fallback to original receivers
      return originalReceivers;
    }
  }

  /**
   * Create a descriptive message based on actual transaction data
   */
  private async createTransactionMessage(
    context: FlowContext,
    walletSendCalls: any,
    receivers: any[],
    messageType: "created" | "updated" = "created"
  ): Promise<string> {
    // Extract receivers from the actual transaction
    const actualReceivers = this.extractReceiversFromTransaction(
      walletSendCalls,
      receivers
    );

    // Use shared utility for consistent message formatting
    const baseMessage = GroupCreationUtils.createTransactionMessage(
      actualReceivers,
      messageType
    );

    // Add character personality with OpenAI
    return await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Rewrite this transaction message with your personality: "${baseMessage}"
        Keep it brief and encouraging but maintain all the technical details.
      `,
    });
  }

  /**
   * Detect if the user is asking about existing receivers
   */
  private async detectExistingReceiversInquiry(
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
            content: `Is this message asking about existing/current receivers or group members? "${messageText}" 
          
          Look for questions like:
          - "who are the existing receivers?"
          - "who are the current receivers?"
          - "show me current receivers"
          - "what are the current percentages?"
          - "who's in the group?"
          - "show current group"
          - "who gets fees currently?"
          - "current setup?"
          
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
      this.logError("Failed to detect existing receivers inquiry", error);
      return false;
    }
  }

  /**
   * Handle inquiry about existing receivers
   */
  private async handleExistingReceiversInquiry(
    context: FlowContext
  ): Promise<void> {
    const existingReceivers =
      context.userState.onboardingProgress?.splitData?.receivers || [];

    if (existingReceivers.length === 0) {
      await this.sendResponse(
        context,
        "no receivers set yet. specify who should receive trading fees by tagging usernames (@alice) or using addresses."
      );
      return;
    }

    // Format the current receivers list
    let message = `current receivers for your group:\n\n`;

    for (const receiver of existingReceivers) {
      const displayName =
        receiver.username && receiver.username.startsWith("@")
          ? receiver.username
          : `${receiver.resolvedAddress?.slice(
              0,
              6
            )}...${receiver.resolvedAddress?.slice(-4)}`;

      const percentage = receiver.percentage
        ? ` (${receiver.percentage.toFixed(1)}%)`
        : " (equal split)";

      message += `• ${displayName}${percentage}\n`;
    }

    message += `\nyou can modify these by saying things like "give @alice 50%" or "add @bob" or create a new group entirely.`;

    await this.sendResponse(context, message);
  }

  /**
   * Detect if the user wants to remove someone from the fee receivers
   */
  private async detectRemovalRequest(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;
    
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
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
          
          Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      return response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    } catch (error) {
      this.logError('Failed to detect removal request', error);
      return false;
    }
  }

  /**
   * Handle removal of specific receivers from the fee receiver list
   */
  private async handleReceiverRemoval(context: FlowContext, messageText: string, existingReceivers: any[]): Promise<void> {
    // Extract usernames/addresses to remove
    const usersToRemove = await this.extractUsersToRemove(context, messageText);
    
    if (usersToRemove.length === 0) {
      await this.sendResponse(context, "couldn't understand who to remove. please specify usernames like '@alice' or 'nobi'.");
      return;
    }

    // Resolve usernames to addresses for matching
    const resolvedUsersToRemove = await this.resolveUsersToRemove(context, usersToRemove);
    
    if (resolvedUsersToRemove.length === 0) {
      await this.sendResponse(context, `couldn't resolve these usernames: ${usersToRemove.join(', ')}`);
      return;
    }

    // Filter out the users to remove
    const updatedReceivers = existingReceivers.filter(receiver => {
      const shouldRemove = resolvedUsersToRemove.some(userToRemove => {
        // Match by resolved address
        if (receiver.resolvedAddress && userToRemove.resolvedAddress) {
          return receiver.resolvedAddress.toLowerCase() === userToRemove.resolvedAddress.toLowerCase();
        }
        
        // Match by username (case-insensitive)
        if (receiver.username && userToRemove.username) {
          return receiver.username.toLowerCase() === userToRemove.username.toLowerCase();
        }
        
        return false;
      });
      
      return !shouldRemove;
    });

    // Check if any users were actually removed
    if (updatedReceivers.length === existingReceivers.length) {
      const userList = resolvedUsersToRemove.map(u => u.username).join(', ');
      await this.sendResponse(context, `couldn't find ${userList} in the current receiver list.`);
      return;
    }

    // Check if all users would be removed
    if (updatedReceivers.length === 0) {
      await this.sendResponse(context, "cannot remove all receivers. at least one fee receiver is required.");
      return;
    }

    // Redistribute percentages equally among remaining receivers
    const equalPercentage = 100 / updatedReceivers.length;
    const finalReceivers = updatedReceivers.map(receiver => ({
      ...receiver,
      percentage: equalPercentage
    }));

    // Create new transaction with updated receivers
    try {
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        finalReceivers,
        context.creatorAddress,
        getDefaultChain(),
        "Remove Group Members"
      );

      // Send transaction FIRST
      await context.conversation.send(
        walletSendCalls,
        ContentTypeWalletSendCalls
      );

      // Update onboarding progress AFTER successful transaction send
      await context.updateState({
        onboardingProgress: {
          ...context.userState.onboardingProgress!,
          splitData: {
            receivers: finalReceivers,
            equalSplit: true, // Since we redistributed equally
            creatorPercent: 0,
          },
        },
        pendingTransaction: {
          type: "group_creation",
          network: getDefaultChain().name,
          timestamp: new Date(),
        },
      });

      // Create response message
      const removedUsernames = resolvedUsersToRemove.map(u => u.username).join(', ');
      const response = await GroupCreationUtils.createTransactionMessageWithENS(
        finalReceivers,
        `removed ${removedUsernames} from`,
        context.ensResolver
      );

      await this.sendResponse(context, response);
    } catch (error) {
      this.logError('Failed to create transaction after removal', error);
      await this.sendResponse(context, 'failed to update transaction. please try again.');
    }
  }

  /**
   * Extract users to remove from the message
   */
  private async extractUsersToRemove(context: FlowContext, messageText: string): Promise<string[]> {
    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Extract usernames or identifiers to remove from this message: "${messageText}"
          
          Look for:
          - @username patterns like "@alice", "@bob"
          - ENS names like "alice.eth", "bob.eth"
          - Simple usernames like "alice", "bob", "nobi"
          - Ethereum addresses like "0x123..."
          
          Return ONLY a JSON array of the identifiers to remove:
          ["@alice", "bob", "charlie.eth"]
          
          If no identifiers found, return: []`
        }],
        temperature: 0.1,
        max_tokens: 100
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return [];

      try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        this.logError('Failed to parse removal extraction result', error);
        return [];
      }
    } catch (error) {
      this.logError('Failed to extract users to remove', error);
      return [];
    }
  }

  /**
   * Resolve usernames to addresses for removal matching
   */
  private async resolveUsersToRemove(context: FlowContext, usersToRemove: string[]): Promise<Array<{username: string, resolvedAddress?: string}>> {
    const resolved = [];
    
    for (const user of usersToRemove) {
      let resolvedAddress: string | undefined;
      
      // Clean up the username
      const cleanUsername = user.startsWith('@') ? user.slice(1) : user;
      
      // Try to resolve to address
      try {
        if (cleanUsername.startsWith('0x') && cleanUsername.length === 42) {
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
        resolvedAddress
      });
    }
    
    return resolved.filter(r => r.resolvedAddress || r.username);
  }

  /**
   * Detect if the user wants to completely replace the current group with a new one
   */
  private async detectGroupCreationInMessage(
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
            content: `Does this message contain a request to create a group or add specific people to a group?

Message: "${messageText}"

Look for patterns like:
- "create a group for me and @user"
- "launch a group for me and @user" 
- "add me and @user to a group"
- "make a group with @user1 and @user2"
- "@user1 @user2 let's create a group"
- Any message that mentions usernames/addresses and group creation

Answer only "yes" or "no".`,
          },
        ],
        temperature: 0.1,
        max_tokens: 5,
      });

      const result =
        response.choices[0]?.message?.content?.trim().toLowerCase() === "yes";

      console.log(
        `[OnboardingFlow] Group creation detection: "${messageText}" -> ${result}`
      );
      return result;
    } catch (error) {
      console.error("Failed to detect group creation in message:", error);
      return false;
    }
  }

  private async detectCompleteGroupReplacement(
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
            content: `Does this message request to REPLACE all existing receivers with a new complete group? "${messageText}" 
          
          Look for messages that specify multiple users (3+) with splitting instructions:
          - "ok add user1, user2, user3, user4 equal split"
          - "make it user1, user2, user3 all equal"
          - "change to user1, user2, user3, user4 equal split"
          - "replace with user1, user2, user3 equal"
          - "new group: user1, user2, user3 equal split"
          - "let's do user1, user2, user3, user4 all equal"
          
          This is NOT a replacement (these are additions):
          - "add user1" (single user)
          - "also add user1 and user2" (small addition)
          - "include user1" (single addition)
          
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
        "Failed to detect complete group replacement intent",
        error
      );
      return false;
    }
  }

  private async handleGreeting(context: FlowContext): Promise<void> {
    const { userState, conversation } = context;

    // Determine appropriate greeting response based on user state
    let greetingPrompt = "";

    if (userState.groups.length === 0) {
      // User has no groups - needs to create first group

      // check if this is a direct message
      const members = await conversation.members();
      const memberCount = members ? members.length : 0;
      const isDirectMessage = memberCount === 2;

      greetingPrompt = `
        Give a warm, friendly greeting that acknowledges their hello and explains what comes next.
        
        Explain that:
        ${
          isDirectMessage
            ? "- First & foremost inform the user that while they can launch coins on their own (the user is in a direct message with you), they can also add @flaunchy to a group chat to split fees with friends (follow this with a line break with the rest of the response)"
            : ""
        }
        - You help them launch coins and earn passive income from trading fees
        - First step is creating a group to split fees with friends
        - They can @ mention friends or create it just for themselves
        
        Keep it conversational and welcoming. Use your character's voice.
      `;
    } else if (userState.coins.length === 0) {
      // User has groups but no coins - needs to launch first coin
      greetingPrompt = `
        Give a warm greeting that acknowledges their hello and reminds them of next steps.
        
        Mention that:
        - Their group is set up and ready
        - Now they can launch their first coin for free
        - What coin would they like to create?
        
        Keep it friendly and encouraging. Use your character's voice.
      `;
    } else {
      // User has both groups and coins - shouldn't be in onboarding
      greetingPrompt = `
        Give a friendly greeting acknowledging their hello.
        
        Briefly mention they're all set up and can:
        - Launch more coins
        - Create additional groups  
        - Ask questions anytime
        
        Keep it warm and conversational. Use your character's voice.
      `;
    }

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: greetingPrompt,
    });

    await this.sendResponse(context, response);
  }

  // =============================================================================
  // ACTION INTENT PRIORITIZATION SYSTEM
  // =============================================================================

  /**
   * Determines if a detection result contains a high-priority action intent
   * that should override greetings and be processed immediately
   * 
   * This mirrors the logic in FlowRouter for consistency
   */
  private isHighPriorityActionIntent(detectionResult: any): boolean {
    // High-priority action intents with sufficient confidence
    const highPriorityActions = ['create_group', 'launch_coin', 'modify_existing'];
    const isHighPriorityAction = highPriorityActions.includes(detectionResult.actionType);
    const hasSufficientConfidence = detectionResult.confidence >= 0.8;
    
    // Specific high-priority flags
    const hasHighPriorityFlags = detectionResult.isGroupForEveryone || 
                                detectionResult.isAddEveryone || 
                                detectionResult.isNewGroupCreation ||
                                detectionResult.isGroupCreationResponse;
    
    return (isHighPriorityAction && hasSufficientConfidence) || hasHighPriorityFlags;
  }
}

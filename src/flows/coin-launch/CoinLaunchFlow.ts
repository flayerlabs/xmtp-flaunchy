import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { createFlaunchTransaction } from "../utils/FlaunchTransactionUtils";
import { getCharacterResponse } from "../../../utils/character";
import { getDefaultChain } from "../utils/ChainSelection";
import { safeParseJSON } from "../../core/utils/jsonUtils";
import { createCoinLaunchExtractionPrompt } from "./coinLaunchExtractionTemplate";
import { CoinLaunchExtractionResult } from "./coinLaunchExtractionTemplate";
import { GraphQLService } from "../../services/GraphQLService";
import { AddressFeeSplitManagerAddress } from "../../../addresses";
import { encodeAbiParameters } from "viem";
import { Address } from "viem";

interface CoinLaunchData {
  name?: string;
  ticker?: string;
  image?: string; // Still optional during extraction, required before launch
  targetGroup?: string;
  // Launch parameters
  startingMarketCap?: number;
  fairLaunchDuration?: number;
  premineAmount?: number;
  buybackPercentage?: number;
}

interface ManagerInfo {
  address: string;
  isFirstLaunch: boolean;
  initializeData?: string;
  feeRecipients?: Array<{
    address: string;
    displayName: string;
    percentage: number;
  }>;
}

export class CoinLaunchFlow extends BaseFlow {
  private graphqlService: GraphQLService;

  constructor() {
    super("coin_launch");
    this.graphqlService = new GraphQLService();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { participantState } = context;

    // Clear any cross-flow transactions first
    await this.clearCrossFlowTransactions(context);

    // Check if user has a pending transaction first
    if (participantState.pendingTransaction) {
      const handled = await this.handlePendingTransactionUpdate(context);
      if (handled) return;
    }

    // Handle specific inquiry types
    if (await this.isLaunchOptionsInquiry(context)) {
      await this.handleLaunchOptionsInquiry(context);
      return;
    }

    if (await this.isFutureFeatureInquiry(context)) {
      await this.handleFutureFeatureInquiry(context);
      return;
    }

    if (await this.isLaunchDefaultsInquiry(context)) {
      await this.handleLaunchDefaultsInquiry(context);
      return;
    }

    if (await this.isStatusInquiry(context)) {
      await this.handleStatusInquiry(context);
      return;
    }

    if (await this.isLaunchCommand(context)) {
      await this.handleLaunchCommand(context);
      return;
    }

    // Process coin launch request
    if (participantState.coinLaunchProgress) {
      await this.continueFromProgress(context);
    } else {
      await this.startNewCoinLaunch(context);
    }
  }

  private async handlePendingTransactionUpdate(
    context: FlowContext
  ): Promise<boolean> {
    const { participantState } = context;
    const messageText = this.extractMessageText(context);

    if (participantState.pendingTransaction) {
      const txParams = participantState.pendingTransaction;
      const coinData = txParams.coinData;
      const launchParams = txParams.launchParameters;

      const isSuccess = /(?:success|complete|done|finished|confirm)/i.test(
        messageText
      );
      const isFailure = /(?:fail|error|problem|issue)/i.test(messageText);

      if (isSuccess) {
        // Store the coin in group state if it was a successful launch
        if (launchParams?.targetGroupId && coinData) {
          // Add coin to group state
          const coinToAdd = {
            ticker: coinData.ticker,
            name: coinData.name,
            image: coinData.image,
            contractAddress: launchParams.targetGroupId, // Will be updated with actual contract address
            txHash: "", // Will be updated with actual tx hash
            launchedAt: new Date(),
            launchedBy: context.creatorAddress,
            chainId: getDefaultChain().id,
            chainName: getDefaultChain().name,
            fairLaunchDuration: launchParams.fairLaunchDuration || 30,
            fairLaunchPercent: 10,
            initialMarketCap: launchParams.startingMarketCap || 1000,
            managerAddress: launchParams.targetGroupId,
          };

          await context.sessionManager.addCoinToGroup(
            context.groupId,
            coinToAdd
          );
        }

        // Clear pending transaction and coin launch progress
        await context.updateParticipantState({
          pendingTransaction: undefined,
          coinLaunchProgress: undefined,
        });

        // Send success message
        await this.sendResponse(
          context,
          `🎉 $${coinData?.ticker} is now live! everyone in this chat group will share the trading fees. congrats!`
        );

        this.log("Coin launch successful", {
          participantAddress: context.creatorAddress,
          coinName: coinData?.name,
          ticker: coinData?.ticker,
          managerAddress: launchParams?.targetGroupId,
        });

        return true;
      } else if (isFailure) {
        // Transaction failed - offer to retry
        await this.sendResponse(
          context,
          `transaction failed. want to try again? just confirm and i'll resend the transaction.`
        );
        return true;
      }
    }

    // Check if they want to retry/rebuild the transaction
    const wantsRetry = /(?:retry|again|resend|rebuild|try|yes|confirm)/i.test(
      messageText
    );
    if (wantsRetry && participantState.pendingTransaction) {
      const coinData = participantState.pendingTransaction.coinData;
      const launchParams = participantState.pendingTransaction.launchParameters;

      if (!coinData || !launchParams) {
        await this.sendResponse(
          context,
          "couldn't retrieve transaction data. let me restart the coin launch process."
        );
        await context.updateParticipantState({
          pendingTransaction: undefined,
          coinLaunchProgress: undefined,
        });
        return true;
      }

      // Get manager address for this chat group
      const managerInfo = await this.getChatRoomManagerAddress(context);

      // Rebuild the transaction with the coin data from pending transaction
      const fullCoinData = {
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        targetGroup: managerInfo.address,
        startingMarketCap: launchParams.startingMarketCap,
        fairLaunchDuration: launchParams.fairLaunchDuration,
        premineAmount: launchParams.premineAmount,
        buybackPercentage: launchParams.buybackPercentage,
      } as Required<CoinLaunchData>;

      await this.rebuildAndSendTransaction(
        context,
        fullCoinData,
        managerInfo.address
      );
      return true;
    }

    return false;
  }

  public async rebuildAndSendTransaction(
    context: FlowContext,
    coinData: Required<CoinLaunchData>,
    managerAddress: string
  ): Promise<void> {
    try {
      // Use default chain (no chain switching)
      const selectedChain = getDefaultChain();

      // Calculate creator fee allocation based on buyback percentage
      let creatorFeeAllocationPercent = 100;
      if (coinData.buybackPercentage) {
        // If buybacks are enabled, creator gets reduced share
        creatorFeeAllocationPercent = 100 - coinData.buybackPercentage;
      }

      // For rebuild, we always use the existing manager address (no initializeData needed)
      const walletSendCalls = await createFlaunchTransaction({
        name: coinData.name,
        ticker: coinData.ticker,
        image: coinData.image,
        creatorAddress: context.creatorAddress,
        senderInboxId: context.senderInboxId,
        chain: selectedChain,
        treasuryManagerAddress: managerAddress,
        treasuryInitializeData: "0x", // Rebuilds always use existing manager
        processImageAttachment: context.processImageAttachment,
        hasAttachment: context.hasAttachment,
        attachment: context.attachment,
        ensResolver: context.ensResolver,
        // Pass extracted launch parameters
        startingMarketCapUSD: coinData.startingMarketCap || 1000,
        fairLaunchDuration: (coinData.fairLaunchDuration || 30) * 60, // Convert to seconds
        fairLaunchPercent: 10, // Keep default for now
        creatorFeeAllocationPercent,
        preminePercentage: coinData.premineAmount || 0,
      });

      // Send transaction
      await context.conversation.send(
        walletSendCalls,
        ContentTypeWalletSendCalls
      );

      // Get manager info to display fee split
      const managerInfo = await this.getChatRoomManagerAddress(context);

      // Confirmation message with fee split info
      let confirmationMessage = `rebuilding transaction for $${coinData.ticker}! sign to launch.`;

      // Add fee split information
      if (managerInfo.feeRecipients && managerInfo.feeRecipients.length > 0) {
        const recipients = managerInfo.feeRecipients;
        const equalPercentage = recipients[0].percentage; // They should all have equal percentages

        // TODO: not responding with the recipients for now (CBW issue)
        confirmationMessage += `\n\nFees will be split ${equalPercentage}% equally between ${recipients.length} receivers.`;
        // recipients.forEach((recipient, index) => {
        //   confirmationMessage += `\n${index + 1}. ${recipient.displayName}`;
        // });
      }

      await this.sendResponse(context, confirmationMessage);

      // Update pending transaction timestamp
      const { participantState } = context;
      await context.updateParticipantState({
        pendingTransaction: {
          ...participantState.pendingTransaction!,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      console.error("[CoinLaunch] ❌ Error rebuilding transaction:", error);
      await this.sendResponse(
        context,
        `error rebuilding transaction for ${coinData.name} (${coinData.ticker}). try again.`
      );
    }
  }

  private async clearCrossFlowTransactions(
    context: FlowContext
  ): Promise<void> {
    const { participantState } = context;

    // Clear any pending transactions that aren't coin_creation
    if (
      participantState.pendingTransaction &&
      participantState.pendingTransaction.type !== "coin_creation"
    ) {
      await context.updateParticipantState({
        pendingTransaction: undefined,
      });
    }
  }

  private async continueFromProgress(context: FlowContext): Promise<void> {
    const { participantState } = context;
    const progress = participantState.coinLaunchProgress!;

    // SPECIAL CASE: If we're in collecting_coin_data step and user sends only attachment
    // (no meaningful text), handle it as providing the missing image
    if (
      progress.step === "collecting_coin_data" &&
      context.hasAttachment &&
      (!context.messageText ||
        context.messageText.trim().length === 0 ||
        context.messageText.trim() === "...")
    ) {
      console.log(
        "🖼️ Handling attachment-only message during collecting_coin_data step"
      );

      // Update the image data directly since we know they're providing the missing image
      progress.coinData = progress.coinData || {};
      progress.coinData.image = "attachment_provided";

      // Update the progress
      await context.updateParticipantState({ coinLaunchProgress: progress });

      // Send acknowledgment
      await this.sendResponse(context, "got the image! 📸");

      // Check if we now have all required data
      const coinData = progress.coinData;
      const hasAll = coinData.name && coinData.ticker && coinData.image;

      if (hasAll) {
        // Get manager info and launch
        const managerInfo = await this.getChatRoomManagerAddress(context);
        const fullCoinData = {
          ...coinData,
          startingMarketCap: progress.launchParameters?.startingMarketCap,
          fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
          premineAmount: progress.launchParameters?.premineAmount,
          buybackPercentage: progress.launchParameters?.buybackPercentage,
          targetGroup: managerInfo.address,
        } as Required<CoinLaunchData>;

        await this.launchCoin(context, fullCoinData);
        return;
      } else {
        // Still missing other data
        await this.requestMissingData(context, coinData);
        return;
      }
    }

    // Extract additional data from the current message
    const currentData = await this.extractCoinData(context);
    let updated = false;
    let parameterUpdates: string[] = [];

    progress.coinData = progress.coinData || {};

    // Update with any new data found
    if (currentData.name && currentData.name !== progress.coinData.name) {
      progress.coinData.name = currentData.name;
      updated = true;
    }
    if (currentData.ticker && currentData.ticker !== progress.coinData.ticker) {
      progress.coinData.ticker = currentData.ticker;
      updated = true;
    }
    if (currentData.image && currentData.image !== progress.coinData.image) {
      progress.coinData.image = currentData.image;
      updated = true;
    }

    // Handle launch parameter updates
    progress.launchParameters = progress.launchParameters || {};
    if (
      currentData.startingMarketCap &&
      currentData.startingMarketCap !==
        progress.launchParameters.startingMarketCap
    ) {
      progress.launchParameters.startingMarketCap =
        currentData.startingMarketCap;
      parameterUpdates.push(
        `starting market cap to $${currentData.startingMarketCap}`
      );
      updated = true;
    }
    if (
      currentData.fairLaunchDuration &&
      currentData.fairLaunchDuration !==
        progress.launchParameters.fairLaunchDuration
    ) {
      progress.launchParameters.fairLaunchDuration =
        currentData.fairLaunchDuration;
      parameterUpdates.push(
        `fair launch duration to ${currentData.fairLaunchDuration} minutes`
      );
      updated = true;
    }
    if (
      currentData.premineAmount &&
      currentData.premineAmount !== progress.launchParameters.premineAmount
    ) {
      progress.launchParameters.premineAmount = currentData.premineAmount;
      parameterUpdates.push(`prebuy to ${currentData.premineAmount}%`);
      updated = true;
    }
    if (
      currentData.buybackPercentage &&
      currentData.buybackPercentage !==
        progress.launchParameters.buybackPercentage
    ) {
      progress.launchParameters.buybackPercentage =
        currentData.buybackPercentage;
      parameterUpdates.push(`buybacks to ${currentData.buybackPercentage}%`);
      updated = true;
    }

    if (updated) {
      await context.updateParticipantState({ coinLaunchProgress: progress });
    }

    // If parameter updates were made, acknowledge them naturally
    if (parameterUpdates.length > 0) {
      const updateMessage = `got it! updated ${parameterUpdates.join(
        " and "
      )}.`;
      await this.sendResponse(context, updateMessage);

      console.log(
        `[CoinLaunch] ✅ Parameters updated: ${parameterUpdates.join(", ")}`
      );
    }

    // Check if we have all required data
    const coinData = progress.coinData || {};
    const hasAll = coinData.name && coinData.ticker && coinData.image;
    if (hasAll) {
      // Get manager info - this will handle first launch vs subsequent launch logic
      const managerInfo = await this.getChatRoomManagerAddress(context);

      // Merge coin data with launch parameters from progress
      const fullCoinData = {
        ...coinData,
        startingMarketCap: progress.launchParameters?.startingMarketCap,
        fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
        premineAmount: progress.launchParameters?.premineAmount,
        buybackPercentage: progress.launchParameters?.buybackPercentage,
        targetGroup: managerInfo.address,
      } as Required<CoinLaunchData>;

      await this.launchCoin(context, fullCoinData);
      return;
    }

    // Still missing data - request it
    await this.requestMissingData(context, coinData);
  }

  private async startNewCoinLaunch(context: FlowContext): Promise<void> {
    // Extract coin data from message
    const extractedData = await this.extractCoinData(context);

    // Separate coin data from launch parameters
    const coinData = {
      name: extractedData.name,
      ticker: extractedData.ticker,
      image: extractedData.image,
    };

    const launchParameters = {
      startingMarketCap: extractedData.startingMarketCap,
      fairLaunchDuration: extractedData.fairLaunchDuration,
      premineAmount: extractedData.premineAmount,
      buybackPercentage: extractedData.buybackPercentage,
    };

    // Initialize progress with separated data
    const progress: any = {
      step: "collecting_coin_data" as const,
      coinData,
      launchParameters,
      startedAt: new Date(),
    };

    // Save progress
    await context.updateParticipantState({ coinLaunchProgress: progress });

    // Check if we have everything
    if (coinData.name && coinData.ticker && coinData.image) {
      // Get manager info - this will handle first launch vs subsequent launch logic
      const managerInfo = await this.getChatRoomManagerAddress(context);

      // Merge coin data with launch parameters for launch
      const fullCoinData = {
        ...coinData,
        ...launchParameters,
        targetGroup: managerInfo.address,
      } as Required<CoinLaunchData>;

      await this.launchCoin(context, fullCoinData);
    } else {
      await this.requestMissingData(context, coinData);
    }
  }

  private async getChatRoomManagerAddress(
    context: FlowContext
  ): Promise<ManagerInfo> {
    // Always get current group members first to check for changes
    const { initializeData, feeRecipients: currentFeeRecipients } =
      await this.createInitializeDataForChatRoom(context);

    // Check if we already have a manager for this group
    const groupState = await context.sessionManager.getGroupChatState(
      context.groupId
    );

    if (groupState && groupState.managers.length > 0) {
      // Get the latest manager (most recent one)
      const existingManager =
        groupState.managers[groupState.managers.length - 1];

      // Fetch fee recipients for existing manager
      const existingFeeRecipients =
        await this.fetchExistingManagerFeeRecipients(
          context,
          existingManager.contractAddress
        );

      // Compare addresses (not percentages) to check if group membership has changed
      const currentAddresses = new Set(
        currentFeeRecipients.map((fr) => fr.address.toLowerCase())
      );
      const existingAddresses = new Set(
        existingFeeRecipients.map((fr) => fr.address.toLowerCase())
      );

      // Check if all addresses match
      const addressesMatch =
        currentAddresses.size === existingAddresses.size &&
        [...currentAddresses].every((addr) => existingAddresses.has(addr));

      if (addressesMatch) {
        this.log(
          "Using existing manager address for group - members unchanged",
          {
            groupId: context.groupId,
            managerAddress: existingManager.contractAddress,
            memberCount: currentAddresses.size,
          }
        );

        return {
          address: existingManager.contractAddress,
          isFirstLaunch: false,
          feeRecipients: existingFeeRecipients,
        };
      } else {
        this.log("Group membership changed - creating new manager", {
          groupId: context.groupId,
          currentMembers: currentAddresses.size,
          existingMembers: existingAddresses.size,
          addedMembers: [...currentAddresses].filter(
            (addr) => !existingAddresses.has(addr)
          ),
          removedMembers: [...existingAddresses].filter(
            (addr) => !currentAddresses.has(addr)
          ),
        });

        // Return initializeData for new manager since group membership changed
        const selectedChain = getDefaultChain();
        const implementationAddress =
          AddressFeeSplitManagerAddress[selectedChain.id];

        return {
          address: implementationAddress,
          isFirstLaunch: true,
          initializeData,
          feeRecipients: currentFeeRecipients,
        };
      }
    }

    // For first coin launch in this group, use the AddressFeeSplitManager implementation
    // and create initializeData with all chat room members as fee recipients
    const selectedChain = getDefaultChain();
    const implementationAddress =
      AddressFeeSplitManagerAddress[selectedChain.id];

    this.log(
      "First coin launch in group - creating initializeData with all chat members",
      {
        groupId: context.groupId,
        implementationAddress,
        chainId: selectedChain.id,
      }
    );

    return {
      address: implementationAddress,
      isFirstLaunch: true,
      initializeData,
      feeRecipients: currentFeeRecipients,
    };
  }

  private async fetchExistingManagerFeeRecipients(
    context: FlowContext,
    managerAddress: string
  ): Promise<
    Array<{ address: string; displayName: string; percentage: number }>
  > {
    try {
      // Query the manager data from GraphQL
      const groupData = await this.graphqlService.fetchSingleGroupData(
        managerAddress
      );

      if (
        !groupData ||
        !groupData.recipients ||
        groupData.recipients.length === 0
      ) {
        console.log(
          `[CoinLaunch] No recipients found for manager ${managerAddress} in GraphQL, trying group state fallback`
        );

        // Fallback to group state data
        try {
          const groupState = await context.sessionManager.getGroupChatState(
            context.groupId
          );

          if (groupState && groupState.managers.length > 0) {
            // Find the manager that matches the address
            const manager = groupState.managers.find(
              (m) =>
                m.contractAddress.toLowerCase() === managerAddress.toLowerCase()
            );

            if (manager && manager.receivers && manager.receivers.length > 0) {
              console.log(
                `[CoinLaunch] Using group state data for manager ${managerAddress}`
              );

              // Resolve addresses to display names
              const addresses = manager.receivers.map(
                (receiver) => receiver.resolvedAddress
              );
              const resolvedNames = await context.ensResolver.resolveAddresses(
                addresses
              );

              // Return fee recipients from group state
              return manager.receivers.map((receiver) => ({
                address: receiver.resolvedAddress,
                displayName:
                  resolvedNames.get(receiver.resolvedAddress.toLowerCase()) ||
                  receiver.username ||
                  `${receiver.resolvedAddress.slice(
                    0,
                    6
                  )}...${receiver.resolvedAddress.slice(-4)}`,
                percentage: receiver.percentage,
              }));
            }
          }
        } catch (error) {
          console.error(
            `[CoinLaunch] Error accessing group state for manager ${managerAddress}:`,
            error
          );
        }

        console.log(
          `[CoinLaunch] No fee recipients found in either GraphQL or group state for manager ${managerAddress}`
        );
        return [];
      }

      // Calculate total shares
      const totalShares = groupData.recipients.reduce(
        (sum, recipient) => sum + BigInt(recipient.recipientShare),
        0n
      );

      // Get all recipient addresses for ENS resolution
      const recipientAddresses = groupData.recipients.map(
        (recipient) => recipient.recipient
      );

      // Add creator address (it's not in recipients but gets fees)
      recipientAddresses.push(context.creatorAddress);

      // Resolve addresses to display names
      const resolvedNames = await context.ensResolver.resolveAddresses(
        recipientAddresses
      );

      // Build fee recipients array
      const feeRecipients: Array<{
        address: string;
        displayName: string;
        percentage: number;
      }> = [];

      // Add creator (always gets fees in this setup)
      const creatorPercentage = 100 / (groupData.recipients.length + 1); // Equal split
      feeRecipients.push({
        address: context.creatorAddress,
        displayName:
          resolvedNames.get(context.creatorAddress.toLowerCase()) ||
          `${context.creatorAddress.slice(
            0,
            6
          )}...${context.creatorAddress.slice(-4)}`,
        percentage: Math.round(creatorPercentage * 100) / 100,
      });

      // Add other recipients
      for (const recipient of groupData.recipients) {
        const sharePercentage =
          (Number(recipient.recipientShare) / Number(totalShares)) * 100;
        feeRecipients.push({
          address: recipient.recipient,
          displayName:
            resolvedNames.get(recipient.recipient.toLowerCase()) ||
            `${recipient.recipient.slice(0, 6)}...${recipient.recipient.slice(
              -4
            )}`,
          percentage: Math.round(sharePercentage * 100) / 100,
        });
      }

      return feeRecipients;
    } catch (error) {
      console.error(
        `[CoinLaunch] Error fetching fee recipients for manager ${managerAddress}:`,
        error
      );
      return [];
    }
  }

  private async createInitializeDataForChatRoom(context: FlowContext): Promise<{
    initializeData: string;
    feeRecipients: Array<{
      address: string;
      displayName: string;
      percentage: number;
    }>;
  }> {
    try {
      // Get all chat room members
      const members = await context.conversation.members();
      const feeReceivers: Address[] = [];

      // console.log(`Found ${members.length} total members in the chat room`);
      // console.log(`Chat room members analysis:`);
      // console.log(`- Bot InboxId: ${context.client.inboxId}`);

      for (const member of members) {
        // console.log(`Processing member: ${member.inboxId}`);

        // Skip the sender (coin creator) and the bot
        if (
          member.inboxId !== context.client.inboxId &&
          member.inboxId !== context.senderInboxId
        ) {
          // Get the address for this member
          const memberInboxState =
            await context.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0]
              .identifier as Address;
            feeReceivers.push(memberAddress);
            // console.log(`  → Added fee receiver: ${memberAddress}`);
          } else {
            // console.log(
            //   `  → Could not get address for member ${member.inboxId}`
            // );
          }
        } else {
          const reason =
            member.inboxId === context.client.inboxId ? "bot" : "creator";
          // console.log(`  → Skipping member ${member.inboxId} (${reason})`);
        }
      }

      // console.log(
      //   `Total fee receivers before deduplication: ${feeReceivers.length}`
      // );
      // console.log(`Fee receiver addresses before deduplication:`, feeReceivers);

      // Deduplicate fee receivers - get unique addresses (case-insensitive)
      const uniqueFeeReceivers = [
        ...new Set(feeReceivers.map((addr) => addr.toLowerCase() as Address)),
      ];

      const VALID_SHARE_TOTAL = 100_00000n; // 100.00000% in contract format (5 decimals)

      // Calculate equal shares for all participants (creator + receivers)
      const totalRecipients = BigInt(uniqueFeeReceivers.length);
      const totalParticipants = totalRecipients + 1n; // +1 for creator

      // Creator gets 1/(n+1) of total fees
      const creatorShare = VALID_SHARE_TOTAL / totalParticipants;
      const creatorRemainder = VALID_SHARE_TOTAL % totalParticipants;
      const adjustedCreatorShare = creatorShare + creatorRemainder; // Add remainder to creator

      // Recipients array must sum to 100% - each recipient gets equal share of this
      const sharePerRecipient = VALID_SHARE_TOTAL / totalRecipients;
      const remainder = VALID_SHARE_TOTAL % totalRecipients;

      // console.log(
      //   `Total fee receivers after deduplication: ${uniqueFeeReceivers.length}`
      // );
      // console.log(
      //   `Equal distribution: each participant gets ${(
      //     (Number(VALID_SHARE_TOTAL / totalParticipants) /
      //       Number(VALID_SHARE_TOTAL)) *
      //     100
      //   ).toFixed(5)}%`
      // );

      // Generate initialize data for the fee split manager using deduplicated addresses
      const recipientShares = uniqueFeeReceivers.map((receiver, index) => ({
        recipient: receiver,
        share: sharePerRecipient + (index === 0 ? remainder : 0n), // Add remainder to first recipient
      }));

      // Verify total recipient shares equal 100%
      const totalRecipientShares = recipientShares.reduce(
        (sum, rs) => sum + rs.share,
        0n
      );
      if (totalRecipientShares !== VALID_SHARE_TOTAL) {
        throw new Error(
          `Recipient shares total ${totalRecipientShares} but should be ${VALID_SHARE_TOTAL}`
        );
      }

      // console.log(
      //   `Creator share: ${adjustedCreatorShare.toString()} (${(
      //     (Number(adjustedCreatorShare) / Number(VALID_SHARE_TOTAL)) *
      //     100
      //   ).toFixed(5)}%)`
      // );
      // console.log(
      //   `Deduplicated fee receiver shares:`,
      //   recipientShares.map((rs) => ({
      //     address: rs.recipient,
      //     share: rs.share.toString(),
      //     percentage:
      //       ((Number(rs.share) / Number(VALID_SHARE_TOTAL)) * 100).toFixed(5) +
      //       "%",
      //   }))
      // );

      // Verify equal distribution math
      const creatorEffective = adjustedCreatorShare;
      const receiverEffective =
        (VALID_SHARE_TOTAL - adjustedCreatorShare) / totalRecipients;
      console.log(`Effective distribution verification:`, {
        creator:
          (
            (Number(creatorEffective) / Number(VALID_SHARE_TOTAL)) *
            100
          ).toFixed(5) + "%",
        eachReceiver:
          (
            (Number(receiverEffective) / Number(VALID_SHARE_TOTAL)) *
            100
          ).toFixed(5) + "%",
      });

      const initializeData = encodeAbiParameters(
        [
          {
            type: "tuple",
            name: "params",
            components: [
              { type: "uint256", name: "creatorShare" },
              {
                type: "tuple[]",
                name: "recipientShares",
                components: [
                  { type: "address", name: "recipient" },
                  { type: "uint256", name: "share" },
                ],
              },
            ],
          },
        ],
        [
          {
            creatorShare: adjustedCreatorShare,
            recipientShares,
          },
        ]
      );

      console.log("Prepared chat room initializeData:", {
        creatorShare: adjustedCreatorShare.toString(),
        recipientShares: recipientShares.map((rs) => ({
          recipient: rs.recipient,
          share: rs.share.toString(),
        })),
        initializeData,
      });

      // Prepare fee recipients for display
      const allAddresses = [context.creatorAddress, ...uniqueFeeReceivers];
      const resolvedNames = await context.ensResolver.resolveAddresses(
        allAddresses
      );

      const feeRecipients: Array<{
        address: string;
        displayName: string;
        percentage: number;
      }> = [];

      // Add creator first
      const creatorPercentage =
        (Number(adjustedCreatorShare) / Number(VALID_SHARE_TOTAL)) * 100;
      feeRecipients.push({
        address: context.creatorAddress,
        displayName:
          resolvedNames.get(context.creatorAddress.toLowerCase()) ||
          `${context.creatorAddress.slice(
            0,
            6
          )}...${context.creatorAddress.slice(-4)}`,
        percentage: Math.round(creatorPercentage * 100) / 100,
      });

      // Add other recipients
      for (const recipientShare of recipientShares) {
        const sharePercentage =
          (Number(recipientShare.share) / Number(VALID_SHARE_TOTAL)) * 100;
        feeRecipients.push({
          address: recipientShare.recipient,
          displayName:
            resolvedNames.get(recipientShare.recipient.toLowerCase()) ||
            `${recipientShare.recipient.slice(
              0,
              6
            )}...${recipientShare.recipient.slice(-4)}`,
          percentage: Math.round(sharePercentage * 100) / 100,
        });
      }

      return { initializeData, feeRecipients };
    } catch (error) {
      console.error("Error creating initializeData for chat room:", error);
      throw error;
    }
  }

  // Chat room manager address storage is now handled through group state
  // This method has been removed as it depended on user-states.json

  private async extractCoinData(context: FlowContext): Promise<CoinLaunchData> {
    const messageText = this.extractMessageText(context);

    // Get existing coin data from context to preserve it
    const existingCoinData = this.getExistingCoinData(context);

    try {
      // Use LLM-based extraction instead of regex patterns
      const prompt = createCoinLaunchExtractionPrompt({
        message: messageText,
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? "image" : undefined,
        imageUrl: undefined, // We'll handle image URLs separately if needed
      });

      const response = await context.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
      });

      const rawResponse = response.choices[0]?.message?.content || "{}";
      const extractedData =
        safeParseJSON<CoinLaunchExtractionResult>(rawResponse);

      // Convert to CoinLaunchData format, preserving existing data when new extraction is null/undefined
      const result: CoinLaunchData = {
        name:
          extractedData.tokenDetails.name ||
          existingCoinData?.name ||
          undefined,
        ticker:
          extractedData.tokenDetails.ticker ||
          existingCoinData?.ticker ||
          undefined,
        image:
          extractedData.tokenDetails.image ||
          existingCoinData?.image ||
          (context.hasAttachment ? "attachment_provided" : undefined),
        targetGroup:
          extractedData.targetGroup ||
          existingCoinData?.targetGroup ||
          undefined,
        startingMarketCap:
          extractedData.launchParameters.startingMarketCap ||
          existingCoinData?.startingMarketCap ||
          undefined,
        fairLaunchDuration:
          extractedData.launchParameters.fairLaunchDuration ||
          existingCoinData?.fairLaunchDuration ||
          undefined,
        premineAmount:
          extractedData.launchParameters.premineAmount !== null
            ? extractedData.launchParameters.premineAmount
            : existingCoinData?.premineAmount || undefined,
        buybackPercentage:
          extractedData.launchParameters.buybackPercentage ||
          existingCoinData?.buybackPercentage ||
          undefined,
      };

      this.log("Extracted coin data with preservation", {
        ...result,
        hasAttachment: context.hasAttachment,
        messageText: messageText || "(empty)",
        preservedFromExisting: {
          name: !extractedData.tokenDetails.name && existingCoinData?.name,
          ticker:
            !extractedData.tokenDetails.ticker && existingCoinData?.ticker,
          image: !extractedData.tokenDetails.image && existingCoinData?.image,
          targetGroup:
            !extractedData.targetGroup && existingCoinData?.targetGroup,
        },
      });

      return result;
    } catch (error) {
      console.log(
        `[CoinLaunch] ❌ Extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      this.logError("Failed to extract coin data", error);

      // Fallback to existing data if extraction fails
      return (
        existingCoinData || {
          name: undefined,
          ticker: undefined,
          image: context.hasAttachment ? "attachment_provided" : undefined,
          targetGroup: undefined,
        }
      );
    }
  }

  /**
   * Get existing coin data from various sources in the context
   */
  private getExistingCoinData(context: FlowContext): CoinLaunchData | null {
    const { participantState } = context;

    // Check coin launch progress first
    if (participantState.coinLaunchProgress?.coinData) {
      const progress = participantState.coinLaunchProgress;
      const coinData = progress.coinData;
      return {
        name: coinData?.name,
        ticker: coinData?.ticker,
        image: coinData?.image,
        targetGroup: progress.targetGroupId,
        startingMarketCap: progress.launchParameters?.startingMarketCap,
        fairLaunchDuration: progress.launchParameters?.fairLaunchDuration,
        premineAmount: progress.launchParameters?.premineAmount,
        buybackPercentage: progress.launchParameters?.buybackPercentage,
      };
    }

    // Check pending transaction
    if (participantState.pendingTransaction?.type === "coin_creation") {
      const coinData = participantState.pendingTransaction.coinData;
      const launchParams = participantState.pendingTransaction.launchParameters;
      if (coinData && launchParams) {
        return {
          name: coinData.name,
          ticker: coinData.ticker,
          image: coinData.image,
          targetGroup: launchParams.targetGroupId,
          startingMarketCap: launchParams.startingMarketCap,
          fairLaunchDuration: launchParams.fairLaunchDuration,
          premineAmount: launchParams.premineAmount,
          buybackPercentage: launchParams.buybackPercentage,
        };
      }
    }

    return null;
  }

  private async requestMissingData(
    context: FlowContext,
    coinData: CoinLaunchData
  ): Promise<void> {
    const missing = [];
    if (!coinData.name) missing.push("coin name");
    if (!coinData.ticker) missing.push("ticker");
    if (!coinData.image) missing.push("image");

    // Build coin identifier string for existing data
    let coinIdentifier = "";
    if (coinData.ticker && coinData.name) {
      coinIdentifier = `for coin name "${coinData.name}" ($${coinData.ticker}) `;
    } else if (coinData.name) {
      coinIdentifier = `for coin name "${coinData.name}" `;
    } else if (coinData.ticker) {
      coinIdentifier = `for $${coinData.ticker} `;
    }

    // Check if user is launching their first coin by checking aggregated data
    const aggregatedData = await context.getUserAggregatedData();
    const isFirstCoin = aggregatedData.allCoins.length === 0;

    let message;
    if (isFirstCoin) {
      // New user - be extra excited and encouraging
      if (missing.length === 3) {
        // They haven't provided anything yet
        message =
          'let\'s launch your first coin!\n\ni need three things to get started:\n• coin name (e.g., "Flaunchy")\n• ticker (e.g., "FLNCHY")\n• image (upload an image)\n\njust send them all in one message and let\'s make this happen!';
      } else {
        // They've provided some info
        message = `awesome progress on your first coin! ${coinIdentifier}just need: ${missing.join(
          ", "
        )}\n\nsend the missing info and we'll get this live!`;
      }
    } else {
      // Existing user - be more direct but still enthusiastic
      if (missing.length === 3) {
        message = `ready for another coin launch! need: ${missing.join(
          ", "
        )}\n\nsend the details and let's get this one live!`;
      } else {
        message = `almost there! ${coinIdentifier}still need: ${missing.join(
          ", "
        )}\n\nprovide the missing info to launch!`;
      }
    }

    await this.sendResponse(context, message);
  }

  private async launchCoin(
    context: FlowContext,
    coinData: Required<CoinLaunchData>
  ): Promise<void> {
    this.log("Launching coin", {
      participantAddress: context.creatorAddress,
      coinData,
      managerAddress: coinData.targetGroup,
    });

    // Use default chain (no chain switching)
    const selectedChain = getDefaultChain();

    try {
      // Process image if attachment
      let imageUrl = coinData.image;
      if (imageUrl === "attachment_provided" && context.hasAttachment) {
        imageUrl = await context.processImageAttachment(context.attachment);

        if (imageUrl === "IMAGE_PROCESSING_FAILED") {
          await this.sendResponse(
            context,
            `couldn't process image for ${coinData.name} (${coinData.ticker}). try again.`
          );
          return;
        }
      }

      // Calculate creator fee allocation based on buyback percentage
      let creatorFeeAllocationPercent = 100;
      if (coinData.buybackPercentage) {
        // If buybacks are enabled, creator gets reduced share
        creatorFeeAllocationPercent = 100 - coinData.buybackPercentage;
      }

      // Get manager info (address + whether this is first launch + initializeData if needed)
      const managerInfo = await this.getChatRoomManagerAddress(context);

      // Create transaction using centralized function
      const walletSendCalls = await createFlaunchTransaction({
        name: coinData.name,
        ticker: coinData.ticker,
        image: imageUrl,
        creatorAddress: context.creatorAddress,
        senderInboxId: context.senderInboxId,
        chain: selectedChain,
        treasuryManagerAddress: managerInfo.address,
        treasuryInitializeData: managerInfo.initializeData || "0x", // Use initializeData for first launch, "0x" for subsequent
        processImageAttachment: context.processImageAttachment,
        hasAttachment: context.hasAttachment,
        attachment: context.attachment,
        ensResolver: context.ensResolver,
        // Pass extracted launch parameters
        startingMarketCapUSD: coinData.startingMarketCap || 1000,
        fairLaunchDuration: (coinData.fairLaunchDuration || 30) * 60, // Convert to seconds
        fairLaunchPercent: 10, // Keep default for now
        creatorFeeAllocationPercent,
        preminePercentage: coinData.premineAmount || 0,
      });

      // Set pending transaction
      await context.updateParticipantState({
        pendingTransaction: {
          type: "coin_creation",
          coinData: {
            name: coinData.name,
            ticker: coinData.ticker,
            image: imageUrl,
          },
          launchParameters: {
            startingMarketCap: coinData.startingMarketCap || 1000,
            fairLaunchDuration: coinData.fairLaunchDuration || 30,
            premineAmount: coinData.premineAmount || 0,
            buybackPercentage: coinData.buybackPercentage || 0,
            targetGroupId: managerInfo.address,
            isFirstLaunch: managerInfo.isFirstLaunch, // Store this for transaction success handling
          },
          network: selectedChain.name,
          timestamp: new Date(),
        },
      });

      // Send transaction
      await context.conversation.send(
        walletSendCalls,
        ContentTypeWalletSendCalls
      );

      // Confirmation with prebuy suggestion and fee split info
      const currentPrebuy = coinData.premineAmount || 0;
      let confirmationMessage = `ready to launch $${coinData.ticker} (Name: ${coinData.name}) 🚀 sign the transaction to make it happen.`;

      if (currentPrebuy === 0) {
        confirmationMessage += `\n\n💡 tip: reply like: "5% prebuy" before confirming this tx to buy & launch the coin in the same tx.`;
      } else {
        confirmationMessage += `\n\nPrebuy of ${currentPrebuy}% added to the transaction.`;
      }

      // Add fee split information
      if (managerInfo.feeRecipients && managerInfo.feeRecipients.length > 0) {
        const recipients = managerInfo.feeRecipients;
        const equalPercentage = recipients[0].percentage; // They should all have equal percentages

        // TODO: not responding with the recipients for now (CBW issue)
        confirmationMessage += `\n\nFees will be split ${equalPercentage}% equally between ${recipients.length} receivers.`;
        // recipients.forEach((recipient, index) => {
        //   confirmationMessage += `\n${index + 1}. ${recipient.displayName}`;
        // });
      }

      await this.sendResponse(context, confirmationMessage);

      this.log("Transaction sent for coin launch", {
        participantAddress: context.creatorAddress,
        coinData,
        callsLength: walletSendCalls.calls?.length || 0,
      });
    } catch (error) {
      this.logError("Failed to launch coin", error);
      await this.sendResponse(
        context,
        `failed to launch ${coinData.name}. please try again.`
      );
    }
  }

  private async isLaunchOptionsInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about launch options, capabilities, or what they can configure when launching coins.

        Message: "${messageText}"

        Examples of launch options inquiries:
        - "what launch options do you have?"
        - "what can I configure when launching?"
        - "what settings are available?"
        - "what parameters can I set?"
        - "what options do I have for launching?"
        - "tell me about launch capabilities"

        Respond with only "YES" if this is asking about launch options/capabilities, or "NO" if it's not.
      `,
    });

    return response.trim().toUpperCase() === "YES";
  }

  private async handleLaunchOptionsInquiry(
    context: FlowContext
  ): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about launch options. Explain the configurable parameters available:

        1. Starting market cap: $100 to $10,000
        2. Fair launch duration: 1 to 60 minutes  
        3. Prebuy amount: 0% to 100% (prebuy coins before launch)
        4. Automated buybacks: 0% to 100% of fees go to automated buybacks

        Be brief and clear. Don't overwhelm with details. Use your character voice.
      `,
    });

    await this.sendResponse(context, response);
  }

  private async isFutureFeatureInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about future features, upcoming capabilities, or what's coming next.

        Message: "${messageText}"

        Examples of future feature inquiries:
        - "what's coming next?"
        - "what features are you adding?"
        - "what's on the roadmap?"
        - "any upcoming features?"
        - "what's planned for the future?"
        - "what new capabilities are you working on?"

        Respond with only "YES" if this is asking about future features, or "NO" if it's not.
      `,
    });

    return response.trim().toUpperCase() === "YES";
  }

  private async handleFutureFeatureInquiry(
    context: FlowContext
  ): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about future features. Mention these upcoming capabilities:

        1. Multi-chain support (launching on different blockchains)
        2. Advanced tokenomics (custom fee structures, vesting schedules)
        3. NFT integration (launching NFT collections alongside coins)
        4. DAO governance (community voting on project decisions)
        5. Advanced analytics (detailed performance tracking)

        Be excited about the future but realistic about timelines. Use your character voice.
      `,
    });

    await this.sendResponse(context, response);
  }

  private async isLaunchDefaultsInquiry(
    context: FlowContext
  ): Promise<boolean> {
    const messageText = this.extractMessageText(context);

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about default launch settings or what happens if they don't specify parameters.

        Message: "${messageText}"

        Examples of default settings inquiries:
        - "what are the default settings?"
        - "what happens if I don't specify parameters?"
        - "what are the default launch options?"
        - "what's the default market cap?"
        - "what are the standard settings?"

        Respond with only "YES" if this is asking about defaults, or "NO" if it's not.
      `,
    });

    return response.trim().toUpperCase() === "YES";
  }

  private async handleLaunchDefaultsInquiry(
    context: FlowContext
  ): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about default launch settings. Explain the defaults:

        - Starting market cap: $1,000
        - Fair launch duration: 30 minutes
        - Prebuy amount: 0% (no prebuy)
        - Automated buybacks: 0% (no buybacks)
        - Fee sharing: Everyone in the chat group automatically shares trading fees

        Be clear that these are sensible defaults but everything can be customized. Use your character voice.
      `,
    });

    await this.sendResponse(context, response);
  }

  private async isStatusInquiry(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        Analyze this message to determine if the user is asking about their coin launch status, progress, or what's happening.

        Message: "${messageText}"

        Examples of status inquiries:
        - "what's my status?"
        - "where are we in the process?"
        - "what's happening with my coin?"
        - "how's my launch going?"
        - "what's the current status?"
        - "where do we stand?"

        Respond with only "YES" if this is asking about status, or "NO" if it's not.
      `,
    });

    return response.trim().toUpperCase() === "YES";
  }

  private async handleStatusInquiry(context: FlowContext): Promise<void> {
    const { participantState } = context;

    if (participantState.pendingTransaction?.type === "coin_creation") {
      const coinData = participantState.pendingTransaction.coinData;
      if (coinData) {
        await this.sendResponse(
          context,
          `$${coinData.ticker} is ready to launch! waiting for you to sign the transaction.`
        );
      } else {
        await this.sendResponse(
          context,
          `transaction is ready to launch! waiting for you to sign.`
        );
      }
      return;
    }

    if (participantState.coinLaunchProgress) {
      const progress = participantState.coinLaunchProgress;
      const coinData = progress.coinData || {};

      const missing = [];
      if (!coinData.name) missing.push("coin name");
      if (!coinData.ticker) missing.push("ticker");
      if (!coinData.image) missing.push("image");

      if (missing.length > 0) {
        await this.sendResponse(
          context,
          `we're working on your coin launch! still need: ${missing.join(", ")}`
        );
      } else {
        await this.sendResponse(
          context,
          `${coinData.name} (${coinData.ticker}) is ready to launch! processing now...`
        );
      }
      return;
    }

    // No active launch process
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about status but has no active coin launch in progress. 
        Let them know there's no active launch and encourage them to start one.
        Be encouraging about launching a coin. Use your character voice.
      `,
    });

    await this.sendResponse(context, response);
  }

  private async isLaunchCommand(context: FlowContext): Promise<boolean> {
    const messageText = this.extractMessageText(context);

    // Check for explicit launch commands
    const launchCommands = [
      /^launch$/i,
      /^go$/i,
      /^start$/i,
      /^begin$/i,
      /^let's go$/i,
      /^let's launch$/i,
      /^start launch$/i,
      /^launch it$/i,
      /^do it$/i,
      /^launch now$/i,
    ];

    return launchCommands.some((pattern) => pattern.test(messageText.trim()));
  }

  private async handleLaunchCommand(context: FlowContext): Promise<void> {
    const { participantState } = context;

    // Check if they have coin launch progress
    if (participantState.coinLaunchProgress) {
      const progress = participantState.coinLaunchProgress;
      const coinData = progress.coinData || {};

      const missing = [];
      if (!coinData.name) missing.push("coin name");
      if (!coinData.ticker) missing.push("ticker");
      if (!coinData.image) missing.push("image");

      if (missing.length > 0) {
        await this.sendResponse(
          context,
          `can't launch yet! still need: ${missing.join(
            ", "
          )}\n\nprovide the missing info and we'll launch immediately!`
        );
        return;
      }

      // They have everything, continue with launch
      await this.continueFromProgress(context);
      return;
    }

    // No progress - ask for coin details
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to launch but hasn't provided coin details yet.
        Ask them to provide coin name, ticker, and image to get started.
        Be enthusiastic and clear about what's needed. Use your character voice.
      `,
    });

    await this.sendResponse(context, response);
  }
}

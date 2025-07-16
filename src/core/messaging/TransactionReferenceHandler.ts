import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type { TransactionReferenceMessage } from "../../../types";
import { createPublicClient, http, type Hex } from "viem";
import { getDefaultChain } from "../../flows/utils/ChainSelection";
import { ContractExtractor } from "./ContractExtractor";
import { GroupStorageService } from "../../services/GroupStorageService";
import { SessionManager } from "../session/SessionManager";

/**
 * Service for handling transaction references and processing success messages
 * Handles both group creation and coin creation transactions
 */
export class TransactionReferenceHandler {
  constructor(
    private client: Client<any>,
    private sessionManager: SessionManager,
    private groupStorageService: GroupStorageService
  ) {}

  /**
   * Process a transaction reference message and handle success/failure scenarios
   */
  async handleTransactionReference(message: DecodedMessage): Promise<boolean> {
    try {
      const senderInboxId = message.senderInboxId;

      // Get creator address for state lookup
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([
        senderInboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

      const groupId = message.conversationId;
      const participantState = await this.sessionManager.getParticipantState(
        groupId,
        creatorAddress
      );

      // Check if user has a pending transaction
      if (!participantState?.pendingTransaction) {
        console.log("No pending transaction found for transaction reference");
        return false;
      }

      const pendingTx = participantState.pendingTransaction;
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );

      if (!conversation) {
        console.error("Could not find conversation for transaction reference");
        return false;
      }

      // Extract transaction hash
      const txHash = this.extractTransactionHash(message);
      if (!txHash) {
        console.error("❌ Transaction hash is undefined");
        return false;
      }

      console.log(
        `[TransactionReferenceHandler] 🔍 Processing ${pendingTx.type} transaction: ${txHash}`
      );

      // Get transaction receipt
      const receipt = await this.getTransactionReceipt(txHash);
      if (!receipt) {
        return await this.handleReceiptError(
          conversation,
          null,
          creatorAddress,
          message.conversationId
        );
      }

      // Extract and validate contract address
      const contractAddress = ContractExtractor.extractContractAddress(
        receipt,
        pendingTx.type
      );
      if (
        !ContractExtractor.validateExtractedAddress(
          contractAddress,
          pendingTx.type
        )
      ) {
        return await this.handleContractExtractionError(
          conversation,
          pendingTx.type,
          creatorAddress,
          message.conversationId
        );
      }

      // Process based on transaction type
      if (pendingTx.type === "group_creation") {
        return await this.handleGroupCreationSuccess(
          conversation,
          contractAddress!,
          pendingTx,
          participantState,
          creatorAddress,
          message.conversationId,
          txHash,
          receipt
        );
      } else {
        return await this.handleCoinCreationSuccess(
          conversation,
          contractAddress!,
          pendingTx,
          participantState,
          creatorAddress,
          message.conversationId,
          receipt
        );
      }
    } catch (error) {
      return await this.handleCriticalError(error, message);
    }
  }

  /**
   * Extract transaction hash from message content
   */
  private extractTransactionHash(message: DecodedMessage): Hex | undefined {
    const messageContent = (message as TransactionReferenceMessage).content;

    if (!messageContent) {
      return undefined;
    }

    const transactionRef = messageContent.transactionReference;
    if (transactionRef) {
      return transactionRef.reference;
    }

    // Handle old format
    const oldMessageContent = messageContent as unknown as { reference: Hex };
    return oldMessageContent.reference;
  }

  /**
   * Extract manager address from transaction receipt
   */
  private async extractManagerAddressFromReceipt(
    receipt: any
  ): Promise<string | null> {
    try {
      if (!receipt || !receipt.logs || !Array.isArray(receipt.logs)) {
        throw new Error("Invalid receipt or logs");
      }

      // Look for the ManagerDeployed event (topic: 0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4)
      const managerDeployedTopic =
        "0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4";

      for (const log of receipt.logs) {
        if (
          log.topics &&
          log.topics.length > 1 &&
          log.topics[0] === managerDeployedTopic
        ) {
          // Found the ManagerDeployed event, extract manager address from topic[1]
          const managerAddressHex = log.topics[1];
          // Remove padding zeros to get the actual address
          const managerAddress = `0x${managerAddressHex.slice(-40)}`;
          console.log(
            "✅ Found manager address from ManagerDeployed event:",
            managerAddress
          );
          return managerAddress;
        }
      }

      console.log(
        "❌ No ManagerDeployed event found in logs for manager address extraction"
      );
      return null;
    } catch (error) {
      console.error(
        "Failed to extract manager address from transaction logs:",
        error
      );
      return null;
    }
  }

  /**
   * Get transaction receipt with timeout
   */
  private async getTransactionReceipt(txHash: Hex): Promise<any | null> {
    try {
      const defaultChain = getDefaultChain();
      const publicClient = createPublicClient({
        chain: defaultChain.viemChain,
        transport: http(),
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000, // 60 second timeout
      });

      console.log("[TransactionReferenceHandler] ✅ Transaction confirmed");
      return receipt;
    } catch (error) {
      console.error("❌ Failed to wait for transaction receipt:", error);
      return null;
    }
  }

  /**
   * Handle successful group creation transaction
   */
  private async handleGroupCreationSuccess(
    conversation: Conversation<any>,
    contractAddress: string,
    pendingTx: any,
    participantState: any,
    creatorAddress: string,
    conversationId: string,
    txHash: Hex,
    receipt: any
  ): Promise<boolean> {
    // Send success message
    await conversation.send("✅ Group created successfully!");

    // Clear pending transaction
    await this.sessionManager.updateParticipantState(
      conversationId,
      creatorAddress,
      {
        pendingTransaction: undefined,
        managementProgress: undefined,
      }
    );

    return true;
  }

  /**
   * Handle successful coin creation transaction
   */
  private async handleCoinCreationSuccess(
    conversation: Conversation<any>,
    contractAddress: string,
    pendingTx: any,
    participantState: any,
    creatorAddress: string,
    conversationId: string,
    receipt: any
  ): Promise<boolean> {
    const networkPath =
      pendingTx.network === "baseSepolia" ? "base-sepolia" : "base";

    await conversation.send(
      `coin created! CA: ${contractAddress}\n\nlink: https://flaunch.gg/${networkPath}/coin/${contractAddress}\n\nview in mini app:`
    );
    await conversation.send(
      `https://mini.flaunch.gg/${networkPath}/coin/${contractAddress}`
    );

    // Store the successfully created coin in group state
    if (pendingTx.launchParameters?.targetGroupId && pendingTx.coinData) {
      // Extract the actual manager address from the transaction receipt
      const actualManagerAddress = await this.extractManagerAddressFromReceipt(
        receipt
      );

      // If this was the first launch, we need to also store the manager
      if (pendingTx.launchParameters.isFirstLaunch) {
        // Get conversation members to determine fee recipients
        let receivers = [];
        try {
          const members = await conversation.members();
          console.log(
            `[TransactionReferenceHandler] Found ${members.length} chat members for manager`
          );

          for (const member of members) {
            if (member.inboxId !== this.client.inboxId) {
              const memberInboxState =
                await this.client.preferences.inboxStateFromInboxIds([
                  member.inboxId,
                ]);
              if (
                memberInboxState.length > 0 &&
                memberInboxState[0].identifiers.length > 0
              ) {
                const memberAddress =
                  memberInboxState[0].identifiers[0].identifier;
                receivers.push({
                  username: `${memberAddress.slice(
                    0,
                    6
                  )}...${memberAddress.slice(-4)}`,
                  resolvedAddress: memberAddress,
                  percentage: 100 / (members.length - 1), // Equal split excluding bot
                });
              }
            }
          }
        } catch (error) {
          console.warn(
            "[TransactionReferenceHandler] Could not fetch conversation members:",
            error
          );
        }

        // Create manager object for the group
        const managerToAdd = {
          contractAddress:
            actualManagerAddress ?? pendingTx.launchParameters.targetGroupId,
          deployedAt: new Date(),
          txHash: "", // Could extract from full transaction if needed
          deployedBy: creatorAddress,
          chainId: pendingTx.network === "baseSepolia" ? 84532 : 8453,
          chainName: (pendingTx.network === "baseSepolia"
            ? "baseSepolia"
            : "base") as "base" | "baseSepolia",
          receivers,
        };

        await this.sessionManager.addManagerToGroup(
          conversationId,
          managerToAdd
        );
        console.log(
          `[TransactionReferenceHandler] ✅ Added manager ${
            actualManagerAddress ?? pendingTx.launchParameters.targetGroupId
          } to group ${conversationId} with ${receivers.length} receivers`
        );
      }

      const coinToAdd = {
        ticker: pendingTx.coinData.ticker,
        name: pendingTx.coinData.name,
        image: pendingTx.coinData.image,
        contractAddress: contractAddress,
        txHash: "", // Will be updated when we have access to the full transaction
        launchedAt: new Date(),
        launchedBy: creatorAddress,
        chainId: pendingTx.network === "baseSepolia" ? 84532 : 8453,
        chainName: (pendingTx.network === "baseSepolia"
          ? "baseSepolia"
          : "base") as "base" | "baseSepolia",
        fairLaunchDuration: pendingTx.launchParameters.fairLaunchDuration || 30,
        fairLaunchPercent: 10,
        initialMarketCap: pendingTx.launchParameters.startingMarketCap || 1000,
        managerAddress:
          actualManagerAddress ?? pendingTx.launchParameters.targetGroupId,
      };

      await this.sessionManager.addCoinToGroup(conversationId, coinToAdd);

      // Also record the coin launch in per-user state for cross-group tracking
      await this.sessionManager.recordCoinLaunch(creatorAddress, {
        coinAddress: contractAddress,
        ticker: pendingTx.coinData.ticker,
        name: pendingTx.coinData.name,
        groupId: conversationId,
        chainId: pendingTx.network === "baseSepolia" ? 84532 : 8453,
        chainName: (pendingTx.network === "baseSepolia"
          ? "baseSepolia"
          : "base") as "base" | "baseSepolia",
        initialMarketCap: pendingTx.launchParameters.startingMarketCap || 1000,
      });
    }

    // Clear pending transaction and coin launch progress after successful launch
    await this.sessionManager.updateParticipantState(
      conversationId,
      creatorAddress,
      {
        pendingTransaction: undefined,
        managementProgress: undefined,
        coinLaunchProgress: undefined,
      }
    );

    // Update participant status to active after successful coin launch
    if (
      participantState.status === "new" ||
      participantState.status === "onboarding"
    ) {
      await this.sessionManager.updateParticipantState(
        conversationId,
        creatorAddress,
        {
          status: "active",
        }
      );

      const completionMessage =
        participantState.status === "new"
          ? `🎉 coin launched! you're now active and earning fees from trading.`
          : `🎉 onboarding complete! you've got groups and coins set up.`;

      await conversation.send(completionMessage);
    }

    return true;
  }

  /**
   * Handle contract extraction error
   */
  private async handleContractExtractionError(
    conversation: Conversation<any>,
    transactionType: string,
    creatorAddress: string,
    conversationId: string
  ): Promise<boolean> {
    const errorMessage =
      transactionType === "group_creation"
        ? "❌ Transaction Error\n\nI couldn't verify your Group creation. Please check your wallet for the transaction details."
        : "❌ Transaction Error\n\nI couldn't verify your Coin creation. Please check your wallet for the transaction details.";

    await conversation.send(errorMessage);

    // Clear the pending transaction
    await this.sessionManager.updateParticipantState(
      conversationId,
      creatorAddress,
      {
        pendingTransaction: undefined,
        managementProgress: undefined,
      }
    );

    return false;
  }

  /**
   * Handle receipt fetching error
   */
  private async handleReceiptError(
    conversation: Conversation<any>,
    receiptError: any,
    creatorAddress: string,
    conversationId: string
  ): Promise<boolean> {
    const errorMessage =
      "⏰ Transaction Timeout\n\nYour transaction is taking longer than expected to confirm. Please check your wallet in a few minutes.";
    await conversation.send(errorMessage);
    return false;
  }

  /**
   * Handle critical system error
   */
  private async handleCriticalError(
    error: any,
    message: DecodedMessage
  ): Promise<boolean> {
    console.error("❌ CRITICAL: Error handling transaction reference:", error);

    try {
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );
      if (conversation) {
        await conversation.send(
          "❌ System Error\n\nI encountered an error while processing your transaction reference."
        );
      }
    } catch (notificationError) {
      console.error(
        "Failed to send error notification to user:",
        notificationError
      );
    }

    return false;
  }
}

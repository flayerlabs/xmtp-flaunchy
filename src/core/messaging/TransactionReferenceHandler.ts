import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type { TransactionReferenceMessage } from "../../../types";
import { Address, createPublicClient, http, zeroAddress, type Hex } from "viem";
import { getDefaultChain } from "../../flows/utils/ChainSelection";
import { ContractExtractor } from "./ContractExtractor";
import { SessionManager } from "../session/SessionManager";
import { PendingTransaction } from "../types/GroupState";

/**
 * Service for handling transaction references and processing success messages
 * Handles both group creation and coin creation transactions
 */
export class TransactionReferenceHandler {
  constructor(
    private client: Client<any>,
    private sessionManager: SessionManager
  ) {}

  /**
   * Process a transaction reference message and handle success/failure scenarios
   */
  async handleTransactionReference(message: DecodedMessage): Promise<boolean> {
    try {
      const context = await this.prepareTransactionContext(message);
      if (!context) {
        return false;
      }

      const { pendingTx, conversation, creatorAddress, conversationId } =
        context;

      const txHash = this.extractTransactionHash(message);
      if (!txHash) {
        console.error("❌ Transaction hash is undefined");
        return false;
      }

      console.log(
        `[TransactionReferenceHandler] 🔍 Processing ${pendingTx.type} transaction: ${txHash}`
      );

      const receipt = await this.getTransactionReceipt(txHash);
      if (!receipt) {
        return await this.handleError(
          conversation,
          "Transaction timeout - check your wallet in a few minutes",
          null,
          creatorAddress,
          conversationId
        );
      }

      const contractAddress = ContractExtractor.extractContractAddress(
        receipt,
        pendingTx.type
      );
      if (!ContractExtractor.validateExtractedAddress(contractAddress)) {
        return await this.handleError(
          conversation,
          "Couldn't verify transaction - check your wallet for details",
          null,
          creatorAddress,
          conversationId
        );
      }

      if (pendingTx.type === "coin_creation") {
        return await this.handleCoinCreationSuccess(
          conversation,
          contractAddress!,
          pendingTx,
          creatorAddress,
          conversationId,
          receipt
        );
      }

      return false;
    } catch (error) {
      return await this.handleCriticalError(error, message);
    }
  }

  /**
   * Prepare transaction context for processing
   */
  private async prepareTransactionContext(message: DecodedMessage) {
    const senderInboxId = message.senderInboxId;
    const groupId = message.conversationId;

    // Get creator address for state lookup
    const inboxState = await this.client.preferences.inboxStateFromInboxIds([
      senderInboxId,
    ]);
    const creatorAddress = (inboxState[0]?.identifiers[0]?.identifier ||
      zeroAddress) as Address;

    const participantState = await this.sessionManager.getParticipantState(
      groupId,
      creatorAddress
    );

    if (!participantState?.pendingTransaction) {
      console.log("No pending transaction found for transaction reference");
      return null;
    }

    const conversation = await this.client.conversations.getConversationById(
      message.conversationId
    );

    if (!conversation) {
      console.error("Could not find conversation for transaction reference");
      return null;
    }

    return {
      pendingTx: participantState.pendingTransaction,
      conversation,
      creatorAddress,
      conversationId: message.conversationId,
    };
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
   * Handle successful coin creation transaction
   */
  private async handleCoinCreationSuccess(
    conversation: Conversation<any>,
    contractAddress: Address,
    pendingTx: PendingTransaction,
    creatorAddress: Address,
    conversationId: string,
    receipt: any
  ): Promise<boolean> {
    const chainInfo = this.getChainInfo(pendingTx.network);

    // Send success messages
    await this.sendCoinCreatedMessages(
      conversation,
      contractAddress,
      chainInfo.networkPath
    );

    // Handle group state updates if this is for a group
    if (pendingTx.launchParameters?.targetGroupId && pendingTx.coinData) {
      await this.updateGroupState(
        conversation,
        contractAddress,
        pendingTx,
        creatorAddress,
        conversationId,
        receipt,
        chainInfo
      );
    }

    // Clear pending transaction and coin launch progress
    await this.sessionManager.updateParticipantState(
      conversationId,
      creatorAddress,
      {
        pendingTransaction: undefined,
        coinLaunchProgress: undefined,
      }
    );

    await conversation.send(
      `🎉 coin launched! your group is now active and earning fees from trading.`
    );

    return true;
  }

  /**
   * Get chain information based on network
   */
  private getChainInfo(network: string) {
    const isTestnet = network === "baseSepolia";
    return {
      networkPath: isTestnet ? "base-sepolia" : "base",
      chainId: isTestnet ? 84532 : 8453,
    };
  }

  /**
   * Send coin creation success messages
   */
  private async sendCoinCreatedMessages(
    conversation: Conversation<any>,
    contractAddress: Address,
    networkPath: string
  ): Promise<void> {
    await conversation.send(
      `coin created! CA: ${contractAddress}\n\nlink: https://flaunch.gg/${networkPath}/coin/${contractAddress}\n\nview in mini app:`
    );
    await conversation.send(
      `https://mini.flaunch.gg/${networkPath}/coin/${contractAddress}`
    );
  }

  /**
   * Update group state with new coin and manager (if first launch)
   */
  private async updateGroupState(
    conversation: Conversation<any>,
    contractAddress: Address,
    pendingTx: PendingTransaction,
    creatorAddress: Address,
    conversationId: string,
    receipt: any,
    chainInfo: { chainId: number }
  ): Promise<void> {
    const actualManagerAddress =
      ContractExtractor.extractManagerAddressFromReceipt(receipt);

    // Handle first launch - create manager
    if (pendingTx.launchParameters!.isFirstLaunch) {
      const receivers = await this.getGroupReceivers(conversation);
      const managerToAdd = {
        contractAddress: actualManagerAddress ?? zeroAddress,
        deployedAt: new Date(),
        txHash: pendingTx.txHash,
        deployedBy: creatorAddress,
        chainId: chainInfo.chainId,
        receivers,
      };

      await this.sessionManager.addManagerToGroup(conversationId, managerToAdd);
      console.log(
        `[TransactionReferenceHandler] ✅ Added manager ${
          actualManagerAddress ?? pendingTx.launchParameters!.targetGroupId
        } to group ${conversationId} with ${receivers.length} receivers`
      );
    }

    // Add coin to group
    const coinToAdd = {
      ticker: pendingTx.coinData!.ticker,
      name: pendingTx.coinData!.name,
      image: pendingTx.coinData!.image,
      contractAddress: contractAddress,
      txHash: pendingTx.txHash,
      launchedAt: new Date(),
      launchedBy: creatorAddress,
      chainId: chainInfo.chainId,
      fairLaunchDuration: pendingTx.launchParameters!.fairLaunchDuration || 30,
      fairLaunchPercent: 10,
      initialMarketCap: pendingTx.launchParameters!.startingMarketCap || 1000,
      managerAddress: actualManagerAddress ?? zeroAddress,
    };

    await this.sessionManager.addCoinToGroup(conversationId, coinToAdd);

    // Record coin launch for cross-group tracking
    await this.sessionManager.recordCoinLaunch(creatorAddress, {
      coinAddress: contractAddress,
      ticker: pendingTx.coinData!.ticker,
      name: pendingTx.coinData!.name,
      groupId: conversationId,
      chainId: chainInfo.chainId,
      initialMarketCap: pendingTx.launchParameters!.startingMarketCap || 1000,
    });
  }

  /**
   * Get group receivers for fee distribution
   */
  private async getGroupReceivers(conversation: Conversation<any>) {
    const receivers = [];
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
            const memberAddress = memberInboxState[0].identifiers[0]
              .identifier as Address;
            receivers.push({
              username: `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`,
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
    return receivers;
  }

  /**
   * Unified error handler for transaction processing
   */
  private async handleError(
    conversation: Conversation<any>,
    userMessage: string,
    error: any = null,
    creatorAddress?: Address,
    conversationId?: string
  ): Promise<boolean> {
    const errorMessage = `❌ ${userMessage}`;
    await conversation.send(errorMessage);

    // Clear pending transaction if we have the context
    if (creatorAddress && conversationId) {
      await this.sessionManager.updateParticipantState(
        conversationId,
        creatorAddress,
        {
          pendingTransaction: undefined,
        }
      );
    }

    if (error) {
      console.error("Transaction processing error:", error);
    }

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

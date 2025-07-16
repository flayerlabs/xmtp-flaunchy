import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import { ContentTypeReply, type Reply } from "@xmtp/content-type-reply";
import { ContentTypeRemoteAttachment } from "@xmtp/content-type-remote-attachment";

/**
 * Service for detecting and analyzing reply messages
 * Handles checking if messages are replies to agent and reply-to-image detection
 */
export class ReplyDetector {
  constructor(private client: Client<any>) {}

  /**
   * Check if the message is a reply to one of the agent's messages
   */
  async isReplyToAgentMessage(message: DecodedMessage): Promise<boolean> {
    try {
      // Check if this message has reply content type
      if (!message.contentType?.sameAs(ContentTypeReply)) {
        return false;
      }

      const replyContent = message.content as Reply;

      console.log("🔍 REPLY MESSAGE DEBUG", {
        contentType: message.contentType.toString(),
        hasReference: !!replyContent.reference,
        referenceType: typeof replyContent.reference,
        referenceValue: replyContent.reference
          ? (replyContent.reference as string).slice(0, 16) + "..."
          : "none",
        replyContentKeys: Object.keys(replyContent || {}),
        messageContent: replyContent.content
          ? replyContent.content.toString().substring(0, 50) + "..."
          : "no-content",
      });

      // Get the referenced message ID
      if (!replyContent.reference) {
        console.log("❌ No reference found in reply content");
        return false;
      }

      // Get the conversation to look up the referenced message
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );
      if (!conversation) {
        return false;
      }

      // Get more messages to find the referenced message (increase limit)
      const messages = await conversation.messages({
        limit: 100,
        direction: 1,
      }); // Descending order

      console.log("🔍 MESSAGE HISTORY", {
        messages,
      });

      // Enhanced debugging for message ID comparison
      const referenceId = replyContent.reference as string;

      // Log first 10 message IDs with full details
      const messageDetails = messages.slice(0, 10).map((msg: any, index) => ({
        index,
        id: msg.id,
        idType: typeof msg.id,
        idLength: msg.id?.length,
        idSliced: msg.id?.slice(0, 16) + "...",
        isAgent: msg.senderInboxId === this.client.inboxId,
        sender: msg.senderInboxId?.slice(0, 8) + "...",
        exactMatch: msg.id === referenceId,
        sentAt: msg.sentAt,
      }));

      console.log("🔍 MESSAGE ID COMPARISON", {
        searchingFor: referenceId,
        messageDetails,
      });

      // Find the message being replied to
      const referencedMessage = messages.find(
        (msg: any) => msg.id === referenceId
      );

      if (!referencedMessage) {
        console.log("❌ REPLY REFERENCE NOT FOUND - IGNORING MESSAGE", {
          referenceId: referenceId?.slice(0, 16) + "...",
          totalMessagesSearched: messages.length,
          reason: "reference_not_found",
        });

        // NO FALLBACK - If it's not a reply to an agent message, ignore it completely
        return false;
      }

      // Check if the referenced message was sent by this agent
      const isFromAgent =
        referencedMessage.senderInboxId === this.client.inboxId;

      if (isFromAgent) {
        console.log("✅ Confirmed reply to agent message");
      }

      return isFromAgent;
    } catch (error) {
      console.error("Error checking if message is reply to agent:", error);
      return false;
    }
  }

  /**
   * Check if the message is a reply to an image attachment during coin data collection
   */
  async isReplyToImageAttachment(
    message: DecodedMessage,
    conversation: Conversation<any>,
    groupState: any
  ): Promise<boolean> {
    try {
      // First check if we're in coin data collection step
      if (groupState.coinLaunchProgress?.step !== "collecting_coin_data") {
        return false;
      }

      // Check if this message has reply content type
      if (!message.contentType?.sameAs(ContentTypeReply)) {
        return false;
      }

      const replyContent = message.content as Reply;

      // Get the referenced message ID
      if (!replyContent.reference) {
        return false;
      }

      // Get more messages to find the referenced message
      const messages = await conversation.messages({
        limit: 100,
        direction: 1,
      }); // Descending order
      const referenceId = replyContent.reference as string;

      // Find the message being replied to
      const referencedMessage = messages.find(
        (msg: any) => msg.id === referenceId
      );

      if (!referencedMessage) {
        console.log("❌ REPLY TO IMAGE: Referenced message not found", {
          referenceId: referenceId?.slice(0, 16) + "...",
        });
        return false;
      }

      // Check if the referenced message is an image attachment
      const isImageAttachment = referencedMessage.contentType?.sameAs(
        ContentTypeRemoteAttachment
      );

      if (isImageAttachment) {
        console.log(
          "✅ REPLY TO IMAGE: Found reply to image attachment during coin data collection",
          {
            referenceId: referenceId?.slice(0, 16) + "...",
            step: groupState.coinLaunchProgress?.step,
          }
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(
        "Error checking if message is reply to image attachment:",
        error
      );
      return false;
    }
  }

  /**
   * Check if we should use reply format due to intervening messages from other users
   */
  async shouldUseReplyFormat(
    originalMessage: DecodedMessage,
    conversation: Conversation<any>,
    agentInboxId: string
  ): Promise<boolean> {
    try {
      // Get recent messages to check for intervening messages
      const messages = await conversation.messages({ limit: 20, direction: 1 }); // Descending order

      // Find the index of the original message
      const originalMessageIndex = messages.findIndex(
        (msg: any) => msg.id === originalMessage.id
      );

      if (originalMessageIndex === -1) {
        console.log(
          "🔍 Original message not found in recent messages, defaulting to normal message"
        );
        return false;
      }

      // Check messages that came after the original message (before it in the array since newest first)
      const messagesAfterOriginal = messages.slice(0, originalMessageIndex);

      // Look for messages from users other than the agent and the original sender
      const interveningMessages = messagesAfterOriginal.filter(
        (msg: any) =>
          msg.senderInboxId !== agentInboxId &&
          msg.senderInboxId !== originalMessage.senderInboxId
      );

      const shouldUseReply = interveningMessages.length > 0;

      if (shouldUseReply) {
        console.log("📨 Using reply format due to intervening messages", {
          originalMessageId: originalMessage.id.slice(0, 16) + "...",
          originalSender: originalMessage.senderInboxId.slice(0, 8) + "...",
          interveningMessages: interveningMessages.length,
          interveningSenders: interveningMessages.map(
            (msg: any) => msg.senderInboxId.slice(0, 8) + "..."
          ),
        });
      } else {
        console.log("📝 Using normal message format - no intervening messages");
      }

      return shouldUseReply;
    } catch (error) {
      console.error("Error checking for intervening messages:", error);
      return false; // Default to normal message on error
    }
  }

  /**
   * Check if this is a direct message (1-on-1 conversation)
   * Skip paw reactions in direct messages since we'll always reply directly
   */
  async isDirectMessage(conversation: Conversation<any>): Promise<boolean> {
    try {
      // Get conversation members to determine if it's a direct message
      // In XMTP, a direct message has exactly 2 members (user + agent)
      const members = await conversation.members();
      const memberCount = members ? members.length : 0;

      console.log("📊 Conversation type check", {
        conversationId: conversation.id?.slice(0, 16) + "...",
        memberCount,
        isDirectMessage: memberCount === 2,
      });

      return memberCount === 2;
    } catch (error) {
      console.error("Error checking if direct message:", error);
      // Default to false (assume group chat) if we can't determine
      // This ensures paw reactions are sent when in doubt
      return false;
    }
  }
}

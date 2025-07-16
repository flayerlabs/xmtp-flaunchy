import type { DecodedMessage } from "@xmtp/node-sdk";
import { ContentTypeReply, type Reply } from "@xmtp/content-type-reply";
import { ContentTypeRemoteAttachment } from "@xmtp/content-type-remote-attachment";

/**
 * Service for extracting text content from various XMTP message types
 * Handles text messages, replies, attachments, and combined message scenarios
 */
export class MessageTextExtractor {
  /**
   * Extract text content from a message, handling different content types properly
   */
  static extractMessageText(message: DecodedMessage): string {
    if (!message.content) {
      return "";
    }

    // Handle string content (regular text messages)
    if (typeof message.content === "string") {
      return message.content;
    }

    // Handle reply messages - extract text from reply.content
    if (message.contentType?.sameAs(ContentTypeReply)) {
      const replyContent = message.content as Reply;
      if (replyContent.content && typeof replyContent.content === "string") {
        console.log("📝 Extracted text from reply message", {
          originalContent: replyContent.content.substring(0, 50) + "...",
          // referenceId: (replyContent.reference as string)?.slice(0, 16) + "...",
        });
        return replyContent.content;
      }
      return "";
    }

    // For other content types, return empty string
    return "";
  }

  /**
   * Extract combined text content from primary message and related messages
   * This handles cases where text and attachment are sent as separate messages
   */
  static extractCombinedMessageText(
    primaryMessage: DecodedMessage,
    relatedMessages: DecodedMessage[]
  ): string {
    const isAttachment = primaryMessage.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );

    if (isAttachment) {
      // Look for text in related messages
      const textMessage = relatedMessages.find(
        (msg) => !msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (textMessage) {
        return this.extractMessageText(textMessage).trim();
      }
      return "";
    } else {
      // Primary message is text (or reply with text)
      return this.extractMessageText(primaryMessage).trim();
    }
  }

  /**
   * Check if a message appears to be a transaction receipt (contains only '...')
   */
  static isTransactionReceipt(message: DecodedMessage): boolean {
    return (
      typeof message.content === "string" && message.content.trim() === "..."
    );
  }

  /**
   * Check if a message is an attachment
   */
  static isAttachment(message: DecodedMessage): boolean {
    return message.contentType?.sameAs(ContentTypeRemoteAttachment) || false;
  }

  /**
   * Get a safe preview of message content for logging
   */
  static getContentPreview(
    message: DecodedMessage,
    maxLength: number = 100
  ): string {
    if (this.isAttachment(message)) {
      return "[ATTACHMENT]";
    }

    const text = this.extractMessageText(message);
    if (!text) {
      return "[NON-TEXT]";
    }

    return text.length > maxLength
      ? text.substring(0, maxLength) + "..."
      : text;
  }
}

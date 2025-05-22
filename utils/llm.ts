import type {
  Client,
  DecodedMessage,
  Signer,
  EncodedContent,
  Conversation,
} from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OPENAI_TOOLS, TOOL_REGISTRY } from "../tools";
import type { Character, ToolCall, ToolContext } from "../types";
import { generateCharacterContext } from "./character";
import { getCharacterResponse } from "../utils/character";
import type { MessageHistory } from "./messageHistory";
import {
  ContentTypeRemoteAttachment,
  type RemoteAttachment,
  RemoteAttachmentCodec,
  AttachmentCodec,
  type Attachment,
} from "@xmtp/content-type-remote-attachment";
import { Buffer } from "buffer";
import { uploadImageToIPFS } from "./ipfs";
import axios from "axios";

// Initialize codecs
const attachmentCodec = new AttachmentCodec();
const remoteAttachmentCodec = new RemoteAttachmentCodec();

/**
 * Fetches an encrypted remote attachment, decrypts it, and uploads it to IPFS.
 * Notifies the user about the progress via XMTP messages.
 *
 * @param remoteAttachment - The RemoteAttachment object containing metadata and URL of the encrypted file.
 * @param client - The XMTP client instance, used for decryption context.
 * @param conversation - The XMTP conversation instance to send progress updates.
 * @param character - The AI character profile for generating user notifications.
 * @param openai - The OpenAI client instance for generating notification messages.
 * @returns A Promise that resolves to an IPFS URL (e.g., "ipfs://<hash>") if successful, or undefined on failure after retries.
 */
async function fetchAndDecryptAttachment(
  remoteAttachment: RemoteAttachment & {
    decryptedData?: Uint8Array;
    decryptedMimeType?: string;
  },
  client: Client,
  conversation: Conversation,
  character: Character,
  openai: OpenAI
): Promise<string | undefined> {
  const maxRetries = 5; // Maximum number of retry attempts for fetching and processing
  const baseDelay = 3000; // Initial delay in ms for retries, doubles each time

  // Notify the user that image processing has started.
  await conversation.send(
    await getCharacterResponse({
      openai,
      character,
      prompt: `
      Tell the user you're working on processing their image and it might take a minute.
      Keep it very concise and casual.
      `,
    })
  );

  let decryptedAttachmentData: Uint8Array;
  let decryptedMimeType: string;

  if (remoteAttachment.decryptedData && remoteAttachment.decryptedMimeType) {
    console.log("Using pre-decrypted data from MessageCoordinator.");
    decryptedAttachmentData = remoteAttachment.decryptedData;
    decryptedMimeType = remoteAttachment.decryptedMimeType;
  } else {
    console.log(
      "No pre-decrypted data found, proceeding with fetch and full decryption."
    );
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`Retry attempt ${attempt + 1}, waiting ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Step 1: Download the encrypted data if not already decrypted.
        console.log("Downloading encrypted data from:", remoteAttachment.url);
        const downloadResponse = await axios.get(remoteAttachment.url, {
          responseType: "arraybuffer",
          timeout: 10000,
        });
        const encryptedData = new Uint8Array(downloadResponse.data);
        console.log(
          "Successfully downloaded encrypted data, length:",
          encryptedData.length
        );

        // Step 2: Decrypt the attachment using XMTP's RemoteAttachmentCodec.load.
        console.log("Decrypting attachment...");
        const decrypted = (await RemoteAttachmentCodec.load(
          remoteAttachment,
          client
        )) as Attachment;
        console.log("Successfully decrypted attachment");
        decryptedAttachmentData = decrypted.data;
        decryptedMimeType = decrypted.mimeType;
        break; // Break loop if successful
      } catch (error) {
        console.error(`Attempt ${attempt + 1} to fetch/decrypt failed:`, error);
        if (attempt === maxRetries - 1) {
          await conversation.send(
            await getCharacterResponse({
              openai,
              character,
              prompt: `
              Tell the user there was an issue fetching/decrypting their image. Will continue without it.
              Keep it very concise and casual.
              `,
            })
          );
          return undefined;
        }
      }
    }
    // If loop finished without breaking, it means all retries failed.
    // @ts-ignore - This check is to satisfy TS, as break should always occur on success.
    if (!decryptedAttachmentData) return undefined;
  }

  // Notify user about IPFS upload.
  try {
    await conversation.send(
      await getCharacterResponse({
        openai,
        character,
        prompt: `
        Tell the user you've got their image and are uploading it to IPFS now.
        Keep it very concise and casual.
        `,
      })
    );

    // Step 3: Convert the decrypted binary data to a base64 string for IPFS upload.
    const base64Image = Buffer.from(decryptedAttachmentData).toString("base64");

    // Step 4: Upload the base64 image data to IPFS using a helper function.
    const ipfsResponse = await uploadImageToIPFS({
      pinataConfig: { jwt: process.env.PINATA_JWT! },
      base64Image,
      name: remoteAttachment.filename,
    });

    console.log("Successfully uploaded image to IPFS:", ipfsResponse.IpfsHash);
    return `ipfs://${ipfsResponse.IpfsHash}`;
  } catch (uploadError) {
    console.error(
      "Error during IPFS upload or final user notification:",
      uploadError
    );
    await conversation.send(
      await getCharacterResponse({
        openai,
        character,
        prompt: `
        Tell the user there was an issue uploading their image to IPFS. Will continue without it.
        Keep it very concise and casual.
        `,
      })
    );
    return undefined;
  }
}

/**
 * Processes XMTP messages and generates appropriate responses.
 *
 * This function has been updated to handle coordinated messages from the MessageCoordinator.
 * Instead of trying to coordinate messages itself, it now receives pre-coordinated messages
 * where text and attachments that belong together are passed in via the relatedMessages parameter.
 *
 * For example, when a user sends:
 * 1. "Flaunch this with ticker XYZ"
 * 2. An image attachment
 *
 * The function receives:
 * - message: The most recent message (attachment in this case)
 * - relatedMessages: Array containing the text message
 *
 * This ensures that commands like "flaunch" receive both the text and image
 * context together, preventing partial processing.
 */
export async function processMessage({
  client,
  openai,
  character,
  message,
  signer,
  messageHistory,
  relatedMessages,
}: {
  client: Client;
  openai: OpenAI;
  character: Character;
  message: DecodedMessage;
  signer: Signer;
  messageHistory: MessageHistory;
  relatedMessages?: DecodedMessage[]; // Contains related messages (e.g., text message for an attachment)
}): Promise<boolean> {
  if (
    !message.content ||
    message.senderInboxId === client.inboxId ||
    message.contentType?.typeId === "wallet-send-calls"
  ) {
    return false;
  }

  const conversation = await client.conversations.getConversationById(
    message.conversationId
  );
  if (!conversation) {
    console.log("Unable to find conversation, skipping");
    return false;
  }

  try {
    let messageText: string;
    let imageUrl: string | undefined;

    // Extract content based on message type and related messages
    if (message.contentType?.sameAs(ContentTypeRemoteAttachment)) {
      try {
        // The content will have `decryptedData` and `decryptedMimeType` if MessageCoordinator succeeded.
        const remoteAttachment = message.content as RemoteAttachment & {
          decryptedData?: Uint8Array;
          decryptedMimeType?: string;
        };
        console.log("Processing remote attachment in llm.ts:", {
          filename: remoteAttachment.filename,
          hasPreDecryptedData: !!remoteAttachment.decryptedData,
        });

        // Always call fetchAndDecryptAttachment. It will use pre-decrypted data if available,
        // otherwise, it will perform the full fetch, decryption, and IPFS upload.
        imageUrl = await fetchAndDecryptAttachment(
          remoteAttachment,
          client,
          conversation,
          character,
          openai
        );

        if (imageUrl) {
          console.log(
            "Successfully processed image, final URL for LLM:",
            imageUrl
          );
        } else {
          console.log(
            "Failed to process image after fetchAndDecryptAttachment, continuing without it"
          );
        }
      } catch (error) {
        console.error("Error processing remote attachment in llm.ts:", error);
      }

      // If this is an attachment, and there was a related text message, use its content.
      if (relatedMessages && relatedMessages.length > 0) {
        messageText = relatedMessages[0].content as string;
      } else {
        messageText = ""; // Standalone image, text might be empty or in user prompt within image
      }
    } else {
      messageText = message.content as string;
    }

    // Add the processed message to history
    messageHistory.addMessage(
      message.senderInboxId,
      {
        ...message,
        content: messageText,
      } as DecodedMessage,
      false
    );

    // Get conversation history for this sender
    const history = messageHistory.getHistory(message.senderInboxId);

    // Check if this is the first message in the conversation
    const isFirstMessage = history.length === 1;

    console.log("Preparing messages for OpenAI with:", {
      messageText,
      imageUrl,
      historyLength: history.length,
      isFirstMessage,
    });

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: generateCharacterContext(character) },
      {
        role: "system",
        content: `You are ${character.name}. ${
          imageUrl
            ? `The user has sent an image. Its IPFS URL is: ${imageUrl}. Use this image for the flaunch if they want to flaunch a coin.`
            : ""
        } ${
          isFirstMessage
            ? "This is the first message in the conversation. Start with a brief, friendly introduction of yourself and your capabilities before responding to their message."
            : ""
        } Respond naturally in your character's voice. Never repeat the user's message verbatim.`,
      },
      ...history.map((entry) => ({
        role: entry.role as "user" | "assistant",
        content: entry.content,
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      tools: OPENAI_TOOLS,
      stream: true,
    });

    let fullResponse = "";
    let toolCall: ToolCall | null = null;

    for await (const chunk of completion) {
      const content = chunk.choices[0]?.delta?.content;
      const toolDelta = chunk.choices[0]?.delta?.tool_calls?.[0];

      if (content) {
        fullResponse += content;
      }

      if (toolDelta) {
        if (!toolCall) {
          toolCall = {
            id: toolDelta.id || "",
            type: "function",
            function: { name: "", arguments: "" },
          };
        }
        if (toolDelta.function?.name) {
          toolCall.function.name = toolDelta.function.name;
        }
        if (toolDelta.function?.arguments) {
          toolCall.function.arguments += toolDelta.function.arguments;
        }
      }
    }

    if (toolCall?.function.name && toolCall.function.arguments) {
      console.log("Tool call detected:", {
        name: toolCall.function.name,
        args: toolCall.function.arguments,
      });

      const rawArgs = JSON.parse(toolCall.function.arguments.trim()) as Record<
        string,
        unknown
      >;

      // Add image URL to flaunch args if present
      if (toolCall.function.name === "flaunch" && imageUrl) {
        rawArgs.image = imageUrl;
        console.log("Added image URL to flaunch args:", rawArgs);
      }

      if (toolCall.function.name in TOOL_REGISTRY) {
        const toolHandler = TOOL_REGISTRY[toolCall.function.name];
        const context: ToolContext = {
          openai,
          character,
          conversation,
          senderInboxId: message.senderInboxId,
          signer,
          client,
        };

        try {
          fullResponse = await toolHandler.handler(context, rawArgs);
          console.log("Tool handler completed successfully");
        } catch (error) {
          console.error("Error in tool handler:", error);
          throw error; // Re-throw to be caught by outer try-catch
        }
      }
    }

    if (fullResponse.length > 0) {
      console.log(`Sending ${character.name}'s response: ${fullResponse}`);
      await conversation.send(fullResponse);

      // Add the bot's response to history after sending
      const responseMessage = {
        content: fullResponse,
        senderInboxId: client.inboxId,
        conversationId: conversation.id,
        contentType: { typeId: "text" },
      } as DecodedMessage;
      messageHistory.addMessage(message.senderInboxId, responseMessage, true);

      return true;
    }

    return false;
  } catch (error) {
    console.error(
      "Error processing message in llm.ts:",
      error instanceof Error ? error.message : String(error)
    );
    await conversation.send(
      "Sorry, I encountered a problem while processing your message. Please try again."
    );
    return true;
  }
}

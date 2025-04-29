import type { Client, DecodedMessage, Signer } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OPENAI_TOOLS, TOOL_REGISTRY } from "../tools";
import type { Character, ToolCall, ToolContext } from "../types";
import { generateCharacterContext } from "./character";
import type { MessageHistory } from "./messageHistory";
import {
  ContentTypeRemoteAttachment,
  type RemoteAttachment,
} from "@xmtp/content-type-remote-attachment";

// Message processing helper
export async function processMessage({
  client,
  openai,
  character,
  message,
  signer,
  messageHistory,
}: {
  client: Client;
  openai: OpenAI;
  character: Character;
  message: DecodedMessage;
  signer: Signer;
  messageHistory: MessageHistory;
}): Promise<boolean> {
  if (
    !message.content ||
    message.senderInboxId === client.inboxId ||
    message.contentType?.typeId === "wallet-send-calls"
  ) {
    return false;
  }

  // Extract image URL from remote attachment if present
  let imageUrl: string | undefined;
  let messageText = message.content as string;

  if (message.contentType?.sameAs(ContentTypeRemoteAttachment)) {
    const attachment = message.content as RemoteAttachment;
    if (attachment.url) {
      try {
        // Parse the JSON string from the URL field
        const attachmentData = JSON.parse(attachment.url);
        imageUrl = attachmentData.url;
        messageText = attachmentData.text || "";
      } catch (error) {
        console.error("Error parsing attachment URL:", error);
      }
    }
  }

  const conversation = await client.conversations.getConversationById(
    message.conversationId
  );
  if (!conversation) {
    console.log("Unable to find conversation, skipping");
    return false;
  }

  try {
    // Add the incoming message to history before processing
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
    const isFirstMessage = history.length === 1; // Only the current message exists

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: generateCharacterContext(character) },
      {
        role: "system",
        content: `You are ${character.name}. ${
          imageUrl
            ? `The user has sent an image: ${imageUrl}. Use this image for the flaunch if they want to flaunch a coin.`
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
      const rawArgs = JSON.parse(toolCall.function.arguments.trim()) as Record<
        string,
        unknown
      >;

      // Add image URL to flaunch args if present
      if (toolCall.function.name === "flaunch" && imageUrl) {
        rawArgs.image = imageUrl;
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

        fullResponse = await toolHandler.handler(context, rawArgs);
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
      "Error processing message:",
      error instanceof Error ? error.message : String(error)
    );
    await conversation.send("Error processing message");
    return true;
  }
}

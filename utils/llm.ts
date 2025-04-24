import type { Client, DecodedMessage, Signer } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { OPENAI_TOOLS, TOOL_REGISTRY } from "../tools";
import type { Character, ToolCall, ToolContext } from "../types";
import { generateCharacterContext } from "./character";
import type { MessageHistory } from "./messageHistory";

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
    message.senderInboxId.toLowerCase() === client.inboxId.toLowerCase() ||
    message.contentType?.typeId !== "text"
  ) {
    return false;
  }

  console.log(
    `Received message: ${message.content as string} by ${message.senderInboxId}`
  );

  const conversation = await client.conversations.getConversationById(
    message.conversationId
  );
  if (!conversation) {
    console.log("Unable to find conversation, skipping");
    return false;
  }

  try {
    // Add the incoming message to history before processing
    messageHistory.addMessage(message.senderInboxId, message);

    // Get conversation history for this sender
    const history = messageHistory.getHistory(message.senderInboxId);

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: generateCharacterContext(character) },
        // Add a reminder about the character's role
        {
          role: "system",
          content: `You are ${character.name}. Respond naturally in your character's voice. Never repeat the user's message verbatim.`,
        },
        ...history, // The history already contains properly formatted role: "user" or "assistant" messages
      ],
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

import { createUSDCTransferCalls } from "../helpers/usdc";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import type { Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { z } from "zod";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";

export const sendUsdcSchema = z.object({
  amount: z
    .number()
    .describe("The amount of USDC tokens to send to the recipient"),
  recipient: z
    .string()
    .describe(
      "The recipient's Ethereum wallet address where USDC will be sent"
    ),
});

export type SendUsdcParams = z.infer<typeof sendUsdcSchema>;

async function handleUsdcTransfer({
  openai,
  character,
  conversation,
  senderInboxId,
  args,
}: {
  openai: OpenAI;
  character: Character;
  conversation: Conversation;
  senderInboxId: string;
  args: SendUsdcParams;
}): Promise<string> {
  try {
    // Validate args using Zod schema
    const validatedArgs = sendUsdcSchema.safeParse(args);

    if (!validatedArgs.success) {
      await invalidArgsResponse({
        openai,
        character,
        conversation,
        validatedArgs,
      });
      return "";
    }

    const amountInDecimals = Math.floor(
      validatedArgs.data.amount * Math.pow(10, 6)
    );
    const walletSendCalls = createUSDCTransferCalls(
      senderInboxId,
      validatedArgs.data.recipient,
      amountInDecimals
    );

    const response = await getCharacterResponse({
      openai,
      character,
      prompt: `I've prepared a transaction to send ${validatedArgs.data.amount} USDC to ${validatedArgs.data.recipient}. Tell the user to review and submit the transaction in your character's voice.`,
    });

    await conversation.send(response);
    await conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
  } catch (error: unknown) {
    console.error(
      "Transaction error:",
      error instanceof Error ? error.message : String(error)
    );
    const errorResponse = await getCharacterResponse({
      openai,
      character,
      prompt:
        "Tell the user there was an error with their transaction and to check the amount and recipient address, in your character's voice.",
    });
    await conversation.send(errorResponse);
  }
  return "";
}

export const sendUsdcTool = {
  tool: getTool({
    name: "send_usdc",
    description: "Send USDC to an address",
    schema: sendUsdcSchema,
  }),
  handler: async (
    context: ToolContext,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    return handleUsdcTransfer({
      openai: context.openai,
      character: context.character,
      conversation: context.conversation,
      senderInboxId: context.senderInboxId,
      args: args as SendUsdcParams,
    });
  },
};

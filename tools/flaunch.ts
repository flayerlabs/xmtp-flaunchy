import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import type { Client, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { z } from "zod";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";
import { getDisplayName, resolveEns } from "../utils/ens";
import { chain } from "./constants";
import { createFlaunchTransaction } from "../src/flows/utils/FlaunchTransactionUtils";

export const flaunchSchema = z.object({
  ticker: z.string().describe("The ticker of the coin to flaunch"),
  image: z.string().describe("The image of the coin to flaunch"),
  startingMarketCap: z
    .number()
    .min(100)
    .max(10000)
    .optional()
    .describe(
      "The starting market cap of the coin in USD. Between 100 and 10,000. Default: 1,000"
    ),
  fairLaunchDuration: z
    .number()
    .min(1)
    .max(60)
    .optional()
    .describe("Fair launch duration in minutes. Between 1 and 60 minutes"),
  preminePercentage: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Percentage of tokens to premine (prebuy). Between 0 and 100%"),
  buybackPercentage: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Percentage of fees to go to automated buybacks. Between 0 and 100%"
    ),
  feeReceiver: z
    .string()
    .optional()
    .describe(
      "The ETH address or .eth or .base.eth ENS of the fee receiver / creator"
    ),
});

export type FlaunchParams = z.infer<typeof flaunchSchema>;

const createFlaunchCalls = async ({
  args,
  senderInboxId,
  client,
}: {
  args: FlaunchParams;
  senderInboxId: string;
  client: Client;
}) => {
  try {
    console.log({
      flaunchArgs: args,
    });

    const inboxState = await client.preferences.inboxStateFromInboxIds([
      senderInboxId,
    ]);
    const senderAddress = inboxState[0].identifiers[0].identifier;

    // Get the creator's address - either from feeReceiver or inboxId
    let creatorAddress: string;
    if (args.feeReceiver) {
      console.log("Resolving ENS for fee receiver:", args.feeReceiver);
      const resolvedAddress = await resolveEns(args.feeReceiver);
      if (!resolvedAddress) {
        throw new Error(`Could not resolve ENS name: ${args.feeReceiver}`);
      }
      creatorAddress = resolvedAddress;
      console.log("Resolved fee receiver address:", creatorAddress);
    } else {
      creatorAddress = senderAddress;
      console.log("Using sender address as creator:", creatorAddress);
    }

    // Calculate creator fee allocation based on buyback percentage
    let creatorFeeAllocationPercent = 100; // Match Group Flaunch default
    if (args.buybackPercentage) {
      creatorFeeAllocationPercent = 100 - args.buybackPercentage;
    }

    // Use centralized transaction creation function
    return await createFlaunchTransaction({
      name: args.ticker,
      ticker: args.ticker,
      image: args.image,
      creatorAddress,
      senderInboxId,
      chain,
      treasuryManagerAddress: creatorAddress, // For simple flaunch, creator is the treasury manager
      fairLaunchPercent: 10, // Match Group Flaunch default
      fairLaunchDuration: (args.fairLaunchDuration || 0) * 60, // Convert to seconds
      startingMarketCapUSD: args.startingMarketCap ?? 1000,
      creatorFeeAllocationPercent,
      preminePercentage: args.preminePercentage || 0,
    });
  } catch (error) {
    console.error("Error in createFlaunchCalls:", error);
    throw error;
  }
};

async function handleFlaunch({
  openai,
  character,
  conversation,
  senderInboxId,
  args,
  client,
}: {
  openai: OpenAI;
  character: Character;
  conversation: Conversation;
  senderInboxId: string;
  args: FlaunchParams;
  client: Client;
}): Promise<string> {
  try {
    // Validate args using Zod schema
    const validatedArgs = flaunchSchema.safeParse(args);

    if (!validatedArgs.success) {
      await invalidArgsResponse({
        openai,
        character,
        conversation,
        validatedArgs,
      });
      return "";
    }

    if (validatedArgs.data.image) {
      await conversation.send(
        await getCharacterResponse({
          openai,
          character,
          prompt: `
        I've started uploading the image to ipfs for ticker: ${validatedArgs.data.ticker}.
        Tell the user to wait a bit for the transaction request in your character's voice.
        Keep the response very very concise and to the point. Make sure to mention that the transaction request is upcoming.
        `,
        })
      );
    }

    const walletSendCalls = await createFlaunchCalls({
      args: validatedArgs.data,
      senderInboxId,
      client,
    });

    await conversation.send(
      await getCharacterResponse({
        openai,
        character,
        prompt: `
      I've prepared a transaction to flaunch ${validatedArgs.data.ticker}.
      Tell the user to review and submit the transaction in your character's voice.
      Keep the response concise and to the point.
      `,
      })
    );

    console.log({
      walletSendCalls: JSON.stringify(walletSendCalls, null, 2),
    });

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

export const flaunchTool = {
  tool: getTool({
    name: "flaunch",
    description: `
This tool allows launching a new coin using the Flaunch protocol. 10% of the supply is allocated to the fair launch, creator gets 100% of the fees.

It takes:
- ticker: The ticker of the coin to flaunch

- image: Attach the image of the coin to flaunch or the user can provide the image url.
- startingMarketCap: (optional) The starting market cap of the coin in USD. Between 100 and 10,000
- fairLaunchDuration: (optional) Fair launch duration in minutes. Between 1 and 60 minutes
- preminePercentage: (optional) Percentage of tokens to premine (prebuy). Between 0 and 100%
- buybackPercentage: (optional) Percentage of fees to go to automated buybacks. Between 0 and 100%
- feeReceiver: (optional) The ETH address of the creator that receives the fees

If the required fields (ticker, image) are not provided, ask the user to provide them. Ignore the optional fields.
`,
    llmInstructions:
      "DON'T hallucinate or make up a ticker if the user doesn't provide one. Ask for the ticker if it's not provided.",
    schema: flaunchSchema,
  }),
  handler: async (
    context: ToolContext,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    return handleFlaunch({
      openai: context.openai,
      character: context.character,
      conversation: context.conversation,
      senderInboxId: context.senderInboxId,
      args: args as FlaunchParams,
      client: context.client,
    });
  },
};

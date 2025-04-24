import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import type { Client, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { z } from "zod";
import { FlaunchPositionManagerAbi } from "../abi/FlaunchPositionManager";
import { FlaunchPositionManagerAddress } from "../addresses";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";
import { generateTokenUri } from "../utils/ipfs";

const chain = baseSepolia;
const TOTAL_SUPPLY = 100n * 10n ** 27n; // 100 Billion tokens in wei

export const flaunchSchema = z.object({
  ticker: z.string().describe("The ticker of the coin to flaunch"),
  image: z.string().optional().describe("The image of the coin to flaunch"),
  startingMarketCap: z
    .number()
    .min(100)
    .max(10000)
    .optional()
    .describe(
      "The starting market cap of the coin in USD. Between 100 and 10,000"
    ),
  feeReceivers: z
    .array(z.string())
    .optional()
    .describe("The addresses of the fee receivers"),
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
  const initialMarketCapUSD = args.startingMarketCap ?? 10_000;
  const initialMCapInUSDCWei = parseUnits(initialMarketCapUSD.toString(), 6);
  const initialPriceParams = encodeAbiParameters(
    [
      {
        type: "uint256",
      },
    ],
    [initialMCapInUSDCWei]
  );

  const fairLaunchPercent = 60;
  const fairLaunchInBps = BigInt(fairLaunchPercent * 100);

  const creatorFeeAllocationPercent = 80;
  const creatorFeeAllocationInBps = creatorFeeAllocationPercent * 100;

  // Get the creator's address from the inboxId
  const inboxState = await client.preferences.inboxStateFromInboxIds([
    senderInboxId,
  ]);
  const creatorAddress = inboxState[0].identifiers[0].identifier;

  // upload image & token uri to ipfs
  const tokenUri = await generateTokenUri(args.ticker, {
    pinataConfig: { jwt: process.env.PINATA_JWT! },
    metadata: {
      imageUrl: args.image ?? "",
      description: "Flaunched via Flaunchy on XMTP",
      websiteUrl: "",
      discordUrl: "",
      twitterUrl: "",
      telegramUrl: "",
    },
  });

  const data = encodeFunctionData({
    abi: FlaunchPositionManagerAbi,
    functionName: "flaunch",
    args: [
      {
        name: args.ticker,
        symbol: args.ticker.toUpperCase(),
        tokenUri: tokenUri,
        initialTokenFairLaunch: (TOTAL_SUPPLY * fairLaunchInBps) / 10_000n,
        premineAmount: 0n,
        creator: creatorAddress as Address,
        creatorFeeAllocation: creatorFeeAllocationInBps,
        flaunchAt: 0n,
        initialPriceParams,
        feeCalculatorParams: "0x",
      },
    ],
  });

  return {
    version: "1.0",
    from: senderInboxId as Hex,
    chainId: "0x" + chain.id.toString(16),
    calls: [
      {
        to: FlaunchPositionManagerAddress[chain.id],
        data,
        metadata: {
          description: `Flaunch ${args.ticker} on Base Sepolia`,
        },
      },
    ],
  };
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

    const walletSendCalls = await createFlaunchCalls({
      args: validatedArgs.data,
      senderInboxId,
      client,
    });

    const response = await getCharacterResponse({
      openai,
      character,
      prompt: `I've prepared a transaction to flaunch ${validatedArgs.data.ticker}. Tell the user to review and submit the transaction in your character's voice.`,
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

export const flaunchTool = {
  tool: getTool({
    name: "flaunch",
    // FIXME: make it descriptive in terms of the params to pass
    description: "Flaunch a new coin",
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

import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import type { Client, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseUnits,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { FlaunchZapAddress } from "../addresses";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";
import { generateTokenUri } from "../utils/ipfs";
import { FlaunchZapAbi } from "../abi/FlaunchZap";
import { getDisplayName, resolveEns } from "../utils/ens";
import { chain, TOTAL_SUPPLY } from "./constants";
import { numToHex } from "../utils/hex";

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
  feeReceiver: z
    .string()
    .optional()
    .describe(
      "The ETH address or .eth or .base.eth ENS of the fee receiver / creator"
    ),
  // feeReceivers: z
  //   .array(z.string())
  //   .optional()
  //   .describe("The addresses of the fee receivers"),
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

    // upload image & token uri to ipfs
    let tokenUri = "";
    if (args.image) {
      tokenUri = await generateTokenUri(args.ticker, {
        pinataConfig: { jwt: process.env.PINATA_JWT! },
        metadata: {
          imageUrl: args.image,
          description: "Flaunched via Flaunchy on XMTP",
          websiteUrl: "",
          discordUrl: "",
          twitterUrl: "",
          telegramUrl: "",
        },
      });
      console.log("Generated token URI:", tokenUri);
    }

    // Prepare flaunch params
    const flaunchParams = {
      name: args.ticker,
      symbol: args.ticker,
      tokenUri,
      initialTokenFairLaunch: (TOTAL_SUPPLY * fairLaunchInBps) / 10000n,
      fairLaunchDuration: 0n,
      premineAmount: 0n,
      creator: creatorAddress as `0x${string}`,
      creatorFeeAllocation: creatorFeeAllocationInBps,
      flaunchAt: 0n,
      initialPriceParams,
      feeCalculatorParams: "0x" as `0x${string}`,
    };

    console.log("Prepared flaunch params:", flaunchParams);

    // Encode the flaunch function call
    const functionData = encodeFunctionData({
      abi: FlaunchZapAbi,
      functionName: "flaunch",
      args: [flaunchParams],
    });

    console.log("Encoded function data");

    // Resolve ENS names for display
    const creatorDisplayName = await getDisplayName(creatorAddress);

    // Return the wallet send calls
    return {
      version: "1.0",
      from: senderInboxId,
      chainId: numToHex(chain.id),
      calls: [
        {
          chainId: chain.id,
          to: FlaunchZapAddress[chain.id],
          data: functionData,
          value: "0",
          metadata: {
            description: `Flaunching $${args.ticker} on ${chain.name}\nFor Creator: ${creatorDisplayName}`,
          },
        },
      ],
    };
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
This tool allows launching a new coin using the Flaunch protocol. 60% of the supply is allocated to the fair launch, creator gets 80% of the fees.

It takes:
- ticker: The ticker of the coin to flaunch

- image: (optional) Attach the image of the coin to flaunch or the user can provide the image url.
- startingMarketCap: (optional) The starting market cap of the coin in USD. Between 100 and 10,000
- feeReceiver: (optional) The ETH address of the creator that receives the fees

If the required fields are not provided, ask the user to provide them. Ignore the optional fields.
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

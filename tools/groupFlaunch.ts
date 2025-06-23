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
import { AddressFeeSplitManagerAddress, FlaunchZapAddress } from "../addresses";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";
import { generateTokenUri } from "../utils/ipfs";
import { FlaunchZapAbi } from "../abi/FlaunchZap";
import { chain, TOTAL_SUPPLY } from "./constants";
import { numToHex } from "../utils/hex";
import { getDisplayName } from "../utils/ens";

export const groupFlaunchSchema = z.object({
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
});

export type GroupFlaunchParams = z.infer<typeof groupFlaunchSchema>;

const createGroupFlaunchCalls = async ({
  args,
  senderInboxId,
  client,
  conversation,
}: {
  args: GroupFlaunchParams;
  senderInboxId: string;
  client: Client;
  conversation: Conversation;
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

    // Get the creator's address - from inboxId
    const creatorAddress = senderAddress;

    // Get all the participants from the group, except the sender and this bot
    const members = await conversation.members();
    const feeReceivers: Address[] = [];

    console.log(`Found ${members.length} total members in the group`);
    console.log(`Group members analysis:`);
    console.log(`- Sender InboxId: ${senderInboxId}`);
    console.log(`- Bot InboxId: ${client.inboxId}`);

    for (const member of members) {
      console.log(`Processing member: ${member.inboxId}`);
      
      // Skip the sender and the bot
      if (
        member.inboxId !== senderInboxId &&
        member.inboxId !== client.inboxId
      ) {
        console.log(`  → Including member ${member.inboxId} as fee receiver`);
        
        // Get the address for this member
        const memberInboxState =
          await client.preferences.inboxStateFromInboxIds([member.inboxId]);
        if (
          memberInboxState.length > 0 &&
          memberInboxState[0].identifiers.length > 0
        ) {
          const memberAddress = memberInboxState[0].identifiers[0]
            .identifier as Address;
          feeReceivers.push(memberAddress);
          console.log(`  → Added fee receiver: ${memberAddress}`);
        } else {
          console.log(`  → Could not get address for member ${member.inboxId}`);
        }
      } else {
        const reason = member.inboxId === senderInboxId ? 'sender' : 'bot';
        console.log(`  → Skipping member ${member.inboxId} (${reason})`);
      }
    }

    console.log(`Total fee receivers that will be included in transaction: ${feeReceivers.length}`);
    console.log(`Fee receiver addresses:`, feeReceivers);

    const VALID_SHARE_TOTAL = 100_00000n; // 5 decimals as BigInt
    const totalParticipants = BigInt(feeReceivers.length + 1); // +1 for the creator
    const sharePerAddress = VALID_SHARE_TOTAL / totalParticipants;
    const remainder = VALID_SHARE_TOTAL % totalParticipants;

    // Generate initialize data for the fee split manager
    const recipientShares = feeReceivers.map((receiver) => ({
      recipient: receiver,
      share: sharePerAddress,
    }));

    // Creator gets the base share plus any rounding remainder to ensure a valid share total
    const creatorShare = sharePerAddress + remainder;

    const initializeData = encodeAbiParameters(
      [
        {
          type: "tuple",
          name: "params",
          components: [
            { type: "uint256", name: "creatorShare" },
            {
              type: "tuple[]",
              name: "recipientShares",
              components: [
                { type: "address", name: "recipient" },
                { type: "uint256", name: "share" },
              ],
            },
          ],
        },
      ],
      [
        {
          creatorShare,
          recipientShares,
        },
      ]
    );

    // upload image & token uri to ipfs
    let tokenUri = "";
    if (args.image) {
      console.log("Generating token URI with image:", args.image);
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
    const treasuryManagerParams = {
      manager: AddressFeeSplitManagerAddress[chain.id],
      initializeData: initializeData as `0x${string}`,
      depositData: "0x" as `0x${string}`,
    };
    const whitelistParams = {
      merkleRoot: zeroHash,
      merkleIPFSHash: "",
      maxTokens: 0n,
    };
    const airdropParams = {
      airdropIndex: 0n,
      airdropAmount: 0n,
      airdropEndTime: 0n,
      merkleRoot: zeroHash,
      merkleIPFSHash: "",
    };

    console.log("Prepared flaunch params:", {
      flaunchParams,
      creatorShare,
      recipientShares,
      treasuryManagerParams,
      whitelistParams,
      airdropParams,
    });

    // Encode the flaunch function call
    const functionData = encodeFunctionData({
      abi: FlaunchZapAbi,
      functionName: "flaunch",
      args: [
        flaunchParams,
        whitelistParams,
        airdropParams,
        treasuryManagerParams,
      ],
    });

    console.log("Encoded function data");

    // Calculate percentages for display with proper precision
    const creatorPercentage =
      (Number(creatorShare) / Number(VALID_SHARE_TOTAL)) * 100;
    const recipientPercentage =
      (Number(sharePerAddress) / Number(VALID_SHARE_TOTAL)) * 100;

    // Resolve ENS names for display
    const creatorDisplayName = await getDisplayName(creatorAddress);
    const recipientDisplayNames = await Promise.all(
      feeReceivers.map((addr) => getDisplayName(addr))
    );

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
            description: `Flaunching $${args.ticker} for the group on ${
              chain.name
            }\nwith Fee splits:\nCreator: ${creatorPercentage.toFixed(
              2
            )}% - ${creatorDisplayName}\nRecipients:\n${recipientDisplayNames
              .map((name) => `${recipientPercentage.toFixed(2)}% - ${name}`)
              .join("\n")}`,
          },
        },
      ],
    };
  } catch (error) {
    console.error("Error in createFlaunchCalls:", error);
    throw error;
  }
};

async function handleGroupFlaunch({
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
  args: GroupFlaunchParams;
  client: Client;
}): Promise<string> {
  try {
    // Validate args using Zod schema
    const validatedArgs = groupFlaunchSchema.safeParse(args);

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

    const walletSendCalls = await createGroupFlaunchCalls({
      args: validatedArgs.data,
      senderInboxId,
      client,
      conversation,
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

export const groupFlaunchTool = {
  tool: getTool({
    name: "group_flaunch",
    description: `
This Group Flaunch tool allows launching a new coin using the Flaunch protocol. 80% of the fees are equally split between the group members. 60% of the supply is allocated to the fair launch.

It takes:
- ticker: The ticker of the coin to flaunch

- image: (optional) Attach the image of the coin to flaunch or the user can provide the image url.
- startingMarketCap: (optional) The starting market cap of the coin in USD. Between 100 and 10,000

If the required fields are not provided, ask the user to provide them. Ignore the optional fields.
`,
    llmInstructions:
      "DON'T hallucinate or make up a ticker if the user doesn't provide one. Ask for the ticker if it's not provided.",
    schema: groupFlaunchSchema,
  }),
  handler: async (
    context: ToolContext,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    return handleGroupFlaunch({
      openai: context.openai,
      character: context.character,
      conversation: context.conversation,
      senderInboxId: context.senderInboxId,
      args: args as GroupFlaunchParams,
      client: context.client,
    });
  },
};

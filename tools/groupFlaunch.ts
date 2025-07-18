import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import type { Client, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { encodeAbiParameters, type Address } from "viem";
import { z } from "zod";
import { AddressFeeSplitManagerAddress } from "../addresses";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool, invalidArgsResponse } from "../utils/tool";
import { chain } from "./constants";
import { getDisplayName } from "../utils/ens";
import { createFlaunchTransaction } from "../src/flows/utils/FlaunchTransactionUtils";

export const groupFlaunchSchema = z.object({
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

    const fairLaunchPercent = 10;
    const creatorFeeAllocationPercent = 100;

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

      // Skip the sender (coin creator) and the bot
      if (
        member.inboxId !== senderInboxId &&
        member.inboxId !== client.inboxId
      ) {
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
        const reason = member.inboxId === senderInboxId ? "creator" : "bot";
        console.log(`  → Skipping member ${member.inboxId} (${reason})`);
      }
    }

    console.log(
      `Total fee receivers before deduplication: ${feeReceivers.length}`
    );
    console.log(`Fee receiver addresses before deduplication:`, feeReceivers);

    // Deduplicate fee receivers - get unique addresses (case-insensitive)
    const VALID_SHARE_TOTAL = 100_00000n; // 5 decimals as BigInt

    // First pass: calculate equal share per unique address (case-insensitive)
    const uniqueFeeReceivers = [
      ...new Set(feeReceivers.map((addr) => addr.toLowerCase() as Address)),
    ];

    // Calculate equal shares for all participants (creator + receivers)
    const totalRecipients = BigInt(uniqueFeeReceivers.length);
    const totalParticipants = totalRecipients + 1n; // +1 for creator

    // Creator gets 1/(n+1) of total fees
    const creatorShare = VALID_SHARE_TOTAL / totalParticipants;
    const creatorRemainder = VALID_SHARE_TOTAL % totalParticipants;
    const adjustedCreatorShare = creatorShare + creatorRemainder; // Add remainder to creator

    // Recipients array must sum to 100% - each recipient gets equal share of this
    const sharePerRecipient = VALID_SHARE_TOTAL / totalRecipients;
    const remainder = VALID_SHARE_TOTAL % totalRecipients;

    // Generate initialize data for the fee split manager using deduplicated addresses
    const recipientShares = uniqueFeeReceivers.map((receiver, index) => ({
      recipient: receiver,
      share: sharePerRecipient + (index === 0 ? remainder : 0n), // Add remainder to first recipient
    }));

    // Verify total recipient shares equal 100%
    const totalRecipientShares = recipientShares.reduce(
      (sum, rs) => sum + rs.share,
      0n
    );
    if (totalRecipientShares !== VALID_SHARE_TOTAL) {
      throw new Error(
        `Recipient shares total ${totalRecipientShares} but should be ${VALID_SHARE_TOTAL}`
      );
    }

    console.log(
      `Total fee receivers after deduplication: ${uniqueFeeReceivers.length}`
    );
    console.log(
      `Equal distribution: each participant gets ~${(
        (Number(VALID_SHARE_TOTAL / totalParticipants) /
          Number(VALID_SHARE_TOTAL)) *
        100
      ).toFixed(5)}%`
    );
    console.log(
      `Creator share: ${adjustedCreatorShare.toString()} (${(
        (Number(adjustedCreatorShare) / Number(VALID_SHARE_TOTAL)) *
        100
      ).toFixed(5)}%)`
    );
    console.log(
      `Deduplicated fee receiver shares:`,
      recipientShares.map((rs) => ({
        address: rs.recipient,
        share: rs.share.toString(),
        percentage:
          ((Number(rs.share) / Number(VALID_SHARE_TOTAL)) * 100).toFixed(5) +
          "%",
      }))
    );

    // Verify equal distribution math
    const creatorEffective = adjustedCreatorShare;
    const receiverEffective =
      (VALID_SHARE_TOTAL - adjustedCreatorShare) / totalRecipients;
    console.log(`Effective distribution verification:`, {
      creator:
        ((Number(creatorEffective) / Number(VALID_SHARE_TOTAL)) * 100).toFixed(
          5
        ) + "%",
      eachReceiver:
        ((Number(receiverEffective) / Number(VALID_SHARE_TOTAL)) * 100).toFixed(
          5
        ) + "%",
    });

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
          creatorShare: adjustedCreatorShare,
          recipientShares,
        },
      ]
    );

    console.log("Prepared group flaunch params:", {
      creatorShare: adjustedCreatorShare,
      recipientShares,
      initializeData,
    });

    // Calculate creator fee allocation based on buyback percentage
    let adjustedCreatorFeeAllocationPercent = creatorFeeAllocationPercent;
    if (args.buybackPercentage) {
      adjustedCreatorFeeAllocationPercent =
        creatorFeeAllocationPercent - args.buybackPercentage;
    }

    // Use centralized transaction creation function
    return await createFlaunchTransaction({
      name: args.ticker,
      ticker: args.ticker,
      image: args.image,
      creatorAddress,
      senderInboxId,
      chain,
      treasuryManagerAddress: AddressFeeSplitManagerAddress[chain.id],
      treasuryInitializeData: initializeData,
      fairLaunchPercent,
      fairLaunchDuration: (args.fairLaunchDuration || 0) * 60, // Convert to seconds
      startingMarketCapUSD: args.startingMarketCap ?? 1000,
      creatorFeeAllocationPercent: adjustedCreatorFeeAllocationPercent,
      preminePercentage: args.preminePercentage || 0,
    });
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

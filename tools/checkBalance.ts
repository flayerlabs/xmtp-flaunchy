import { getUSDCBalance } from "../helpers/usdc";
import type OpenAI from "openai";
import { z } from "zod";
import type { Character, ToolContext } from "../types";
import { getCharacterResponse } from "../utils/character";
import { getTool } from "../utils/tool";

export const checkBalanceSchema = z.object({
  address: z.string().describe("The Ethereum address to check the balance for"),
});

export type CheckBalanceParams = z.infer<typeof checkBalanceSchema>;

async function handleBalanceCheck({
  openai,
  character,
  args,
}: {
  openai: OpenAI;
  character: Character;
  args: CheckBalanceParams;
}): Promise<string> {
  try {
    const balance = await getUSDCBalance(args.address);
    return await getCharacterResponse({
      openai,
      character,
      prompt: `The USDC balance is ${balance} USDC. Respond with this information in your character's voice.`,
    });
  } catch (error: unknown) {
    console.error(
      "Balance check error:",
      error instanceof Error ? error.message : String(error)
    );
    return "Sorry, I couldn't check the balance. Please make sure the address is correct.";
  }
}

export const checkBalanceTool = {
  tool: getTool({
    name: "check_balance",
    description: "Check the USDC balance of an address",
    schema: checkBalanceSchema,
  }),
  handler: async (context: ToolContext): Promise<string> => {
    const identifier = await context.signer.getIdentifier();
    return handleBalanceCheck({
      openai: context.openai,
      character: context.character,
      args: {
        address: identifier.identifier,
      },
    });
  },
};

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolRegistry } from "../types";
import { checkBalanceTool } from "./checkBalance";
import { flaunchTool } from "./flaunch";
import { sendUsdcTool } from "./sendUsdc";
import { groupFlaunchTool } from "./groupFlaunch";

// Registry of all available tools with their handlers
export const TOOL_REGISTRY: ToolRegistry = {
  // check_balance: checkBalanceTool,
  // send_usdc: sendUsdcTool,
  flaunch: flaunchTool,
  group_flaunch: groupFlaunchTool,
};

// Export tools array for OpenAI
export const OPENAI_TOOLS: ChatCompletionTool[] = Object.values(
  TOOL_REGISTRY
).map(({ tool }) => tool);

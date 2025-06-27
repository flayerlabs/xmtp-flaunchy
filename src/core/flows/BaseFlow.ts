import { FlowContext } from "../types/FlowContext";
import { isAddress } from "viem";

export abstract class BaseFlow {
  protected name: string;

  constructor(name: string) {
    this.name = name;
  }

  abstract processMessage(context: FlowContext): Promise<void>;

  // Common utility methods that all flows can use
  protected async sendResponse(
    context: FlowContext,
    message: string
  ): Promise<void> {
    // Log the outgoing agent reply
    this.log("🤖 AGENT REPLY", {
      userId: context.userState?.userId || "unknown",
      message: message,
      timestamp: new Date().toISOString(),
      messageLength: message.length,
    });

    await context.conversation.send(message);
  }

  protected extractMessageText(context: FlowContext): string {
    // The EnhancedMessageCoordinator already handles message text extraction properly
    // and provides it in the FlowContext.messageText field, which includes:
    // - Direct text content for text messages
    // - Text from related messages when the primary message is an attachment
    return context.messageText;
  }

  protected hasAttachment(context: FlowContext): boolean {
    return context.hasAttachment;
  }

  protected log(message: string, data?: any): void {
    console.log(`[${this.name}] ${message}`, data || "");
  }

  protected logError(message: string, error?: any): void {
    console.error(`[${this.name}] ${message}`, error || "");
  }

  // Helper for parsing common input patterns
  protected parseCommaSeparatedList(input: string): string[] {
    return input
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  // Helper for validating Ethereum addresses
  protected isValidEthereumAddress(address: string): boolean {
    return isAddress(address);
  }

  // Helper for parsing percentages
  protected parsePercentage(input: string): number | null {
    const match = input.match(/(\d+(?:\.\d+)?)\s*%?$/);
    if (match) {
      const value = parseFloat(match[1]);
      return value >= 0 && value <= 100 ? value : null;
    }
    return null;
  }
}

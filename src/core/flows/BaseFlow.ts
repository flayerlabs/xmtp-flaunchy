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

  // Centralized cancellation detection
  protected async detectCancellation(context: FlowContext, messageText: string): Promise<boolean> {
    if (!messageText) return false;

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Does this message request to CANCEL or STOP a pending transaction? "${messageText}" 
          
          Look for requests like:
          - "cancel"
          - "cancel that"
          - "stop"
          - "abort"
          - "nevermind"
          - "cancel transaction"
          - "stop the transaction"
          - "don't do that"
          - "cancel it"
          - "abort that"
          
          Answer only "yes" or "no".`
        }],
        temperature: 0.1,
        max_tokens: 5
      });

      const result = response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
      
      if (result) {
        this.log('Cancellation detected', {
          messageText: messageText.substring(0, 50),
          userId: context.userState.userId.substring(0, 8) + "..."
        });
      }
      
      return result;
    } catch (error) {
      this.logError('Failed to detect cancellation intent', error);
      return false;
    }
  }

  // Centralized transaction cancellation
  protected async cancelTransaction(context: FlowContext): Promise<void> {
    // Clear all transaction-related state comprehensively
    await context.updateState({
      pendingTransaction: undefined,
      managementProgress: undefined,
      // Clear onboarding group data if it exists
      onboardingProgress: context.userState.onboardingProgress ? {
        ...context.userState.onboardingProgress,
        splitData: undefined
      } : undefined,
      // Clear coin launch progress if it exists
      coinLaunchProgress: undefined
    });
    
    this.log('Transaction cancelled', {
      userId: context.userState.userId.substring(0, 8) + "..."
    });
  }
}

import { FlowContext } from "../types/FlowContext";

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
      userId:
        context.participantState?.address ||
        context.creatorAddress ||
        "unknown",
      message: message,
    });

    await context.conversation.send(message);
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

  // Centralized transaction cancellation
  protected async cancelTransaction(context: FlowContext): Promise<void> {
    // Clear all transaction-related state comprehensively
    await context.updateParticipantState({
      pendingTransaction: undefined,
      managementProgress: undefined,
      // Clear onboarding progress data if it exists
      onboardingProgress: context.participantState.onboardingProgress
        ? {
            ...context.participantState.onboardingProgress,
            splitData: undefined,
          }
        : undefined,
      // Clear coin launch progress if it exists
      coinLaunchProgress: undefined,
    });

    this.log("Transaction cancelled", {
      userId: context.participantState.address.substring(0, 8) + "...",
    });
  }
}

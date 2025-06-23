import { FlowContext } from "../types/FlowContext";

export abstract class BaseFlow {
  protected name: string;

  constructor(name: string) {
    this.name = name;
  }

  abstract processMessage(context: FlowContext): Promise<void>;

  // Common utility methods that all flows can use
  protected async sendResponse(context: FlowContext, message: string): Promise<void> {
    // Log the outgoing agent reply
    this.log('🤖 AGENT REPLY', {
      userId: context.userState?.userId || 'unknown',
      message: message,
      timestamp: new Date().toISOString(),
      messageLength: message.length
    });
    
    await context.conversation.send(message);
  }

  protected extractMessageText(context: FlowContext): string {
    if (typeof context.message.content === 'string') {
      return context.message.content.trim();
    }
    
    // Handle other content types if needed
    return '';
  }

  protected hasAttachment(context: FlowContext): boolean {
    return context.hasAttachment;
  }

  protected log(message: string, data?: any): void {
    console.log(`[${this.name}] ${message}`, data || '');
  }

  protected logError(message: string, error?: any): void {
    console.error(`[${this.name}] ${message}`, error || '');
  }

  // Helper for parsing common input patterns
  protected parseCommaSeparatedList(input: string): string[] {
    return input
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  // Helper for validating Ethereum addresses
  protected isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
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
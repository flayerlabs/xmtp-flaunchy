import { FlowContext } from "../types/FlowContext";
import { isAddress } from "viem";

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
    
    // Handle attachment messages with JSON URLs containing text
    if (context.hasAttachment && context.attachment) {
      try {
        const attachment = context.attachment;
        
        // Check if the attachment URL is a JSON string containing text
        if (typeof attachment.url === 'string' && attachment.url.startsWith('{') && attachment.url.endsWith('}')) {
          const parsed = JSON.parse(attachment.url);
          if (parsed.text && typeof parsed.text === 'string') {
            this.log('Extracted text from JSON attachment URL', { 
              extractedText: parsed.text,
              originalUrl: attachment.url.substring(0, 100) + '...'
            });
            return parsed.text.trim();
          }
        }
      } catch (error) {
        this.logError('Failed to extract text from JSON attachment URL', error);
      }
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
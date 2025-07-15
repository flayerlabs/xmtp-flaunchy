import type { Client, Conversation, Signer } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { Address, Hex } from "viem";

/**
 * Configuration for an agent character
 */
export type Character = {
  /** Character name */
  name: string;

  /** Model provider to use */
  modelProvider: string;

  /** Optional system prompt */
  system?: string;

  /** Character biography */
  bio: string[];

  /** Character background lore */
  lore: string[];

  /** Optional knowledge base */
  knowledge?: (
    | string
    | { path: string; shared?: boolean }
    | { directory: string; shared?: boolean }
  )[];

  /** Example messages */
  messageExamples: MessageExample[][];

  /** Example posts */
  postExamples: string[];

  /** Known topics */
  topics: string[];

  /** Writing style guides */
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };

  /** Character traits */
  adjectives: string[];
};

/**
 * Example message for demonstration
 */
export interface MessageExample {
  /** Associated user */
  user: string;

  /** Message content */
  content: Content;
}

/**
 * Represents the content of a message or communication
 */
export interface Content {
  /** The main text content */
  text: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolContext {
  openai: OpenAI;
  character: Character;
  conversation: Conversation<any>;
  senderInboxId: string;
  signer: Signer;
  client: Client<any>;
}

export interface ToolHandler {
  tool: ChatCompletionTool;
  handler: (
    context: ToolContext,
    args?: Record<string, unknown>
  ) => Promise<string>;
}

export type ToolRegistry = Record<string, ToolHandler>;

export interface TransactionReferenceMessage {
  content: {
    transactionReference: {
      networkId: Hex;
      reference: Hex; // transaction hash
      metadata: {
        transactionType: string;
        fromAddress: Address;
      };
    };
  };
}

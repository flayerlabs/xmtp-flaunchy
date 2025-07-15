import type {
  Client,
  Conversation,
  DecodedMessage,
  Signer,
} from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { Character } from "../../../types";
import type { UserState, GroupState } from "./UserState";
import type { SessionManager } from "../session/SessionManager";
import type { ENSResolverService } from "../../services/ENSResolverService";
import type {
  UnifiedRoutingResult,
  MultiIntentResult,
} from "../flows/FlowRouter";

export interface FlowContext {
  // Core XMTP objects
  client: Client<any>;
  conversation: Conversation<any>;
  message: DecodedMessage;
  signer: Signer;

  // AI and character
  openai: OpenAI;
  character: Character;

  // User state and identification
  userState: UserState;
  senderInboxId: string;
  creatorAddress: string;

  // Group context
  groupId: string;
  groupState: GroupState;

  // Session management
  sessionManager: SessionManager;

  // Services
  ensResolver: ENSResolverService;

  // Message context
  messageText: string;
  hasAttachment: boolean;
  attachment?: any;
  relatedMessages?: DecodedMessage[];
  conversationHistory: DecodedMessage[];
  isDirectMessage: boolean;

  // Detection results from FlowRouter (avoids redundant LLM calls)
  detectionResult?: UnifiedRoutingResult;

  // Multi-intent detection results for new routing system
  multiIntentResult?: MultiIntentResult;

  // Helper functions
  sendResponse: (message: string) => Promise<void>;
  updateState: (updates: Partial<UserState>) => Promise<void>;

  // Group-specific state management
  updateGroupState: (updates: Partial<GroupState>) => Promise<void>;
  clearGroupState: () => Promise<void>;

  // Utility functions
  resolveUsername: (username: string) => Promise<string | undefined>;
  processImageAttachment: (attachment: any) => Promise<string>;
}

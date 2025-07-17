import type {
  Client,
  Conversation,
  DecodedMessage,
  Signer,
} from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { Character } from "../../../types";
import type {
  GroupChatState,
  GroupParticipant,
  AggregatedUserData,
} from "./GroupState";
import type { SessionManager } from "../session/SessionManager";
import type { ENSResolverService } from "../../services/ENSResolverService";
import type {
  UnifiedRoutingResult,
  MultiIntentResult,
} from "../flows/FlowRouter";
import { Address } from "viem";

export interface FlowContext {
  // Core XMTP objects
  client: Client<any>;
  conversation: Conversation<any>;
  message: DecodedMessage;
  signer: Signer;

  // AI and character
  openai: OpenAI;
  character: Character;

  // Group-centric state
  groupState: GroupChatState;
  participantState: GroupParticipant;

  // User identification
  senderInboxId: string;
  creatorAddress: Address;

  // Group context
  groupId: string;

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

  // Group-centric state management
  updateGroupState: (
    updates: Partial<Omit<GroupChatState, "groupId" | "createdAt">>
  ) => Promise<void>;
  updateParticipantState: (
    updates: Partial<Omit<GroupParticipant, "address" | "joinedAt">>
  ) => Promise<void>;
  clearParticipantProgress: () => Promise<void>;

  // User data aggregation (backwards compatibility)
  getUserAggregatedData: () => Promise<AggregatedUserData>;

  // Utility functions
  resolveUsername: (username: string) => Promise<string | undefined>;
  processImageAttachment: (attachment: any) => Promise<string>;
}

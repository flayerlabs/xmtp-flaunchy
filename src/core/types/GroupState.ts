import {
  UserPreferences,
  OnboardingProgress,
  ManagementProgress,
  CoinLaunchProgress,
  PendingTransaction,
} from "./UserState";

/**
 * Main group state interface - represents a group chat and all its data
 * Keyed by group chat ID in the storage
 */
export interface GroupChatState {
  groupId: string; // The group chat ID (conversation.id)
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    name?: string;
    description?: string;
  };
  participants: Record<string, GroupParticipant>; // keyed by user address
  managers: GroupManager[]; // Deployed managers for this group
  coins: GroupCoin[]; // Launched coins for this group
}

/**
 * Individual participant state within a group
 * Tracks per-user progress and preferences within the group context
 */
export interface GroupParticipant {
  address: string;
  joinedAt: Date;
  lastActiveAt: Date;
  status: "new" | "onboarding" | "active" | "invited" | "inactive";
  preferences: UserPreferences;

  // Flow progress states - per user within this group
  coinLaunchProgress?: CoinLaunchProgress;
  onboardingProgress?: OnboardingProgress;
  managementProgress?: ManagementProgress;
  pendingTransaction?: PendingTransaction;
}

/**
 * Group manager (AddressFeeSplitManager contract) deployed for this group
 * A group can have multiple managers over time
 */
export interface GroupManager {
  contractAddress: string;
  deployedAt: Date;
  txHash: string;
  deployedBy: string; // user address who deployed this manager
  chainId: number;
  chainName: "base" | "baseSepolia";
  receivers: Array<{
    username: string;
    resolvedAddress: string;
    percentage: number;
  }>;
  // Live data from API
  liveData?: {
    recipients: Array<{
      recipient: string;
      recipientShare: string;
    }>;
    totalFeesUSDC: string;
    totalCoins: number;
    lastUpdated: Date;
  };
}

/**
 * Coin launched within this group
 * A group can have multiple coins launched over time
 */
export interface GroupCoin {
  ticker: string;
  name: string;
  image: string;
  contractAddress: string;
  txHash: string;
  launchedAt: Date;
  launchedBy: string; // user address who launched this coin
  chainId: number;
  chainName: "base" | "baseSepolia";

  // Launch parameters
  fairLaunchDuration: number;
  fairLaunchPercent: number;
  initialMarketCap: number;

  // Associated manager that receives fees for this coin
  managerAddress: string;

  // Live data from API
  liveData?: {
    totalHolders: number;
    marketCapUSDC: string;
    priceChangePercentage: string;
    totalFeesUSDC: string;
    lastUpdated: Date;
  };
}

/**
 * Storage structure for group-states.json
 * Maps group chat IDs to their full state
 */
export type GroupStatesStorage = Record<string, GroupChatState>;

/**
 * Helper types for working with group states
 */
export interface GroupStateUpdate {
  groupId: string;
  updates: Partial<Omit<GroupChatState, "groupId" | "createdAt">>;
}

export interface ParticipantStateUpdate {
  groupId: string;
  participantAddress: string;
  updates: Partial<Omit<GroupParticipant, "address" | "joinedAt">>;
}

/**
 * Aggregated user data derived from group states
 * Used for backwards compatibility and user-specific queries
 */
export interface AggregatedUserData {
  userId: string;
  status: "new" | "onboarding" | "active" | "invited";
  globalPreferences: UserPreferences;

  // Aggregated from all groups this user participates in
  allGroups: Array<{
    groupId: string;
    groupName?: string;
    managers: GroupManager[];
    participantStatus: GroupParticipant["status"];
    joinedAt: Date;
  }>;

  allCoins: Array<{
    coin: GroupCoin;
    groupId: string;
    groupName?: string;
  }>;

  // Current active states across all groups
  activeProgressStates: Array<{
    groupId: string;
    type: "coinLaunch" | "onboarding" | "management" | "pendingTransaction";
    state:
      | CoinLaunchProgress
      | OnboardingProgress
      | ManagementProgress
      | PendingTransaction;
  }>;
}

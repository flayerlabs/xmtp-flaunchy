import { Address, Hex } from "viem";

/**
 * Main group state interface - represents a group chat and all its data
 * Keyed by group chat ID in the storage
 */
export interface GroupChatState {
  groupId: string; // The group chat ID (conversation.id)
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
  address: Address;

  // Flow progress states - per user within this group
  coinLaunchProgress?: CoinLaunchProgress;
  pendingTransaction?: PendingTransaction;
}

/**
 * Group manager (AddressFeeSplitManager contract) deployed for this group
 * A group can have multiple managers over time
 */
export interface GroupManager {
  contractAddress: Address;
  deployedAt: Date;
  txHash?: Hex;
  deployedBy: Address; // user address who deployed this manager
  chainId: number;
  receivers: Array<{
    username: string;
    resolvedAddress: Address;
    percentage: number;
  }>;
  // Live data from API
  liveData?: {
    recipients: Array<{
      recipient: Address;
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
  contractAddress: Address;
  txHash?: Hex;
  launchedAt: Date;
  launchedBy: Address; // user address who launched this coin
  chainId: number;

  // Associated manager that receives fees for this coin
  managerAddress: Address;

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
  updates: Partial<Omit<GroupChatState, "groupId">>;
}

export interface ParticipantStateUpdate {
  groupId: string;
  participantAddress: Address;
  updates: Partial<Omit<GroupParticipant, "address">>;
}

/**
 * Aggregated user data derived from group states
 * Used for backwards compatibility and user-specific queries
 */
export interface AggregatedUserData {
  userId: string;

  // Aggregated from all groups this user participates in
  allGroups: Array<{
    groupId: string;
    groupName?: string;
    managers: GroupManager[];
  }>;

  allCoins: Array<{
    coin: GroupCoin;
    groupId: string;
    groupName?: string;
  }>;

  // Current active states across all groups
  activeProgressStates: Array<{
    groupId: string;
    type: "coinLaunch" | "pendingTransaction";
    state: CoinLaunchProgress | PendingTransaction;
  }>;
}

export interface CoinLaunchProgress {
  step: "collecting_coin_data" | "selecting_group" | "creating_transaction";
  coinData?: {
    name?: string;
    ticker?: string;
    image?: string;
  };
  launchParameters?: {
    startingMarketCap?: number;
    fairLaunchDuration?: number;
    premineAmount?: number;
    buybackPercentage?: number;
  };
  targetGroupId?: string;
  startedAt: Date;
}

export interface PendingTransaction {
  type: "coin_creation";
  txHash?: Hex;
  coinData?: {
    name: string;
    ticker: string;
    image: string;
  };
  launchParameters?: {
    startingMarketCap?: number;
    fairLaunchDuration?: number;
    premineAmount?: number;
    buybackPercentage?: number;
    targetGroupId?: string;
    isFirstLaunch?: boolean;
  };
  network: "base" | "baseSepolia";
  timestamp: Date;
}

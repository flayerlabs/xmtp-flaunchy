/**
 * Per-user state interface for tracking user-specific data across all groups
 * This is separate from the group-centric architecture and tracks user achievements/history
 */
export interface PerUserState {
  userAddress: string;
  createdAt: Date;
  updatedAt: Date;
  status: "new" | "onboarding" | "active" | "invited" | "inactive";
  preferences: {
    defaultMarketCap: number;
    defaultFairLaunchPercent: number;
    defaultFairLaunchDuration: number;
    notificationSettings: {
      launchUpdates: boolean;
      priceAlerts: boolean;
    };
  };
  coinsLaunchedHistory: UserCoinLaunch[];
  groupParticipations: UserGroupParticipation[];
}

/**
 * Record of a coin launched by the user
 */
export interface UserCoinLaunch {
  coinAddress: string;
  ticker: string;
  name: string;
  launchedAt: Date;
  groupId: string;
  chainId: number;
  chainName: "base" | "baseSepolia";
  txHash?: string;
  initialMarketCap?: number;
}

/**
 * Record of user's participation in a group
 */
export interface UserGroupParticipation {
  groupId: string;
  joinedAt: Date;
  status: "active" | "invited" | "inactive" | "left";
  coinsLaunchedInGroup: number;
  lastActiveAt?: Date;
}

/**
 * Storage type for all per-user states
 */
export type PerUserStatesStorage = Record<string, PerUserState>; // keyed by user address

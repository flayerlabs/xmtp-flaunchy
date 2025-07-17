/**
 * Per-user state interface for tracking user-specific data across all groups
 * This is separate from the group-centric architecture and tracks user achievements/history
 */
export interface PerUserState {
  userAddress: string;
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
  txHash?: string;
}

/**
 * Record of user's participation in a group
 */
export interface UserGroupParticipation {
  groupId: string;
  coinsLaunchedInGroup: number;
}

/**
 * Storage type for all per-user states
 */
export type PerUserStatesStorage = Record<string, PerUserState>; // keyed by user address

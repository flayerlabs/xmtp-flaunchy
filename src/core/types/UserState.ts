export interface UserState {
  userId: string;
  status: 'new' | 'onboarding' | 'active';
  onboardingProgress?: OnboardingProgress;
  managementProgress?: ManagementProgress;
  coinLaunchProgress?: CoinLaunchProgress;
  coins: UserCoin[];
  groups: UserGroup[];
  preferences: UserPreferences;
  pendingTransaction?: PendingTransaction;
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingProgress {
  step: 'group_creation' | 'coin_creation' | 'username_collection' | 'completed';
  coinData?: {
    name?: string;
    ticker?: string;
    image?: string;
  };
  splitData?: {
    receivers: Array<{
      username: string;
      resolvedAddress?: string;
      percentage?: number;
    }>;
    equalSplit: boolean;
    creatorPercent?: number;
    managerAddress?: string; // Address of deployed AddressFeeSplitManager
  };
  groupData?: {
    managerAddress?: string;
    txHash?: string;
  };
  startedAt: Date;
  completedAt?: Date;
}

export interface UserCoin {
  ticker: string;
  name: string;
  image: string;
  groupId: string;
  contractAddress?: string;
  txHash?: string;
  launched: boolean;
  fairLaunchDuration: number;
  fairLaunchPercent: number;
  initialMarketCap: number;
  chainId: number; // Store which chain this coin was launched on
  chainName: 'base' | 'baseSepolia'; // Human-readable chain name
  createdAt: Date;
  // Live data from API
  liveData?: {
    totalHolders: number;
    marketCapUSDC: string;
    priceChangePercentage: number;
    totalFeesUSDC: string;
    lastUpdated: Date;
  };
}

export interface UserGroup {
  id: string; // This is the contract address
  type: 'username_split' | 'staking_split';
  receivers: Array<{
    username: string;
    resolvedAddress: string;
    percentage: number;
  }>;
  coins: string[]; // Array of ticker symbols
  chainId: number; // Store which chain this group was launched on
  chainName: 'base' | 'baseSepolia'; // Human-readable chain name
  createdAt: Date;
  updatedAt: Date;
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

export interface UserPreferences {
  defaultMarketCap?: number;
  defaultFairLaunchPercent?: number;
  defaultFairLaunchDuration?: number;
  notificationSettings?: {
    launchUpdates: boolean;
    priceAlerts: boolean;
  };
}

export interface PendingTransaction {
  type: 'group_creation' | 'coin_creation';
  txHash?: string;
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
  };
  network: 'base' | 'baseSepolia';
  timestamp: Date;
}

export interface ManagementProgress {
  action: 'creating_group' | 'adding_coin';
  step: 'collecting_fee_receivers' | 'collecting_coin_details' | 'creating_transaction';
  groupCreationData?: {
    receivers?: Array<{
      username: string;
      resolvedAddress?: string;
      percentage?: number;
    }>;
  };
  coinCreationData?: {
    name?: string;
    ticker?: string;
    image?: string;
    targetGroupId?: string;
  };
  startedAt: Date;
}

export interface CoinLaunchProgress {
  step: 'collecting_coin_data' | 'selecting_group' | 'creating_transaction';
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
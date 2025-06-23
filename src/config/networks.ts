// Network configuration - Force Base Sepolia for all operations
export const NETWORK_CONFIG = {
  // Force Base Sepolia for all coin launches
  CHAIN_ID: 84532, // Base Sepolia
  CHAIN_NAME: 'Base Sepolia',
  RPC_URL: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org/test',
  
  // Contract addresses on Base Sepolia
  FLAUNCH_ZAP_ADDRESS: '0x...', // TODO: Add actual Base Sepolia address
  FLAUNCH_POSITION_MANAGER_ADDRESS: '0x...', // TODO: Add actual Base Sepolia address
  
  // Default launch parameters
  DEFAULT_FAIR_LAUNCH_PERCENT: 40,
  DEFAULT_FAIR_LAUNCH_DURATION: 30 * 60, // 30 minutes
  DEFAULT_INITIAL_MARKET_CAP_USD: 1_000,
  DEFAULT_CREATOR_FEE_ALLOCATION_PERCENT: 100,
} as const;

export type NetworkConfig = typeof NETWORK_CONFIG; 
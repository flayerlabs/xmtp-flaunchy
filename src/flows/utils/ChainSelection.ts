import { base, baseSepolia } from "viem/chains";
import { numToHex } from "../../../utils/hex";

export interface ChainConfig {
  id: number;
  name: 'base' | 'base-sepolia'; // Match PendingTransaction network type
  displayName: string;
  hexId: string;
  viemChain: typeof base | typeof baseSepolia;
  isTestnet: boolean;
}

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  'base': {
    id: base.id,
    name: 'base',
    displayName: 'Base Mainnet',
    hexId: numToHex(base.id),
    viemChain: base,
    isTestnet: false
  },
  'base-sepolia': {
    id: baseSepolia.id,
    name: 'base-sepolia',
    displayName: 'Base Sepolia',
    hexId: numToHex(baseSepolia.id),
    viemChain: baseSepolia,
    isTestnet: true
  }
};

// Default chain is Base Mainnet
export const DEFAULT_CHAIN = SUPPORTED_CHAINS['base'];

/**
 * Extract chain preference from user message
 */
export function detectChainFromMessage(message: string): ChainConfig {
  const lowerMessage = message.toLowerCase();
  
  // Check for specific chain mentions
  if (lowerMessage.includes('sepolia') || lowerMessage.includes('testnet') || lowerMessage.includes('test')) {
    return SUPPORTED_CHAINS['base-sepolia'];
  }
  
  if (lowerMessage.includes('mainnet') || lowerMessage.includes('main')) {
    return SUPPORTED_CHAINS['base'];
  }
  
  // Check for Base mentions (default to mainnet unless sepolia specified)
  if (lowerMessage.includes('base')) {
    if (lowerMessage.includes('sepolia')) {
      return SUPPORTED_CHAINS['base-sepolia'];
    }
    return SUPPORTED_CHAINS['base'];
  }
  
  // Default to Base Mainnet if no specific chain mentioned
  return DEFAULT_CHAIN;
}

/**
 * Get network name for pending transaction based on chain
 */
export function getNetworkName(chainConfig: ChainConfig): 'base' | 'base-sepolia' {
  return chainConfig.name;
}

/**
 * Get display-friendly chain description
 */
export function getChainDescription(chainConfig: ChainConfig): string {
  return chainConfig.isTestnet 
    ? `${chainConfig.displayName} (Testnet)`
    : chainConfig.displayName;
}

/**
 * Validate if a chain is supported
 */
export function isSupportedChain(chainName: string): boolean {
  return Object.keys(SUPPORTED_CHAINS).includes(chainName.toLowerCase()) ||
         Object.values(SUPPORTED_CHAINS).some(chain => 
           chain.displayName.toLowerCase() === chainName.toLowerCase()
         );
}

/**
 * Get chain config by name (flexible matching)
 */
export function getChainByName(chainName: string): ChainConfig | null {
  const lowerName = chainName.toLowerCase();
  
  // Direct key match
  if (SUPPORTED_CHAINS[lowerName]) {
    return SUPPORTED_CHAINS[lowerName];
  }
  
  // Display name match
  const chainByDisplayName = Object.values(SUPPORTED_CHAINS).find(
    chain => chain.displayName.toLowerCase() === lowerName
  );
  
  if (chainByDisplayName) {
    return chainByDisplayName;
  }
  
  // Partial matches
  if (lowerName.includes('sepolia') || lowerName.includes('testnet')) {
    return SUPPORTED_CHAINS['base-sepolia'];
  }
  
  if (lowerName.includes('base') && !lowerName.includes('sepolia')) {
    return SUPPORTED_CHAINS['base'];
  }
  
  return null;
} 
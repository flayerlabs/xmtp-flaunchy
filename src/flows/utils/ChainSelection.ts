import { base, baseSepolia } from "viem/chains";
import { numToHex } from "../../../utils/hex";

export interface ChainConfig {
  id: number;
  name: "base" | "baseSepolia"; // Match viem naming convention
  displayName: string;
  hexId: string;
  viemChain: typeof base | typeof baseSepolia;
  isTestnet: boolean;
}

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  base: {
    id: base.id,
    name: "base",
    displayName: "Base Mainnet",
    hexId: numToHex(base.id),
    viemChain: base,
    isTestnet: false,
  },
  baseSepolia: {
    id: baseSepolia.id,
    name: "baseSepolia",
    displayName: "Base Sepolia",
    hexId: numToHex(baseSepolia.id),
    viemChain: baseSepolia,
    isTestnet: true,
  },
};

// Default chain is Base Mainnet
export const DEFAULT_CHAIN = SUPPORTED_CHAINS["base"];

/**
 * Get default chain based on NETWORK environment variable
 * NETWORK=base (default) -> Base Mainnet
 * NETWORK=baseSepolia -> Base Sepolia
 */
export function getDefaultChain(): ChainConfig {
  const networkEnv = process.env.NETWORK;

  if (networkEnv && SUPPORTED_CHAINS[networkEnv]) {
    return SUPPORTED_CHAINS[networkEnv];
  }

  return DEFAULT_CHAIN;
}

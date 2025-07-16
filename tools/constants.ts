import { getDefaultChain } from "../src/flows/utils/ChainSelection";

// Use environment-aware chain selection for production
export const chain = getDefaultChain().viemChain;
export const TOTAL_SUPPLY = 100n * 10n ** 27n; // 100 Billion tokens in wei

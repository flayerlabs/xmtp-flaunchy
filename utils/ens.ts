import {
  Address,
  createPublicClient,
  encodePacked,
  Hex,
  http,
  keccak256,
  namehash,
  parseAbi,
} from "viem";
import { normalize } from "viem/ens";
import { base, mainnet } from "viem/chains";

export const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.llamarpc.com"), // Using a public RPC endpoint
});

export const baseMainnetClient = createPublicClient({
  chain: base,
  transport: http(),
});

export const resolveEns = async (ens: string) => {
  try {
    if (ens.endsWith(".eth")) {
      console.log("Resolving ENS:", ens);
      const address = await mainnetClient.getEnsAddress({
        name: normalize(ens),
      });
      console.log("Resolved ENS address:", address);
      return address;
    } else {
      return ens;
    }
  } catch (error) {
    console.error("Error resolving ENS:", error);
    return ens; // Return original input if resolution fails
  }
};

export const getDisplayName = async (address: string): Promise<string> => {
  try {
    const ensName = await reverseResolveEns(address as Address);
    if (ensName) {
      return ensName;
    }
  } catch (error) {}
  // Return truncated address as fallback
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const reverseResolveEns = async (address: Address) => {
  // First try Base ENS
  const baseName: string | null | undefined = await getBaseEnsName(address);

  // Fallback to Mainnet ENS if Base ENS not found
  let ensName: string | null | undefined = null;
  if (baseName) {
    ensName = baseName;
  } else {
    ensName = await getEnsName(address);
  }

  return ensName;
};

export const BASENAME_L2_RESOLVER_ADDRESS =
  "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";

export const getBaseEnsName = async (address: string) => {
  try {
    const addressReverseNode = convertReverseNodeToBytes(
      address as Address,
      base.id
    );
    const basename = await baseMainnetClient.readContract({
      abi: parseAbi(["function name(bytes32 node) view returns (string)"]),
      address: BASENAME_L2_RESOLVER_ADDRESS,
      functionName: "name",
      args: [addressReverseNode],
    });
    return basename as string;
  } catch (error) {
    return null;
  }
};

/**
 * Convert an address to a reverse node for ENS resolution
 */
export const convertReverseNodeToBytes = (
  address: Address,
  chainId: number
) => {
  const addressFormatted = address.toLocaleLowerCase() as Address;
  const addressNode = keccak256(addressFormatted.substring(2) as Address);
  const chainCoinType = convertChainIdToCoinType(chainId);
  const baseReverseNode = namehash(
    `${chainCoinType.toLocaleUpperCase()}.reverse`
  );
  const addressReverseNode = keccak256(
    encodePacked(["bytes32", "bytes32"], [baseReverseNode, addressNode])
  );
  return addressReverseNode;
};

/**
 * Convert an chainId to a coinType hex for reverse chain resolution
 */
export const convertChainIdToCoinType = (chainId: number): string => {
  // L1 resolvers to addr
  if (chainId === mainnet.id) {
    return "addr";
  }

  const cointype = (0x80000000 | chainId) >>> 0;
  return cointype.toString(16).toLocaleUpperCase();
};

export const getEnsName = async (address: string) => {
  try {
    return (await mainnetClient.getEnsName({
      address: address as Hex,
    })) as string;
  } catch (error) {
    console.error("Error getting ENS name from mainnet:", error);
    return null;
  }
};

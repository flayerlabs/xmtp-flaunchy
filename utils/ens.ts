import { createPublicClient, http } from "viem";
import { normalize } from "viem/ens";
import { mainnet } from "viem/chains";

export const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.llamarpc.com"), // Using a public RPC endpoint
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

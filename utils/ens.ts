import { createPublicClient, http } from "viem";
import { normalize } from "viem/ens";
import { mainnet } from "viem/chains";

export const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL),
});

export const resolveEns = async (ens: string) => {
  if (ens.endsWith(".eth")) {
    return await mainnetClient.getEnsAddress({
      name: normalize(ens),
    });
  } else {
    return ens;
  }
};

import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface Addresses {
  [chainId: number]: Address;
}

export const FlaunchPositionManagerAddress: Addresses = {
  [base.id]: "0x51Bba15255406Cfe7099a42183302640ba7dAFDC",
  [baseSepolia.id]: "0x9A7059cA00dA92843906Cb4bCa1D005cE848AFdC",
};

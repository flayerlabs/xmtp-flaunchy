import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface Addresses {
  [chainId: number]: Address;
}

export const FlaunchPositionManagerAddress: Addresses = {
  [base.id]: "0x51Bba15255406Cfe7099a42183302640ba7dAFDC",
  [baseSepolia.id]: "0x9A7059cA00dA92843906Cb4bCa1D005cE848AFdC",
};

export const FlaunchZapAddress: Addresses = {
  [base.id]: "0xfa9e8528ee95eb109bffd1a2d59cb95b300a672a",
  [baseSepolia.id]: "0xB2F5D987DE90e026B61805e60b6002D367461474",
};

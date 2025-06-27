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

export const AddressFeeSplitManagerAddress: Addresses = {
  [base.id]: "0x6baa4ec493a9698dc7388c0f290e29ea3d149f99",
  [baseSepolia.id]: "0xf72dcdee692c188de6b14c6213e849982e04069b",
};

export const TreasuryManagerFactoryAddress: Addresses = {
  [base.id]: "0x48af8b28DDC5e5A86c4906212fc35Fa808CA8763",
  [baseSepolia.id]: "0xd2f3c6185e06925dcbe794c6574315b2202e9ccd",
};

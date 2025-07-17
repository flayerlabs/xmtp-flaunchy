export const TreasuryManagerFactoryAbi = [
  {
    name: "deployAndInitializeManager",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "owner", type: "address" },
      { name: "initializeData", type: "bytes" },
    ],
    outputs: [{ name: "manager", type: "address" }],
  },
] as const;

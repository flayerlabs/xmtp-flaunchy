export const poolCreatedAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "_poolId",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "address",
        name: "_memecoin",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "_memecoinTreasury",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "_tokenId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bool",
        name: "_currencyFlipped",
        type: "bool",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "_flaunchFee",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "tuple",
        name: "_params",
        type: "tuple",
        components: [
          {
            internalType: "string",
            name: "name",
            type: "string",
          },
          {
            internalType: "string",
            name: "symbol",
            type: "string",
          },
          {
            internalType: "string",
            name: "tokenUri",
            type: "string",
          },
          {
            internalType: "uint256",
            name: "initialTokenFairLaunch",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "fairLaunchDuration",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "premineAmount",
            type: "uint256",
          },
          {
            internalType: "address",
            name: "creator",
            type: "address",
          },
          {
            internalType: "uint24",
            name: "creatorFeeAllocation",
            type: "uint24",
          },
          {
            internalType: "uint256",
            name: "flaunchAt",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initialPriceParams",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "feeCalculatorParams",
            type: "bytes",
          },
        ],
      },
    ],
    name: "PoolCreated",
    type: "event",
  },
] as const;

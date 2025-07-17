import {
  encodeFunctionData,
  encodeAbiParameters,
  type Address,
  createWalletClient,
  createPublicClient,
  http,
} from "viem";
import { TreasuryManagerFactoryAbi } from "../data/abi/TreasuryManagerFactory";
import {
  TreasuryManagerFactoryAddress,
  AddressFeeSplitManagerAddress,
} from "../../addresses";
import { getDefaultChain } from "../flows/utils/ChainSelection";

export interface FeeReceiver {
  username: string;
  resolvedAddress: string;
  percentage: number;
}

export interface GroupCreationResult {
  managerAddress: Address;
  txHash: string;
}

export async function createAddressFeeSplitManager(
  receivers: FeeReceiver[],
  creatorAddress: Address,
  creatorPercent: number = 0
): Promise<GroupCreationResult> {
  // Calculate recipient shares - creator gets 0%, all fees go to recipients
  const totalReceiverPercent = 100;
  const recipientShares = receivers.map((receiver) => {
    const sharePercent =
      receiver.percentage || totalReceiverPercent / receivers.length;
    return {
      recipient: receiver.resolvedAddress as Address,
      share: BigInt(Math.floor(sharePercent * 100000)), // Convert to basis points (100000 = 100%)
    };
  });

  // Create the InitializeParams structure
  const initializeParamsStruct = {
    creatorShare: BigInt(0), // Creator always gets 0%
    recipientShares: recipientShares,
  };

  // Encode the initialize parameters
  const initializeParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        name: "_params",
        components: [
          { name: "creatorShare", type: "uint256" },
          {
            name: "recipientShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "share", type: "uint256" },
            ],
          },
        ],
      },
    ],
    [initializeParamsStruct]
  );

  // TODO: Implement actual deployment
  // For now, return mock data
  console.log("Would deploy AddressFeeSplitManager with params:", {
    creatorAddress,
    creatorPercent,
    receivers,
    initializeParams,
  });

  // Mock return - replace with actual deployment
  return {
    managerAddress: "0x1234567890123456789012345678901234567890" as Address,
    txHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
  };
}

export async function deployAddressFeeSplitManager(
  receivers: FeeReceiver[],
  creatorAddress: Address,
  privateKey: string,
  rpcUrl: string,
  creatorPercent: number = 0
): Promise<GroupCreationResult> {
  // Get environment-aware chain configuration
  const chainConfig = getDefaultChain();

  // Create clients
  const publicClient = createPublicClient({
    chain: chainConfig.viemChain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    chain: chainConfig.viemChain,
    transport: http(rpcUrl),
  });

  // Calculate recipient shares - creator gets 0%, all fees go to recipients
  const totalReceiverPercent = 100;
  const recipientShares = receivers.map((receiver) => {
    const sharePercent =
      receiver.percentage || totalReceiverPercent / receivers.length;
    return {
      recipient: receiver.resolvedAddress as Address,
      share: BigInt(Math.floor(sharePercent * 100000)),
    };
  });

  const initializeParamsStruct = {
    creatorShare: BigInt(0), // Creator always gets 0%
    recipientShares: recipientShares,
  };

  const initializeParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        name: "_params",
        components: [
          { name: "creatorShare", type: "uint256" },
          {
            name: "recipientShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "share", type: "uint256" },
            ],
          },
        ],
      },
    ],
    [initializeParamsStruct]
  );

  // Deploy the manager
  const txHash = await walletClient.writeContract({
    address: TreasuryManagerFactoryAddress[chainConfig.id],
    abi: TreasuryManagerFactoryAbi,
    functionName: "deployAndInitializeManager",
    args: [
      AddressFeeSplitManagerAddress[chainConfig.id],
      creatorAddress, // The creator becomes the owner
      initializeParams,
    ],
    account: creatorAddress,
  });

  // Wait for transaction receipt
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 1000 * 60 * 5, // 5 minutes
    pollingInterval: 1000 * 5, // 5 seconds
  });

  // TODO: Extract manager address from logs
  const managerAddress = "0x..." as Address; // Extract from receipt logs

  return {
    managerAddress,
    txHash,
  };
}

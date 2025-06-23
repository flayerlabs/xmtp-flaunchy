import { 
  encodeFunctionData, 
  encodeAbiParameters, 
  type Address,
  createWalletClient,
  createPublicClient,
  http
} from "viem";
import { baseSepolia } from "viem/chains";

// TODO: Import these from the actual ABI files
const treasuryManagerFactoryAbi = [
  {
    name: 'deployAndInitializeManager',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: 'initializeData', type: 'bytes' }
    ],
    outputs: [{ name: 'manager', type: 'address' }]
  }
] as const;

// TODO: Get these from addresses.ts
const addresses = {
  treasuryManagerFactory: '0x...' as Address, // TODO: Add actual address
  addressFeeSplitManagerImplementation: '0x...' as Address, // TODO: Add actual address
  flaunchyOwner: '0x...' as Address // TODO: Add actual address
};

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
  creatorPercent: number = 60
): Promise<GroupCreationResult> {
  
  // Calculate recipient shares
  const totalReceiverPercent = 100 - creatorPercent;
  const recipientShares = receivers.map(receiver => {
    const sharePercent = receiver.percentage || (totalReceiverPercent / receivers.length);
    return {
      recipient: receiver.resolvedAddress as Address,
      share: BigInt(Math.floor(sharePercent * 100000)) // Convert to basis points (100000 = 100%)
    };
  });

  // Create the InitializeParams structure
  const initializeParamsStruct = {
    creatorShare: BigInt(creatorPercent * 100000), // Convert to basis points
    recipientShares: recipientShares
  };

  // Encode the initialize parameters
  const initializeParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        name: '_params',
        components: [
          { name: 'creatorShare', type: 'uint256' },
          {
            name: 'recipientShares',
            type: 'tuple[]',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'share', type: 'uint256' }
            ]
          }
        ]
      }
    ],
    [initializeParamsStruct]
  );

  // TODO: Implement actual deployment
  // For now, return mock data
  console.log('Would deploy AddressFeeSplitManager with params:', {
    creatorAddress,
    creatorPercent,
    receivers,
    initializeParams
  });

  // Mock return - replace with actual deployment
  return {
    managerAddress: '0x1234567890123456789012345678901234567890' as Address,
    txHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef'
  };
}

export async function deployAddressFeeSplitManager(
  receivers: FeeReceiver[],
  creatorAddress: Address,
  privateKey: string,
  rpcUrl: string,
  creatorPercent: number = 60
): Promise<GroupCreationResult> {
  
  // Create clients
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl)
  });

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: http(rpcUrl)
  });

  // Calculate recipient shares (same as above)
  const totalReceiverPercent = 100 - creatorPercent;
  const recipientShares = receivers.map(receiver => {
    const sharePercent = receiver.percentage || (totalReceiverPercent / receivers.length);
    return {
      recipient: receiver.resolvedAddress as Address,
      share: BigInt(Math.floor(sharePercent * 100000))
    };
  });

  const initializeParamsStruct = {
    creatorShare: BigInt(creatorPercent * 100000),
    recipientShares: recipientShares
  };

  const initializeParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        name: '_params',
        components: [
          { name: 'creatorShare', type: 'uint256' },
          {
            name: 'recipientShares',
            type: 'tuple[]',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'share', type: 'uint256' }
            ]
          }
        ]
      }
    ],
    [initializeParamsStruct]
  );

  // Deploy the manager
  const txHash = await walletClient.writeContract({
    address: addresses.treasuryManagerFactory,
    abi: treasuryManagerFactoryAbi,
    functionName: 'deployAndInitializeManager',
    args: [
      addresses.addressFeeSplitManagerImplementation,
      addresses.flaunchyOwner,
      initializeParams
    ],
    account: creatorAddress
  });

  // Wait for transaction receipt
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 1000 * 60 * 5, // 5 minutes
    pollingInterval: 1000 * 5 // 5 seconds
  });

  // TODO: Extract manager address from logs
  const managerAddress = '0x...' as Address; // Extract from receipt logs

  return {
    managerAddress,
    txHash
  };
} 
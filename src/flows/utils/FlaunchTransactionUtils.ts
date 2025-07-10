import {
  encodeFunctionData,
  encodeAbiParameters,
  parseUnits,
  zeroHash,
  createPublicClient,
  http,
} from "viem";
import { numToHex } from "../../../utils/hex";
import { FlaunchZapAbi } from "../../../abi/FlaunchZap";
import { FlaunchPositionManagerAbi } from "../../../abi/FlaunchPositionManager";
import {
  FlaunchZapAddress,
  FlaunchPositionManagerAddress,
} from "../../../addresses";
import { generateTokenUri } from "../../../utils/ipfs";

/**
 * Calculate the premine amount based on percentage
 * Matches the calculatePremineAmount function from the frontend
 */
function calculatePremineAmount(preminePercentage?: number): bigint {
  if (!preminePercentage || preminePercentage <= 0) {
    return 0n;
  }

  const TOTAL_SUPPLY = 100n * 10n ** 27n; // 100B tokens

  // Convert percentage to basis points (10000ths) to handle decimals
  // e.g., 0.877% becomes 877 basis points out of 1,000,000 (100%)
  const basisPoints = Math.round(preminePercentage * 10000);
  return (TOTAL_SUPPLY * BigInt(basisPoints)) / 1000000n;
}

export interface FlaunchTransactionParams {
  // Core token details
  name: string;
  ticker: string;
  image: string;

  // Creator and network
  creatorAddress: string;
  senderInboxId: string;
  chain: any;

  // Treasury management
  treasuryManagerAddress: string;
  treasuryInitializeData?: string;

  // Launch parameters (with defaults)
  fairLaunchPercent?: number;
  fairLaunchDuration?: number;
  startingMarketCapUSD?: number;
  creatorFeeAllocationPercent?: number;
  preminePercentage?: number;

  // Image processing context (for attachments)
  processImageAttachment?: (attachment: any) => Promise<string>;
  hasAttachment?: boolean;
  attachment?: any;

  // ENS resolver for address formatting
  ensResolver?: any;
}

export interface WalletSendCalls {
  version: string;
  from: string;
  chainId: string;
  calls: Array<{
    chainId: number;
    to: string;
    data: string;
    value: string;
    metadata: {
      description: string;
    };
  }>;
}

export async function createFlaunchTransaction(
  params: FlaunchTransactionParams
): Promise<WalletSendCalls> {
  const {
    name,
    ticker,
    image,
    creatorAddress,
    senderInboxId,
    chain,
    treasuryManagerAddress,
    treasuryInitializeData = "0x",
    fairLaunchPercent = 10,
    fairLaunchDuration = 30 * 60, // 30 minutes
    startingMarketCapUSD = 1000,
    creatorFeeAllocationPercent = 100,
    preminePercentage = 0,
    processImageAttachment,
    hasAttachment,
    attachment,
  } = params;

  // Constants
  const TOTAL_SUPPLY = 100n * 10n ** 27n;

  // Process image
  let imageUrl = "";

  if (image && image !== "attachment_provided") {
    if (image.startsWith("http")) {
      try {
        const response = await fetch(image);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          imageUrl = Buffer.from(new Uint8Array(buffer)).toString("base64");
        }
      } catch (error) {
        console.log(
          `[FlaunchTransaction] ❌ Failed to fetch image: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else if (image.startsWith("ipfs://")) {
      imageUrl = image;
    }
  } else if (
    image === "attachment_provided" &&
    hasAttachment &&
    processImageAttachment &&
    attachment
  ) {
    imageUrl = await processImageAttachment(attachment);

    if (imageUrl === "IMAGE_PROCESSING_FAILED") {
      throw new Error("Image processing failed");
    }
  }

  // Generate token URI
  let tokenUri = "";
  const pinataJWT = process.env.PINATA_JWT;

  if (imageUrl && pinataJWT) {
    try {
      tokenUri = await generateTokenUri(name, {
        pinataConfig: { jwt: pinataJWT },
        metadata: {
          imageUrl: imageUrl,
          description: `Flaunched via Flaunchy on XMTP`,
          websiteUrl: "",
          discordUrl: "",
          twitterUrl: "",
          telegramUrl: "",
        },
      });
    } catch (error) {
      console.log(
        `[FlaunchTransaction] ❌ Failed to generate token URI: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Launch parameters
  const fairLaunchInBps = BigInt(fairLaunchPercent * 100);
  const creatorFeeAllocationInBps = Math.round(
    creatorFeeAllocationPercent * 100
  );
  const premineAmount = calculatePremineAmount(preminePercentage);

  const initialTokenFairLaunch = (TOTAL_SUPPLY * fairLaunchInBps) / 10000n;
  const ethAmount = parseUnits(startingMarketCapUSD.toString(), 6);
  const initialPriceParams = encodeAbiParameters(
    [
      { type: "uint256", name: "ethAmount" },
      { type: "uint256", name: "tokenAmount" },
    ],
    [ethAmount, initialTokenFairLaunch]
  );

  // Calculate ETH value to send with transaction
  let transactionValue = "0";

  try {
    // Create public client to interact with contracts
    const publicClient = createPublicClient({
      transport: http(chain.viemChain.rpcUrls.default.http[0]),
      chain: chain.viemChain,
    });

    // Get the base flaunching fee (always required)
    const fee = await publicClient.readContract({
      abi: FlaunchPositionManagerAbi,
      address: FlaunchPositionManagerAddress[chain.id],
      functionName: "getFlaunchingFee",
      args: [initialPriceParams],
    });

    let totalCost = fee;

    // If there's a premine, add the premine cost
    let cost = 0n; // Declare cost variable outside the if block
    if (premineAmount > 0n) {
      cost = await publicClient.readContract({
        abi: FlaunchZapAbi,
        address: FlaunchZapAddress[chain.id],
        functionName: "calculateFee",
        args: [premineAmount, 0n, initialPriceParams],
      });
      totalCost = fee + cost;
    }

    // Bump by 10% to account for oracle fluctuations (any extra is refunded)
    const finalCost = (totalCost * 110n) / 100n;
    transactionValue = finalCost.toString();

    console.log(
      `[FlaunchTransaction] 🚀 Created $${ticker} launch transaction: ${(
        Number(finalCost) / 1e18
      ).toFixed(6)} ETH${
        premineAmount > 0n ? ` (${preminePercentage}% premine)` : ""
      }`
    );
  } catch (error) {
    console.log(
      `[FlaunchTransaction] ❌ Failed to calculate transaction value: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Fallback to 0 if calculation fails - transaction may fail but won't throw here
  }

  // Flaunch parameters
  const flaunchParams = {
    name: name,
    symbol: ticker,
    tokenUri,
    initialTokenFairLaunch,
    fairLaunchDuration: BigInt(fairLaunchDuration),
    premineAmount,
    creator: creatorAddress as `0x${string}`,
    creatorFeeAllocation: creatorFeeAllocationInBps,
    flaunchAt: 0n,
    initialPriceParams,
    feeCalculatorParams: "0x" as `0x${string}`,
  };

  const treasuryManagerParams = {
    manager: treasuryManagerAddress as `0x${string}`,
    initializeData: treasuryInitializeData as `0x${string}`,
    depositData: "0x" as `0x${string}`,
  };

  const whitelistParams = {
    merkleRoot: zeroHash,
    merkleIPFSHash: "",
    maxTokens: 0n,
  };

  const airdropParams = {
    airdropIndex: 0n,
    airdropAmount: 0n,
    airdropEndTime: 0n,
    merkleRoot: zeroHash,
    merkleIPFSHash: "",
  };

  // Encode function call
  const functionData = encodeFunctionData({
    abi: FlaunchZapAbi,
    functionName: "flaunch",
    args: [
      flaunchParams,
      whitelistParams,
      airdropParams,
      treasuryManagerParams,
    ],
  });

  // Create wallet send calls
  const walletSendCalls: WalletSendCalls = {
    version: "1.0",
    from: creatorAddress,
    chainId: numToHex(chain.id),
    calls: [
      {
        chainId: chain.id,
        to: FlaunchZapAddress[chain.id],
        data: functionData,
        value: `0x${BigInt(transactionValue).toString(16)}`,
        metadata: {
          description: params.ensResolver
            ? `Launch $${ticker} into ${await params.ensResolver.resolveSingleAddress(
                treasuryManagerAddress
              )}`
            : `Launch $${ticker} into ${treasuryManagerAddress.slice(
                0,
                6
              )}...${treasuryManagerAddress.slice(-4)}`,
        },
      },
    ],
  };

  return walletSendCalls;
}

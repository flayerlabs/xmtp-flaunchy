import { encodeFunctionData, encodeAbiParameters, parseUnits, zeroHash } from 'viem';
import { numToHex } from '../../../utils/hex';
import { FlaunchZapAbi } from '../../../abi/FlaunchZap';
import { FlaunchZapAddress } from '../../../addresses';
import { generateTokenUri } from '../../../utils/ipfs';

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

export async function createFlaunchTransaction(params: FlaunchTransactionParams): Promise<WalletSendCalls> {
  const {
    name,
    ticker,
    image,
    creatorAddress,
    senderInboxId,
    chain,
    treasuryManagerAddress,
    treasuryInitializeData = '0x',
    fairLaunchPercent = 10,
    fairLaunchDuration = 30 * 60, // 30 minutes
    startingMarketCapUSD = 1000,
    creatorFeeAllocationPercent = 100,
    preminePercentage = 0,
    processImageAttachment,
    hasAttachment,
    attachment
  } = params;

  // Constants
  const TOTAL_SUPPLY = 100n * 10n ** 27n;
  
  // Process image
  let imageUrl = '';
  
  if (image && image !== 'attachment_provided') {
    if (image.startsWith('http')) {
      try {
        const response = await fetch(image);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          imageUrl = Buffer.from(new Uint8Array(buffer)).toString('base64');
        }
      } catch (error) {
        console.error('Failed to fetch image:', error);
      }
    } else if (image.startsWith('ipfs://')) {
      imageUrl = image;
    }
  } else if (image === 'attachment_provided' && hasAttachment && processImageAttachment && attachment) {
    imageUrl = await processImageAttachment(attachment);
    
    if (imageUrl === 'IMAGE_PROCESSING_FAILED') {
      throw new Error('Image processing failed');
    }
  }

  // Generate token URI
  let tokenUri = '';
  const pinataJWT = process.env.PINATA_JWT;
  
  if (imageUrl && pinataJWT) {
    try {
      tokenUri = await generateTokenUri(name, {
        pinataConfig: { jwt: pinataJWT },
        metadata: {
          imageUrl: imageUrl,
          description: `Flaunched via Flaunchy on XMTP`,
          websiteUrl: '',
          discordUrl: '',
          twitterUrl: '',
          telegramUrl: '',
        },
      });
    } catch (error) {
      console.error('Failed to generate token URI:', error);
    }
  }

  // Launch parameters
  const fairLaunchInBps = BigInt(fairLaunchPercent * 100);
  const creatorFeeAllocationInBps = creatorFeeAllocationPercent * 100;
  const premineAmount = (TOTAL_SUPPLY * BigInt(preminePercentage * 100)) / 10000n;

  const initialTokenFairLaunch = (TOTAL_SUPPLY * fairLaunchInBps) / 10000n;
  const ethAmount = parseUnits(startingMarketCapUSD.toString(), 6);
  const initialPriceParams = encodeAbiParameters(
    [
      { type: 'uint256', name: 'ethAmount' },
      { type: 'uint256', name: 'tokenAmount' }
    ],
    [ethAmount, initialTokenFairLaunch]
  );

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
    feeCalculatorParams: '0x' as `0x${string}`,
  };

  const treasuryManagerParams = {
    manager: treasuryManagerAddress as `0x${string}`,
    initializeData: treasuryInitializeData as `0x${string}`,
    depositData: '0x' as `0x${string}`,
  };

  const whitelistParams = {
    merkleRoot: zeroHash,
    merkleIPFSHash: '',
    maxTokens: 0n,
  };

  const airdropParams = {
    airdropIndex: 0n,
    airdropAmount: 0n,
    airdropEndTime: 0n,
    merkleRoot: zeroHash,
    merkleIPFSHash: '',
  };

  // Encode function call
  const functionData = encodeFunctionData({
    abi: FlaunchZapAbi,
    functionName: 'flaunch',
    args: [
      flaunchParams,
      whitelistParams,
      airdropParams,
      treasuryManagerParams,
    ],
  });

  // Create wallet send calls
  const walletSendCalls: WalletSendCalls = {
    version: '1.0',
    from: senderInboxId,
    chainId: numToHex(chain.id),
    calls: [
      {
        chainId: chain.id,
        to: FlaunchZapAddress[chain.id],
        data: functionData,
        value: '0',
        metadata: {
          description: `Launch $${ticker} into ${treasuryManagerAddress.slice(0, 6)}...${treasuryManagerAddress.slice(-4)}`,
        },
      },
    ],
  };

  return walletSendCalls;
} 
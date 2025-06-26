import {
    encodeAbiParameters,
    encodeFunctionData,
    isAddress,
    type Address
} from "viem";
import { baseSepolia } from "viem/chains";
import { TreasuryManagerFactoryAbi } from "../../../abi/TreasuryManagerFactory";
import { AddressFeeSplitManagerAddress, TreasuryManagerFactoryAddress } from "../../../addresses";
import { numToHex } from "../../../utils/hex";
import { FlowContext } from "../../core/types/FlowContext";
import { createLaunchExtractionPrompt, LaunchExtractionResult } from "../onboarding/launchExtractionTemplate";
import { ChainConfig, DEFAULT_CHAIN } from "./ChainSelection";

export interface FeeReceiver {
  username: string;
  percentage?: number;
  resolvedAddress?: string;
}

export interface GroupCreationResult {
  walletSendCalls: any;
  resolvedReceivers: FeeReceiver[];
  chainConfig: ChainConfig;
}

/**
 * Utility class for shared group creation logic between OnboardingFlow and ManagementFlow
 */
export class GroupCreationUtils {
  
  /**
   * Extract fee receivers from a message using LLM
   */
  static async extractFeeReceivers(context: FlowContext): Promise<{ receivers: FeeReceiver[] } | null> {
    const messageText = context.messageText;
    if (!messageText) return null;

    try {
      const extractionPrompt = createLaunchExtractionPrompt({
        message: messageText,
        hasAttachment: false
      });

      const response = await context.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: extractionPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 800
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return null;

      const result = JSON.parse(content) as LaunchExtractionResult;
      
      if (result.feeReceivers && result.feeReceivers.receivers && result.feeReceivers.confidence >= 0.5) {
        return {
          receivers: result.feeReceivers.receivers.map(r => ({
            username: r.identifier === 'SELF_REFERENCE' ? context.creatorAddress : r.identifier,
            percentage: r.percentage || undefined
          }))
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to extract fee receivers:', error);
      return null;
    }
  }

  /**
   * Resolve usernames to Ethereum addresses
   */
  static async resolveUsernames(context: FlowContext, receivers: FeeReceiver[]): Promise<FeeReceiver[]> {
    const resolved = [];

    for (const receiver of receivers) {
      let address: string | undefined;

      // Check if it's already an Ethereum address
      if (isAddress(receiver.username)) {
        address = receiver.username;
      } else {
        // Try resolving via context helper
        try {
          address = await context.resolveUsername(receiver.username);
        } catch (error) {
          console.log(`Failed to resolve username: ${receiver.username}`, error);
        }
      }

      resolved.push({
        username: receiver.username,
        percentage: receiver.percentage,
        resolvedAddress: address
      });
    }

    return resolved;
  }

  /**
   * Create group deployment transaction calls
   */
  static async createGroupDeploymentCalls(
    resolvedReceivers: FeeReceiver[], 
    creatorAddress: string,
    chainConfig: ChainConfig,
    description?: string
  ): Promise<any> {
    // Deduplicate receivers first - combine shares for duplicate addresses
    const addressShareMap = new Map<Address, bigint>();
    const TOTAL_SHARE = 10000000n; // 100.00000% in contract format
    let totalAllocated = 0n;
    const receivers = Array.from(new Set(resolvedReceivers.map(r => r.resolvedAddress!.toLowerCase()))); // Deduplicated addresses
    
    console.log('Receivers before deduplication', {
      receivers: resolvedReceivers.map(r => ({
        username: r.username,
        resolvedAddress: r.resolvedAddress,
        percentage: r.percentage
      }))
    });

    // Validate all receivers have resolved addresses
    for (const receiver of resolvedReceivers) {
      if (!receiver.resolvedAddress) {
        throw new Error(`Receiver ${receiver.username} missing resolved address`);
      }
      if (!isAddress(receiver.resolvedAddress)) {
        throw new Error(`Invalid address for receiver ${receiver.username}: ${receiver.resolvedAddress}`);
      }
    }

    // Build address share map by combining duplicate addresses (case-insensitive)
    for (let i = 0; i < resolvedReceivers.length; i++) {
      const receiver = resolvedReceivers[i];
      const address = (receiver.resolvedAddress as string).toLowerCase() as Address;
      
      let share: bigint;
      if (receiver.percentage) {
        // Use explicit percentage
        share = BigInt(Math.floor(receiver.percentage * 100000));
      } else {
        // Equal split calculation
        const baseShare = TOTAL_SHARE / BigInt(receivers.length);
        const isLastUniqueReceiver = i === resolvedReceivers.length - 1;
        
        if (isLastUniqueReceiver) {
          // Last receiver gets remainder to ensure total equals TOTAL_SHARE
          share = TOTAL_SHARE - totalAllocated;
        } else {
          share = baseShare;
        }
      }
      
      const currentShare = addressShareMap.get(address) || 0n;
      addressShareMap.set(address, currentShare + share);
      totalAllocated += share;
    }

    console.log('Receivers after deduplication', {
      uniqueReceivers: Array.from(addressShareMap.entries()).map(([addr, share]) => ({
        address: addr,
        share: share.toString(),
        percentage: (Number(share) / 100000).toFixed(2) + '%'
      }))
    });

    // Validate total shares equal exactly TOTAL_SHARE
    const calculatedTotal = Array.from(addressShareMap.values()).reduce((sum, share) => sum + share, 0n);
    if (calculatedTotal !== TOTAL_SHARE) {
      throw new Error(`Total shares (${calculatedTotal}) do not equal required total (${TOTAL_SHARE})`);
    }

    console.log('✅ Total shares validation passed:', calculatedTotal.toString());

    // Calculate recipient shares using deduplicated data
    const recipientShares = Array.from(addressShareMap.entries()).map(([address, share]) => ({
      recipient: address,
      share: share
    }));

    // Encode initialization data for AddressFeeSplitManager
    const initializeData = encodeAbiParameters(
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
      [{
        creatorShare: BigInt(0), // Creator gets 0%
        recipientShares: recipientShares
      }]
    );

    const treasuryManagerFactory = TreasuryManagerFactoryAddress[chainConfig.id];
    const addressFeeSplitManagerImplementation = AddressFeeSplitManagerAddress[chainConfig.id];
    
    console.log('Contract address lookup', {
      chainId: chainConfig.id,
      chainName: chainConfig.name,
      chainDisplayName: chainConfig.displayName,
      treasuryManagerFactory,
      addressFeeSplitManagerImplementation
    });
    
    if (!treasuryManagerFactory || !addressFeeSplitManagerImplementation) {
      throw new Error(`Contract addresses not configured for chain ${chainConfig.displayName} (ID: ${chainConfig.id}). Available chains: ${Object.keys(TreasuryManagerFactoryAddress).join(', ')}`);
    }
    
    const functionData = encodeFunctionData({
      abi: TreasuryManagerFactoryAbi,
      functionName: 'deployAndInitializeManager',
      args: [
        addressFeeSplitManagerImplementation, // implementation
        creatorAddress as Address, // owner
        initializeData // initializeData
      ]
    });

    const receiverList = resolvedReceivers.map(r => 
      r.username.startsWith('@') ? r.username : `${r.resolvedAddress!.slice(0, 6)}...${r.resolvedAddress!.slice(-4)}`
    ).join(', ');

    const finalDescription = description || `Create Group for ${receiverList}`;
    const chainDescription = chainConfig.isTestnet ? ` on ${chainConfig.displayName}` : '';

    // Return wallet send calls in the correct format
    return {
      version: '1.0',
      from: creatorAddress,
      chainId: chainConfig.hexId,
      calls: [
        {
          chainId: chainConfig.id,
          to: treasuryManagerFactory,
          data: functionData,
          value: '0',
          metadata: {
            description: finalDescription + chainDescription
          }
        }
      ]
    };
  }

  /**
   * Complete group creation workflow: extract → resolve → create transaction
   */
  static async createGroupFromMessage(
    context: FlowContext,
    chainConfig: ChainConfig = DEFAULT_CHAIN,
    description?: string
  ): Promise<GroupCreationResult | null> {
    try {
      // Extract fee receivers
      const extraction = await this.extractFeeReceivers(context);
      if (!extraction || !extraction.receivers || extraction.receivers.length === 0) {
        return null;
      }

      // Resolve usernames to addresses
      const resolvedReceivers = await this.resolveUsernames(context, extraction.receivers);
      
      // Check if any failed to resolve
      const failed = resolvedReceivers.filter(r => !r.resolvedAddress);
      if (failed.length > 0) {
        throw new Error(`Couldn't resolve these usernames: ${failed.map(r => r.username).join(', ')}`);
      }

      // Create transaction calls with proper error handling
      const walletSendCalls = await this.createGroupDeploymentCalls(
        resolvedReceivers, 
        context.creatorAddress,
        chainConfig,
        description
      );

      return {
        walletSendCalls,
        resolvedReceivers,
        chainConfig
      };
    } catch (error) {
      console.error('Failed to create group from message:', error);
      throw error; // Re-throw to let caller handle
    }
  }
} 
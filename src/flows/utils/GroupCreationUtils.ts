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
        // Equal split calculation - fix rounding error by giving remainder to last receiver
        const baseShare = TOTAL_SHARE / BigInt(receivers.length);
        const remainder = TOTAL_SHARE % BigInt(receivers.length);
        const isLastUniqueReceiver = i === resolvedReceivers.length - 1;
        
        if (isLastUniqueReceiver) {
          // Last receiver gets base share plus any remainder to ensure total equals TOTAL_SHARE
          share = baseShare + remainder;
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

    // Validate total shares equal exactly TOTAL_SHARE (allow for small rounding errors)
    const calculatedTotal = Array.from(addressShareMap.values()).reduce((sum, share) => sum + share, 0n);
    const difference = calculatedTotal > TOTAL_SHARE ? calculatedTotal - TOTAL_SHARE : TOTAL_SHARE - calculatedTotal;
    
    // Allow for small rounding errors (up to 10 units, which is 0.001%)
    // The transaction will handle any remainder by giving it to the last user
    if (difference > 10n) {
      throw new Error(`Total shares (${calculatedTotal}) do not equal required total (${TOTAL_SHARE}). Difference: ${difference}`);
    }
    
    // If there's a small difference, adjust the last receiver to make it exactly TOTAL_SHARE
    if (difference > 0n) {
      const entries = Array.from(addressShareMap.entries());
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const [lastAddress, lastShare] = lastEntry;
        const adjustment = calculatedTotal > TOTAL_SHARE ? -difference : difference;
        addressShareMap.set(lastAddress, lastShare + adjustment);
        console.log(`✅ Adjusted last receiver by ${adjustment} to handle rounding`);
      }
    }

    const finalTotal = Array.from(addressShareMap.values()).reduce((sum, share) => sum + share, 0n);
    console.log('✅ Total shares validation passed:', finalTotal.toString());

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
    const chainDescription = chainConfig.isTestnet ? ` (${chainConfig.displayName})` : '';

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

  /**
   * Create a transaction message with proper receiver display (max 10, then "and N more")
   * This is the shared logic used across all flows for consistent messaging
   */
  static createTransactionMessage(
    receivers: FeeReceiver[],
    messageType: 'created' | 'updated' = 'created'
  ): string {
    // Limit to first 10 receivers, show "and N more" for the rest
    const maxShown = 10;
    const shownReceivers = receivers.slice(0, maxShown);
    const remainingReceivers = receivers.slice(maxShown);
    
    // Create descriptive message with shown receiver names and percentages
    const receiverList = shownReceivers
      .map(r => {
        const displayName = (r.username && r.username.startsWith('@')) 
          ? r.username 
          : (r.username && !r.username.startsWith('0x'))
            ? `@${r.username}`
            : r.resolvedAddress
              ? `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`
              : 'unknown';
        const percentage = r.percentage ? ` (${r.percentage.toFixed(1)}%)` : '';
        return `${displayName}${percentage}`;
      })
      .join(', ');

    // Add "and N more" if there are remaining receivers
    let finalReceiverList = receiverList;
    if (remainingReceivers.length > 0) {
      const remainingCount = remainingReceivers.length;
      const remainingPercentage = remainingReceivers.reduce((sum, r) => sum + (r.percentage || 0), 0);
      const remainingText = remainingPercentage > 0 
        ? ` (${remainingPercentage.toFixed(1)}%)`
        : '';
      finalReceiverList += `, and ${remainingCount} more${remainingText}`;
    }

    const memberCount = receivers.length;
    const memberText = memberCount === 1 ? 'member' : 'members';
    const actionText = messageType === 'updated' ? 'updated' : '';
    const actionVerb = messageType === 'updated' ? 'update' : 'create';
    const splitText = messageType === 'updated' ? '. the fee split has been updated' : '';

    return `sign the ${actionText} transaction to ${actionVerb} the group for ${finalReceiverList}. the group has ${memberCount} ${memberText}${splitText}.`;
  }

  /**
   * Handle percentage updates for existing receivers
   * This redistributes percentages when specific users get new percentages
   */
  static async handlePercentageUpdate(
    context: FlowContext,
    existingReceivers: FeeReceiver[],
    messageText: string
  ): Promise<FeeReceiver[]> {
    // Extract percentage updates from the message
    const extraction = await this.extractFeeReceivers(context);
    if (!extraction || !extraction.receivers || extraction.receivers.length === 0) {
      throw new Error("couldn't understand the percentage update. try something like 'give @alice 50%'.");
    }

    // Resolve new usernames
    const newReceivers = await this.resolveUsernames(context, extraction.receivers);
    
    // Check for resolution failures
    const failed = newReceivers.filter(r => !r.resolvedAddress);
    if (failed.length > 0) {
      throw new Error(`couldn't resolve these usernames: ${failed.map(r => r.username).join(', ')}`);
    }

    // Create a map of existing receivers by address
    const existingMap = new Map<string, FeeReceiver>();
    for (const receiver of existingReceivers) {
      if (receiver.resolvedAddress) {
        existingMap.set(receiver.resolvedAddress.toLowerCase(), receiver);
      }
    }

    // Apply percentage updates
    const updatedReceivers = [...existingReceivers];
    let totalSpecifiedPercentage = 0;
    const receiversWithUpdates = new Set<string>();

    // Update receivers with new percentages
    for (const newReceiver of newReceivers) {
      if (newReceiver.percentage !== undefined && newReceiver.resolvedAddress) {
        const existingIndex = updatedReceivers.findIndex(r => 
          r.resolvedAddress?.toLowerCase() === newReceiver.resolvedAddress?.toLowerCase()
        );
        
        if (existingIndex >= 0) {
          updatedReceivers[existingIndex].percentage = newReceiver.percentage;
          totalSpecifiedPercentage += newReceiver.percentage;
          receiversWithUpdates.add(newReceiver.resolvedAddress.toLowerCase());
        }
      }
    }

    // Calculate remaining percentage for other receivers
    const remainingPercentage = 100 - totalSpecifiedPercentage;
    const receiversForEqualSplit = updatedReceivers.filter(r => 
      r.resolvedAddress && !receiversWithUpdates.has(r.resolvedAddress.toLowerCase())
    );

    if (remainingPercentage < 0) {
      throw new Error("specified percentages exceed 100%. please use lower percentages.");
    }

    if (receiversForEqualSplit.length > 0) {
      const equalPercentage = remainingPercentage / receiversForEqualSplit.length;
      
      // Apply equal split to remaining receivers
      for (const receiver of receiversForEqualSplit) {
        receiver.percentage = equalPercentage;
      }
    }

    return updatedReceivers;
  }

  /**
   * Generate a unique, fun group name based on the receivers
   */
  static generateGroupName(receivers: FeeReceiver[]): string {
    // Badass adjectives that are powerful and energetic
    const adjectives = [
      'Alpha', 'Beta', 'Gamma', 'Delta', 'Epic', 'Mega', 'Super', 'Ultra', 
      'Prime', 'Elite', 'Turbo', 'Rocket', 'Stellar', 'Cosmic', 'Quantum',
      'Neon', 'Cyber', 'Digital', 'Plasma', 'Crystal', 'Diamond', 'Golden',
      'Silver', 'Platinum', 'Titanium', 'Solar', 'Lunar', 'Nova', 'Phoenix',
      'Thunder', 'Lightning', 'Storm', 'Blaze', 'Frost', 'Shadow', 'Mystic',
      'Atomic', 'Electric', 'Magnetic', 'Kinetic', 'Dynamic', 'Static',
      'Omega', 'Sigma', 'Zeta', 'Apex', 'Vortex', 'Matrix', 'Vector',
      'Nexus', 'Vertex', 'Zenith', 'Prism', 'Fusion', 'Pulse', 'Surge',
      'Volt', 'Flux', 'Core', 'Edge', 'Razor', 'Steel', 'Iron', 'Chrome',
      'Hyper', 'Nitro', 'Boost', 'Rapid', 'Swift', 'Flash', 'Sonic',
      'Laser', 'Photon', 'Neutron', 'Proton', 'Ion', 'Titan', 'Giant',
      'Mammoth', 'Colossal', 'Massive', 'Infinite', 'Eternal', 'Immortal'
    ];

    // Powerful nouns that work well for trading groups
    const nouns = [
      'Squad', 'Crew', 'Gang', 'Team', 'Pack', 'Guild', 'Club', 'Circle',
      'Alliance', 'Union', 'Collective', 'Syndicate', 'Network', 'Hub',
      'Lab', 'Factory', 'Studio', 'Workshop', 'Forge', 'Vault', 'Chamber',
      'Arena', 'Zone', 'Realm', 'Domain', 'Empire', 'Kingdom', 'Republic',
      'Federation', 'Coalition', 'Assembly', 'Council', 'Senate', 'Board',
      'Panel', 'Committee', 'Society', 'Foundation', 'Institute', 'Academy',
      'Legion', 'Battalion', 'Regiment', 'Division', 'Force', 'Unit',
      'Corps', 'Brigade', 'Platoon', 'Militia', 'Army', 'Fleet',
      'Cartel', 'Mafia', 'Order', 'Brotherhood', 'Sisterhood', 'Clan',
      'Tribe', 'Dynasty', 'House', 'Court', 'Throne', 'Crown',
      'Fortress', 'Citadel', 'Stronghold', 'Bastion', 'Tower', 'Castle',
      'Machine', 'Engine', 'Reactor', 'Generator', 'Turbine', 'Motor',
      'System', 'Protocol', 'Algorithm', 'Framework', 'Structure', 'Grid'
    ];

    // Get a pseudo-random selection based on receiver addresses
    // This ensures the same receivers always get the same name
    const addressString = receivers
      .map(r => r.resolvedAddress?.toLowerCase() || '')
      .sort() // Sort to ensure consistent ordering
      .join('');
    
    // Create a simple hash from the address string
    let hash = 0;
    for (let i = 0; i < addressString.length; i++) {
      const char = addressString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Use the hash to select adjective and noun
    const adjIndex = Math.abs(hash) % adjectives.length;
    const nounIndex = Math.abs(hash >> 8) % nouns.length;
    
    // Add a number suffix for extra uniqueness
    const suffix = Math.abs(hash >> 16) % 1000;
    
    return `${adjectives[adjIndex]} ${nouns[nounIndex]} ${suffix}`;
  }

  /**
   * Shared error handling for group creation across all flows
   */
  static handleGroupCreationError(error: any): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('Total shares') && errorMessage.includes('do not equal required total')) {
      return "error updating percentages - they don't add up to 100%. please try again.";
    } else if (errorMessage.includes('Couldn\'t resolve these usernames')) {
      return errorMessage.toLowerCase();
    } else if (errorMessage.includes('specified percentages exceed 100%')) {
      return errorMessage;
    } else if (errorMessage.includes("couldn't understand the percentage update")) {
      return errorMessage;
    } else if (errorMessage.includes("couldn't resolve these usernames")) {
      return errorMessage;
    } else {
      console.error('Group creation error:', error);
      return "something went wrong creating the group. please try again or contact support.";
    }
  }

  /**
   * Generate a badass introduction message for a newly created group
   */
  static async generateGroupIntroduction(
    groupName: string,
    receivers: FeeReceiver[],
    openai: any,
    includesCoinPrompt: boolean = false
  ): Promise<string> {
    try {
      const memberCount = receivers.length;
      const receiverNames = receivers
        .slice(0, 3) // Show first 3 members
        .map(r => r.username.startsWith('@') ? r.username : `@${r.username}`)
        .join(', ');
      
      const moreMembers = memberCount > 3 ? ` and ${memberCount - 3} more` : '';
      const memberList = `${receiverNames}${moreMembers}`;
      
      const coinPromptText = includesCoinPrompt 
        ? "\n\nnow for the exciting part - what coin do you want to launch? give me a name, ticker, and image!"
        : "";
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Write a short, badass announcement for a newly created trading group. The group is called "${groupName}" and has ${memberCount} members: ${memberList}.

Make it feel like something important and powerful just got created. Keep it:
- Short (1 sentence max)
- Exciting and energetic 
- Not cringe or over-the-top
- Professional but with personality
- About the group being ready to trade/make moves

Examples of tone:
- "${groupName} is live and ready to dominate! 🚀"
- "${groupName} has entered the game ⚡"
- "Welcome to ${groupName} - let's make some moves 💎"

Don't use the exact examples - create something original that fits the group name and vibe.${coinPromptText ? `

IMPORTANT: After the celebration, add this exact text: "${coinPromptText.trim()}"` : ""}`
        }],
        temperature: 0.7,
        max_tokens: 80
      });

      const message = response.choices[0]?.message?.content?.trim();
      return message || `${groupName} is ready to roll! 🚀${coinPromptText}`;
      
    } catch (error) {
      console.error('Failed to generate group introduction:', error);
      // Fallback to a simple but energetic message
      const coinPromptText = includesCoinPrompt 
        ? "\n\nnow for the exciting part - what coin do you want to launch? give me a name, ticker, and image!"
        : "";
      return `${groupName} is live and ready to trade! 🚀${coinPromptText}`;
    }
  }

  /**
   * Generate a standardized group display format
   */
  static formatGroupDisplay(
    group: any, 
    userState: any, 
    options: {
      showClaimable?: boolean;
      claimableAmount?: number;
      includeEmoji?: boolean;
    } = {}
  ): string {
    const { showClaimable = false, claimableAmount = 0, includeEmoji = true } = options;
    
    // Format group header
    const emoji = includeEmoji ? '📁 ' : '• ';
    const addressDisplay = `${group.id.slice(0, 8)}...${group.id.slice(-6)}`;
    let display = `${emoji}"${group.name}" (${addressDisplay})\n`;
    
    // Format coins
    const groupCoins = userState.coins?.filter((coin: any) => 
      coin.groupId?.toLowerCase() === group.id.toLowerCase() && coin.launched
    ) || [];
    
    const coinTickers = groupCoins.map((coin: any) => coin.ticker);
    const coinsDisplay = coinTickers.length > 0 ? coinTickers.join(', ') : 'none yet';
    display += `- coins: ${coinsDisplay}\n`;
    
    // Format fee receivers
    if (group.receivers && group.receivers.length > 0) {
      const receiverDisplays = group.receivers.map((receiver: any) => {
        // Prefer username if available and not an address format
        let displayName = receiver.username;
        
        // If username is an address or not available, format the address nicely
        if (!displayName || (displayName.startsWith('0x') && displayName.length === 42)) {
          const address = receiver.resolvedAddress || receiver.username;
          if (address && address.startsWith('0x') && address.length === 42) {
            displayName = `${address.slice(0, 6)}...${address.slice(-4)}`;
          } else {
            displayName = address || 'unknown';
          }
        }
        
        // Add @ prefix if not already present and it's not an address format
        if (displayName && !displayName.startsWith('@') && !displayName.includes('...')) {
          displayName = `@${displayName}`;
        }
        
        // Add percentage if available
        const percentage = receiver.percentage ? ` (${receiver.percentage.toFixed(1)}%)` : '';
        return `${displayName}${percentage}`;
      });
      
      display += `- fee receivers: ${receiverDisplays.join(', ')}\n`;
    }
    
    // Add claimable amount if requested
    if (showClaimable) {
      display += `- claimable: ${claimableAmount.toFixed(6)} ETH\n`;
    }
    
    return display;
  }
} 
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { 
  encodeAbiParameters, 
  encodeFunctionData,
  parseUnits, 
  zeroHash
} from "viem";
import { FlaunchZapAbi } from "../../../abi/FlaunchZap";
import { FlaunchZapAddress } from "../../../addresses";
import { getCharacterResponse } from "../../../utils/character";
import { numToHex } from "../../../utils/hex";
import { generateTokenUri } from "../../../utils/ipfs";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { ENSResolverService } from "../../services/ENSResolverService";
import { GraphQLService } from "../../services/GraphQLService";
import { detectChainFromMessage, getChainDescription, getNetworkName } from "../utils/ChainSelection";

interface CoinLaunchData {
  name?: string;
  ticker?: string;
  image?: string;
  targetGroup?: string; // Group ID or name
}

export class CoinLaunchFlow extends BaseFlow {
  private graphqlService: GraphQLService;
  private ensResolver: ENSResolverService;

  constructor() {
    super('CoinLaunchFlow');
    this.graphqlService = new GraphQLService();
    this.ensResolver = new ENSResolverService();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    // Ensure user has groups
    if (userState.groups.length === 0) {
      await this.sendResponse(context, "you need to create a group first before launching coins. want me to help you create one?");
      return;
    }

    this.log('Processing coin launch message', {
      userId: userState.userId,
      groupCount: userState.groups.length,
      messageText: context.messageText.substring(0, 100)
    });

    // Extract coin data and group preference from message
    const extractedData = await this.extractCoinLaunchData(context);
    
    // Determine target group
    const targetGroup = await this.determineTargetGroup(context, extractedData);
    if (!targetGroup) {
      return; // Error handling done in determineTargetGroup
    }

    // Check if we have all coin data
    if (!extractedData.name || !extractedData.ticker || !extractedData.image) {
      await this.requestMissingCoinData(context, extractedData, targetGroup);
      return;
    }

    // Launch the coin
    await this.launchCoinIntoGroup(context, extractedData, targetGroup);
  }

  private async extractCoinLaunchData(context: FlowContext): Promise<CoinLaunchData> {
    const messageText = context.messageText;
    
    // Use LLM to extract coin data and group preference
    const extractionPrompt = `
      Extract coin launch details from this message: "${messageText}"
      
      Look for:
      1. Coin name (e.g., "Token TOKIE", "MyCoin", "DogeCoin")
      2. Coin ticker (usually in parentheses like "(TOKIE)" or derived from name)
      3. Image URL (http/https links) or attachment reference
      4. Group name/identifier (user might specify "into [group]" or "for [group]")
      
      CRITICAL: Return ONLY valid JSON, no explanatory text before or after.
      Format: { "name": "...", "ticker": "...", "image": "...", "targetGroup": "..." }
      Use null for missing fields.
      
      Examples:
      - "launch Token TOKIE" → {"name": "Token TOKIE", "ticker": "TOKIE", "image": null, "targetGroup": null}
      - "create MyCoin (MCN) with image.jpg" → {"name": "MyCoin", "ticker": "MCN", "image": "image.jpg", "targetGroup": null}
    `;

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 200
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        try {
          // Try to extract JSON from the response (in case there's extra text)
          let jsonContent = content;
          
          // Look for JSON object in the response
          const jsonMatch = content.match(/\{[^}]*\}/);
          if (jsonMatch) {
            jsonContent = jsonMatch[0];
          }
          
          const parsed = JSON.parse(jsonContent);
          
          // Handle image attachment
          if (context.hasAttachment && !parsed.image) {
            parsed.image = 'attachment_provided';
          }
          
          this.log('Extracted coin launch data', parsed);
          return parsed;
        } catch (parseError) {
          this.logError('Failed to parse JSON from LLM response', { content, parseError });
          
          // Fallback: try to extract data manually from the message
          const fallbackData = this.extractDataManually(messageText || '');
          if (fallbackData.name || fallbackData.ticker || fallbackData.image) {
            this.log('Using fallback extraction', fallbackData);
            return fallbackData;
          }
        }
      }
    } catch (error) {
      this.logError('Failed to extract coin launch data', error);
    }

    return {};
  }

  private extractDataManually(messageText: string): CoinLaunchData {
    const result: CoinLaunchData = {};
    
    // Extract image URL
    const imageMatch = messageText.match(/(https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.gif|\.webp|plus\.unsplash\.com[^\s]*))/i);
    if (imageMatch) {
      result.image = imageMatch[1];
    }
    
    // Extract potential coin name patterns
    // Look for "Token XXXX", "launch XXXX", "create XXXX"
    const namePatterns = [
      /(?:token|launch|create)\s+([A-Za-z][A-Za-z0-9\s]+?)(?:\s|$|into|with)/i,
      /([A-Za-z][A-Za-z0-9\s]+?)\s*\([A-Z]+\)/i, // Name with ticker in parentheses
    ];
    
    for (const pattern of namePatterns) {
      const match = messageText.match(pattern);
      if (match && match[1]) {
        result.name = match[1].trim();
        break;
      }
    }
    
    // Extract ticker from parentheses or derive from name
    const tickerMatch = messageText.match(/\(([A-Z]{2,6})\)/);
    if (tickerMatch) {
      result.ticker = tickerMatch[1];
    } else if (result.name) {
      // Derive ticker from name (e.g., "Token TOKIE" → "TOKIE")
      const words = result.name.split(' ');
      if (words.length > 1) {
        result.ticker = words[words.length - 1].toUpperCase();
      } else {
        result.ticker = result.name.substring(0, 4).toUpperCase();
      }
    }
    
    // Extract group reference
    const groupMatch = messageText.match(/(?:into|in)\s+(?:that\s+)?(?:group|the\s+group)/i);
    if (groupMatch) {
      result.targetGroup = 'that group'; // User referenced existing group
    }
    
    return result;
  }

  private async determineTargetGroup(context: FlowContext, extractedData: CoinLaunchData): Promise<UserGroup | null> {
    const { userState } = context;
    const groups = userState.groups;

    // If only one group, use it (chain validation will happen in launchCoinIntoGroup)
    if (groups.length === 1) {
      this.log('Using single available group', { 
        groupId: groups[0].id,
        groupChain: groups[0].chainName 
      });
      return groups[0];
    }

    // If user specified a group preference
    if (extractedData.targetGroup) {
      const matchedGroup = this.findGroupByNameOrId(groups, extractedData.targetGroup);
      if (matchedGroup) {
        this.log('Found group by user preference', { 
          preference: extractedData.targetGroup,
          groupId: matchedGroup.id 
        });
        return matchedGroup;
      }
    }

    // Multiple groups, need user to specify
    await this.requestGroupSelection(context, groups);
    return null;
  }

  private findGroupByNameOrId(groups: UserGroup[], identifier: string): UserGroup | null {
    const lowerIdentifier = identifier.toLowerCase();
    
    // Try to match by group number (e.g., "group 1", "1", "group 2")
    const groupNumberMatch = lowerIdentifier.match(/(?:group\s+)?(\d+)/);
    if (groupNumberMatch) {
      const groupNumber = parseInt(groupNumberMatch[1]);
      if (groupNumber >= 1 && groupNumber <= groups.length) {
        return groups[groupNumber - 1]; // Convert to 0-based index
      }
    }
    
    // Try to match by ID (full or partial)
    const byId = groups.find(g => 
      g.id.toLowerCase() === lowerIdentifier || 
      g.id.toLowerCase().includes(lowerIdentifier)
    );
    if (byId) return byId;

    // Try to match by coins in the group (as group names)
    const byCoins = groups.find(g => 
      g.coins.some(coin => coin.toLowerCase().includes(lowerIdentifier))
    );
    if (byCoins) return byCoins;

    return null;
  }

  private async requestGroupSelection(context: FlowContext, groups: UserGroup[]): Promise<void> {
    try {
      // Fetch detailed group data from GraphQL API
      const groupAddresses = groups.map(g => g.id);
      const groupsData = await this.graphqlService.fetchGroupData(groupAddresses);
      
      // Collect all recipient addresses for batch resolution
      const allRecipientAddresses = new Set<string>();
      for (const groupData of groupsData) {
        if (groupData.recipients) {
          groupData.recipients.forEach(r => allRecipientAddresses.add(r.recipient));
        }
      }
      
      // Resolve all addresses to usernames in one batch
      const addressToUsername = await this.ensResolver.resolveAddresses(Array.from(allRecipientAddresses));
      
      let groupsList = "you have multiple groups. which one should i launch this coin into?\n\n";
      
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const shortId = group.id.slice(-8);
        const groupData = groupsData.find(gd => gd.id.toLowerCase() === group.id.toLowerCase());
        
        groupsList += `📁 Group ${i + 1} (${shortId})\n`;
        
        // Format recipients (max 4 with +n for rest)
        let recipientsList = '';
        if (groupData && groupData.recipients && groupData.recipients.length > 0) {
          const recipients = groupData.recipients.map(r => {
            const username = addressToUsername.get(r.recipient.toLowerCase());
            return username || `${r.recipient.slice(0, 6)}...${r.recipient.slice(-4)}`;
          });
          if (recipients.length <= 4) {
            recipientsList = recipients.join(', ');
          } else {
            recipientsList = recipients.slice(0, 4).join(', ') + ` +${recipients.length - 4}`;
          }
        } else {
          // Fallback: try to use the group's receivers data
          if (group.receivers && group.receivers.length > 0) {
            const fallbackRecipients = group.receivers.map(r => {
              // Use username if available, otherwise use shortened address
              return r.username || `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`;
            });
            if (fallbackRecipients.length <= 4) {
              recipientsList = fallbackRecipients.join(', ');
            } else {
              recipientsList = fallbackRecipients.slice(0, 4).join(', ') + ` +${fallbackRecipients.length - 4}`;
            }
          } else {
            recipientsList = `${group.receivers.length + 1} members`;
          }
        }
        
        // Format coins (max 4 with +n for rest)
        let coinsList = '';
        let totalFees = 0;
        if (groupData && groupData.holdings.length > 0) {
          const coins = groupData.holdings.map(h => h.collectionToken.symbol);
          if (coins.length <= 4) {
            coinsList = coins.join(', ');
          } else {
            coinsList = coins.slice(0, 4).join(', ') + ` +${coins.length - 4}`;
          }
          
          // Calculate total fees across all holdings
          totalFees = groupData.holdings.reduce((sum, holding) => {
            return sum + parseFloat(holding.collectionToken.pool.totalFeesUSDC);
          }, 0);
        } else {
          coinsList = 'no coins yet';
        }
        
        groupsList += `   Recipients: ${recipientsList}\n`;
        groupsList += `   Coins: ${coinsList}\n`;
        groupsList += `   Total Fees: $${totalFees.toLocaleString()}\n`;
        
        groupsList += '\n';
      }
      
      groupsList += "specify the group by:\n";
      groupsList += "• group number (e.g., 'group 1', 'group 2')\n";
      groupsList += "• group address (e.g., '...abc123')\n";
      groupsList += "• existing coin name in that group";

      await this.sendResponse(context, groupsList);
      
    } catch (error) {
      this.logError('Failed to fetch group data, falling back to basic display', error);
      
      // Fallback to basic group display if GraphQL fails
      let groupsList = "you have multiple groups. which one should i launch this coin into?\n\n";
      
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const shortId = group.id.slice(-8);
        const coinsList = group.coins.length > 0 ? group.coins.join(', ') : 'no coins yet';
        
        groupsList += `📁 Group ${i + 1} (${shortId})\n`;
        groupsList += `   Coins: ${coinsList}\n`;
        groupsList += `   Members: ${group.receivers.length + 1}\n\n`;
      }
      
      groupsList += "specify the group by:\n";
      groupsList += "• group number (e.g., 'group 1', 'group 2')\n";
      groupsList += "• group address (e.g., '...abc123')\n";
      groupsList += "• existing coin name in that group";

      await this.sendResponse(context, groupsList);
    }
  }

  private async requestMissingCoinData(context: FlowContext, coinData: CoinLaunchData, targetGroup: UserGroup): Promise<void> {
    const missing = [];
    if (!coinData.name) missing.push('coin name');
    if (!coinData.ticker) missing.push('ticker');
    if (!coinData.image) missing.push('image');

    const groupInfo = targetGroup.id.slice(-8);
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to launch a coin into group ${groupInfo} but is missing: ${missing.join(', ')}.
        
        Ask for the missing information. Be specific about what's needed.
        Mention that this coin will be launched into their group.
        Use your character's voice and be encouraging.
      `
    });

    await this.sendResponse(context, response);
  }

  private async launchCoinIntoGroup(context: FlowContext, coinData: CoinLaunchData, targetGroup: UserGroup): Promise<void> {
    this.log('Launching coin into group', {
      userId: context.userState.userId,
      coinData,
      groupId: targetGroup.id
    });

    // Detect chain preference from user message
    const selectedChain = detectChainFromMessage(context.messageText || '');

    this.log('Chain detected for coin launch', {
      userId: context.userState.userId,
      chainName: selectedChain.displayName,
      chainId: selectedChain.id
    });

    // CRITICAL: Validate that the selected chain matches the target group's chain
    if (selectedChain.name !== targetGroup.chainName) {
      this.log('Chain mismatch detected', {
        userId: context.userState.userId,
        selectedChain: selectedChain.name,
        groupChain: targetGroup.chainName,
        groupId: targetGroup.id
      });

      await this.handleChainMismatch(context, selectedChain, targetGroup);
      return;
    }

    try {
      // Process image if it's an attachment
      let imageUrl = coinData.image;
      if (imageUrl === 'attachment_provided' && context.hasAttachment) {
        imageUrl = await context.processImageAttachment(context.attachment);
      }

      // Create transaction calls for coin launch
      const walletSendCalls = await this.createCoinLaunchTransactionCalls({
        name: coinData.name!,
        ticker: coinData.ticker!,
        image: imageUrl!,
        targetGroupId: targetGroup.id,
        creatorAddress: context.creatorAddress,
        context,
        selectedChain
      });

      // Set pending transaction state
      await context.updateState({
        pendingTransaction: {
          type: 'coin_creation',
          coinData: {
            name: coinData.name!,
            ticker: coinData.ticker!,
            image: imageUrl!
          },
          network: getNetworkName(selectedChain),
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Send confirmation message
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Perfect! Sign the transaction to launch $${coinData.ticker} into your group on ${getChainDescription(selectedChain)}!
          
          This will create your coin and start the fair launch.
          
          Keep it concise and encouraging. Use your character's voice.
        `
      });

      await this.sendResponse(context, response);

      // Update user state with new coin
      await context.updateState({
        coins: [
          ...context.userState.coins,
          {
            ticker: coinData.ticker!,
            name: coinData.name!,
            image: imageUrl!,
            groupId: targetGroup.id,
            launched: false, // Will be updated when transaction completes
            fairLaunchDuration: 30 * 60,
            fairLaunchPercent: 40,
            initialMarketCap: 1000,
            chainId: selectedChain.id,
            chainName: selectedChain.name,
            createdAt: new Date()
          }
        ],
        groups: context.userState.groups.map(g => 
          g.id === targetGroup.id 
            ? { ...g, coins: [...g.coins, coinData.ticker!], updatedAt: new Date() }
            : g
        )
      });

    } catch (error) {
      this.logError('Failed to launch coin into group', error);
      await this.sendResponse(context, `failed to prepare your coin launch: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
    }
  }

  private async handleChainMismatch(context: FlowContext, selectedChain: any, targetGroup: UserGroup): Promise<void> {
    const { userState } = context;
    
    // Import chain utilities
    const { SUPPORTED_CHAINS, getChainDescription } = await import('../utils/ChainSelection');
    const targetChainConfig = SUPPORTED_CHAINS[targetGroup.chainName];
    
    // Get all groups on the selected chain
    const groupsOnSelectedChain = userState.groups.filter(g => g.chainName === selectedChain.name);
    
    // Build context for character response
    let groupInfo = '';
    if (groupsOnSelectedChain.length > 0) {
      groupInfo = `User has ${groupsOnSelectedChain.length} group(s) on ${selectedChain.displayName}:\n`;
      for (let i = 0; i < groupsOnSelectedChain.length; i++) {
        const group = groupsOnSelectedChain[i];
        const shortId = group.id.slice(-8);
        const coinsList = group.coins.length > 0 ? group.coins.join(', ') : 'no coins yet';
        groupInfo += `Group ${i + 1} (${shortId}): Recipients ${group.receivers.map(r => r.username).join(', ')}, Coins: ${coinsList}\n`;
      }
      groupInfo += `Suggest they launch into one of these groups or switch to ${getChainDescription(targetChainConfig)}.`;
    } else {
      groupInfo = `User has NO groups on ${selectedChain.displayName}. Their only option is to switch to ${getChainDescription(targetChainConfig)} or create a new group.`;
    }
    
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        CRITICAL ISSUE: User is trying to launch a coin on ${selectedChain.displayName} but their target group is on ${getChainDescription(targetChainConfig)}. 
        
        This won't work - coins must be launched on the same chain as their group!
        
        Context: ${groupInfo}
        
        Explain this chain mismatch issue in your character voice. Be helpful but maintain your personality.
        Make it clear that chains must match, but keep it friendly and guide them to a solution.
        Use your cat-themed language and be encouraging despite the technical issue.
      `
    });
    
    await this.sendResponse(context, response);
  }

  private async createCoinLaunchTransactionCalls(params: {
    name: string;
    ticker: string;
    image: string;
    targetGroupId: string;
    creatorAddress: string;
    context: FlowContext;
    selectedChain: any;
  }): Promise<any> {
    
    this.log('Creating coin launch transaction calls', {
      name: params.name,
      ticker: params.ticker,
      targetGroupId: params.targetGroupId,
      chain: params.selectedChain.displayName
    });

    try {
      const { name, ticker, image, targetGroupId, creatorAddress, context, selectedChain } = params;
      const chain = selectedChain;
      
      // Constants for token launch
      const TOTAL_SUPPLY = 100n * 10n ** 27n;
      
      // Process image to base64 if needed
      let base64Image = '';
      if (image && image !== 'attachment_provided') {
        if (image.startsWith('http')) {
          try {
            const response = await fetch(image);
            if (response.ok) {
              const buffer = await response.arrayBuffer();
              const uint8Array = new Uint8Array(buffer);
              base64Image = Buffer.from(uint8Array).toString('base64');
            }
          } catch (error) {
            this.logError('Failed to fetch image from URL', { image, error });
          }
        }
      } else if (image === 'attachment_provided' && context.hasAttachment) {
        base64Image = await context.processImageAttachment(context.attachment);
      }

      // Generate token URI
      let tokenUri = '';
      const pinataJWT = process.env.PINATA_JWT;
      
      if (base64Image && pinataJWT) {
        this.log('Generating token URI with image');
        tokenUri = await generateTokenUri(name, {
          pinataConfig: { jwt: pinataJWT },
          metadata: {
            imageUrl: base64Image,
            description: `Flaunched via Flaunchy on XMTP`,
            websiteUrl: '',
            discordUrl: '',
            twitterUrl: '',
            telegramUrl: '',
          },
        });
        this.log('Generated token URI', { tokenUri });
      }

      // Calculate launch parameters
      const fairLaunchInBps = 4000n; // 40%
      const creatorFeeAllocationInBps = 10000; // 100% as number, not bigint
      const startingMarketCapUSD = 1000;
      const premineAmount = 0n; // No premine for immediate launch

      // Calculate initial price parameters for $1000 market cap
      const initialTokenFairLaunch = (TOTAL_SUPPLY * fairLaunchInBps) / 10000n;
      const ethAmount = parseUnits(startingMarketCapUSD.toString(), 6); // Using 6 decimals for USD equivalent
      const initialPriceParams = encodeAbiParameters(
        [
          { type: 'uint256', name: 'ethAmount' },
          { type: 'uint256', name: 'tokenAmount' }
        ],
        [ethAmount, initialTokenFairLaunch]
      );

      // Prepare flaunch parameters
      const flaunchParams = {
        name: name,
        symbol: ticker,
        tokenUri,
        initialTokenFairLaunch,
        fairLaunchDuration: BigInt(60 * 30), // 30 minutes fair launch duration
        premineAmount, // Zero
        creator: creatorAddress as `0x${string}`,
        creatorFeeAllocation: creatorFeeAllocationInBps,
        flaunchAt: 0n, // Launch immediately
        initialPriceParams,
        feeCalculatorParams: '0x' as `0x${string}`,
      };

      // Treasury manager parameters - use the existing group's manager address
      const treasuryManagerParams = {
        manager: targetGroupId as `0x${string}`, // Use the group's manager address
        initializeData: '0x' as `0x${string}`, // Empty since manager is pre-configured
        depositData: '0x' as `0x${string}`, // Empty
      };

      // Whitelist parameters (empty for public launch)
      const whitelistParams = {
        merkleRoot: zeroHash,
        merkleIPFSHash: '',
        maxTokens: 0n,
      };

      // Airdrop parameters (empty for no airdrop)
      const airdropParams = {
        airdropIndex: 0n,
        airdropAmount: 0n,
        airdropEndTime: 0n,
        merkleRoot: zeroHash,
        merkleIPFSHash: '',
      };

      this.log('Prepared launch parameters', {
        name: name,
        symbol: ticker,
        targetGroupId,
        flaunchParams,
        treasuryManagerParams
      });

      // Encode the flaunch function call
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

      this.log('Encoded function data for FlaunchZap contract');

      // Create wallet send calls
      const walletSendCalls = {
        version: '1.0',
        from: context.senderInboxId,
        chainId: numToHex(chain.id),
        calls: [
          {
            chainId: chain.id,
            to: FlaunchZapAddress[chain.id],
            data: functionData,
            value: '0',
            metadata: {
              description: `Launch $${ticker} into existing Group (${targetGroupId.slice(0, 6)}...${targetGroupId.slice(-4)}) on ${chain.displayName}`,
            },
          },
        ],
      };

      this.log('Created wallet send calls for coin launch', {
        targetContract: FlaunchZapAddress[chain.id],
        chainId: chain.id,
        functionName: 'flaunch'
      });

      return walletSendCalls;

    } catch (error) {
      this.logError('Failed to create coin launch transaction', error);
      throw error;
    }
  }
} 
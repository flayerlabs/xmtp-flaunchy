import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { UserGroup } from "../../core/types/UserState";
import { getCharacterResponse } from "../../../utils/character";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";

interface CoinLaunchData {
  name?: string;
  ticker?: string;
  image?: string;
  targetGroup?: string; // Group ID or name
}

export class CoinLaunchFlow extends BaseFlow {
  constructor() {
    super('CoinLaunchFlow');
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
      1. Coin name
      2. Coin ticker (usually in parentheses)
      3. Image URL or attachment reference
      4. Group name/identifier (user might specify "into [group]" or "for [group]")
      
      Return JSON with: { "name": "...", "ticker": "...", "image": "...", "targetGroup": "..." }
      Use null for missing fields.
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
        const parsed = JSON.parse(content);
        
        // Handle image attachment
        if (context.hasAttachment && !parsed.image) {
          parsed.image = 'attachment_provided';
        }
        
        this.log('Extracted coin launch data', parsed);
        return parsed;
      }
    } catch (error) {
      this.logError('Failed to extract coin launch data', error);
    }

    return {};
  }

  private async determineTargetGroup(context: FlowContext, extractedData: CoinLaunchData): Promise<UserGroup | null> {
    const { userState } = context;
    const groups = userState.groups;

    // If only one group, use it
    if (groups.length === 1) {
      this.log('Using single available group', { groupId: groups[0].id });
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
    let groupsList = "you have multiple groups. which one should i launch this coin into?\n\n";
    
    for (const group of groups) {
      const shortId = group.id.slice(-8);
      const coinsList = group.coins.length > 0 ? group.coins.join(', ') : 'no coins yet';
      
      groupsList += `📁 Group ${shortId}\n`;
      groupsList += `   Coins: ${coinsList}\n`;
      groupsList += `   Members: ${group.receivers.length + 1}\n\n`;
    }
    
    groupsList += "specify the group by:\n";
    groupsList += "• group address (e.g., '...abc123')\n";
    groupsList += "• existing coin name in that group\n";
    groupsList += "• or say 'group 1', 'group 2', etc.";

    await this.sendResponse(context, groupsList);
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
        context
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
          network: process.env.XMTP_ENV === 'production' ? 'base' : 'base-sepolia',
          timestamp: new Date()
        }
      });

      // Send transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

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

  private async createCoinLaunchTransactionCalls(params: {
    name: string;
    ticker: string;
    image: string;
    targetGroupId: string;
    creatorAddress: string;
    context: FlowContext;
  }): Promise<any> {
    // This would be similar to the onboarding launch but for existing groups
    // For now, return a placeholder - this would need the actual Flaunch SDK integration
    
    this.log('Creating coin launch transaction calls', {
      name: params.name,
      ticker: params.ticker,
      targetGroupId: params.targetGroupId
    });

    // TODO: Implement actual transaction creation using Flaunch SDK
    // This should create a transaction that launches a coin into an existing group
    
    return {
      version: '1.0',
      from: params.context.senderInboxId,
      chainId: '0x2105', // Base
      calls: [{
        to: '0x0000000000000000000000000000000000000000', // Placeholder
        data: '0x', // Placeholder
        value: '0',
        metadata: {
          description: `Launch ${params.ticker} into existing group ${params.targetGroupId.slice(-8)}`
        }
      }]
    };
  }
} 
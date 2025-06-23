import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";

type ManagementAction = 'list_groups' | 'list_coins' | 'add_coin' | 'general_help';

export class ManagementFlow extends BaseFlow {
  constructor() {
    super('ManagementFlow');
  }

  async processMessage(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);
    
    this.log('Processing management command', { 
      userId: context.userState.userId,
      command: messageText.substring(0, 50) + '...'
    });

    // Use LLM to determine the specific management action
    const action = await this.classifyManagementAction(messageText, context);
    
    switch (action) {
      case 'list_groups':
        await this.handleListGroups(context);
        break;
      case 'list_coins':
        await this.handleListCoins(context);
        break;
      case 'add_coin':
        await this.handleAddCoin(context);
        break;
      default:
        await this.handleGeneralManagement(context);
        break;
    }
  }

  private async classifyManagementAction(message: string, context: FlowContext): Promise<ManagementAction> {
    const prompt = `
Classify this management request into a specific action.

USER MESSAGE: "${message}"

USER CONTEXT:
- Groups: ${context.userState.groups.length}
- Coins: ${context.userState.coins.length}

ACTION OPTIONS:
1. list_groups - User wants to see their groups (examples: "show my groups", "do I have any groups?", "my groups", "list groups")
2. list_coins - User wants to see their coins (examples: "show my coins", "do I have any coins?", "my coins", "list coins")  
3. add_coin - User wants to add/launch a new coin (examples: "add coin", "launch coin", "create new coin")
4. general_help - General management help or unclear request

RULES:
- Questions about "having" or "owning" groups/coins should map to list_groups/list_coins
- Requests to "show", "see", "view" should map to the appropriate list action
- Focus on the main intent of the message

Respond with ONLY the action name: list_groups, list_coins, add_coin, or general_help`;

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 50,
      });

      const action = response.choices[0]?.message?.content?.trim().toLowerCase();
      
      if (action && ['list_groups', 'list_coins', 'add_coin', 'general_help'].includes(action)) {
        console.log(`[ManagementFlow] Action classified as: ${action}`);
        return action as ManagementAction;
      }
      
      console.warn(`[ManagementFlow] Invalid action returned: ${action}, defaulting to general_help`);
      return 'general_help';
      
    } catch (error) {
      console.error('[ManagementFlow] Action classification failed:', error);
      return 'general_help';
    }
  }

  private async handleListCoins(context: FlowContext): Promise<void> {
    // Get user state with live data injected
    const enrichedUserState = await context.sessionManager.getUserStateWithLiveData(context.userState.userId);
    
    if (enrichedUserState.coins.length === 0) {
      await this.sendResponse(context, "you don't have any coins yet. want me to help you launch one?");
      return;
    }

    let coinsList = "here are your coins:\n\n";
    
    for (const coin of enrichedUserState.coins) {
      // Show live data if available, otherwise show initial data
      if (coin.liveData) {
        const marketCap = parseFloat(coin.liveData.marketCapUSDC);
        const priceChange = coin.liveData.priceChangePercentage;
        const holders = coin.liveData.totalHolders;
        
        coinsList += `${coin.name} (${coin.ticker}) - $${marketCap.toLocaleString()} USDC, ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%, ${holders.toLocaleString()} holders\n`;
      } else {
        // For coins without live data, show initial market cap and indicate no live data
        coinsList += `${coin.name} (${coin.ticker}) - $${coin.initialMarketCap.toLocaleString()} USDC (initial), no live data yet\n`;
      }
    }

    await this.sendResponse(context, coinsList);
  }

  private async handleListGroups(context: FlowContext): Promise<void> {
    // Get user state with live data injected
    const enrichedUserState = await context.sessionManager.getUserStateWithLiveData(context.userState.userId);
    
    if (enrichedUserState.groups.length === 0) {
      await this.sendResponse(context, "you don't have any groups yet. want me to help you create one?");
      return;
    }

    let groupsList = "here are your groups:\n\n";
    
    for (const group of enrichedUserState.groups) {
      groupsList += `👥 Group ${group.id.slice(-8)}\n`;
      groupsList += `- type: ${group.type.replace('_', ' ')}\n`;
      
      // Show live data if available
      if (group.liveData) {
        groupsList += `- coins: ${group.liveData.totalCoins}\n`;
        groupsList += `- total fees: $${parseFloat(group.liveData.totalFeesUSDC).toLocaleString()}\n`;
        groupsList += `- recipients: ${group.liveData.recipients.length}\n`;
      } else {
        groupsList += `- coins: ${group.coins.join(', ')}\n`;
        groupsList += `- members: ${group.receivers.length + 1}\n`;
      }
      
      groupsList += '\n';
    }

    await this.sendResponse(context, groupsList);
  }

  private async handleAddCoin(context: FlowContext): Promise<void> {
    // Check if user has groups
    if (context.userState.groups.length === 0) {
      await this.sendResponse(context, "you need to create a group first. want me to help you create one?");
      return;
    }

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to add a new coin to their existing group.
        They currently have ${context.userState.groups.length} groups.
        
        Explain that they can add more coins to existing groups and ask:
        - What's the new coin name?
        - What ticker?
        - What image?
        - Which group to add it to (if they have multiple)?
        
        Keep it helpful and guide them through the process.
        Mention that the coin launch flow will handle this.
      `
    });

    await this.sendResponse(context, response);
    
    // Note: The actual coin launch will be handled by CoinLaunchFlow 
    // when user provides coin details in their next message
  }

  private async handleGeneralManagement(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User sent a management-related message but it's not a specific command.
        
        Show them what they can do:
        - "show coins" or "my coins" to see their coins
        - "show groups" or "my groups" to see their groups  
        - "add coin" to launch a new coin
        - Ask questions about managing their coins/groups
        
        Be helpful and use your character's personality.
      `
    });

    await this.sendResponse(context, response);
  }
} 
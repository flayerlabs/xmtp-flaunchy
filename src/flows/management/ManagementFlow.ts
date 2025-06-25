import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { getCharacterResponse } from "../../../utils/character";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { ENSResolverService } from "../../services/ENSResolverService";
import { GraphQLService, GroupData } from "../../services/GraphQLService";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { detectChainFromMessage, getChainDescription, getNetworkName, DEFAULT_CHAIN, SUPPORTED_CHAINS } from "../utils/ChainSelection";

type ManagementAction = 'list_groups' | 'list_coins' | 'add_coin' | 'create_group' | 'claim_fees' | 'general_help';

export class ManagementFlow extends BaseFlow {
  private graphqlService: GraphQLService;
  private ensResolver: ENSResolverService;

  constructor() {
    super('ManagementFlow');
    this.graphqlService = new GraphQLService();
    this.ensResolver = new ENSResolverService();
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);

    this.log('Processing management message', { 
      userId: userState.userId,
      messageText: messageText?.substring(0, 100)
    });

    // PRIORITY: Check for pending transaction inquiries using LLM
    if (userState.pendingTransaction && messageText) {
      const transactionResponse = await this.handleTransactionInquiryWithLLM(context, messageText);
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
    }

    // Check if user has ongoing management progress
    if (userState.managementProgress) {
      await this.handleOngoingProcess(context);
      return;
    }

    // Classify the management action
    const action = await this.classifyManagementAction(messageText || '', context);
    
    this.log('Management action classified', {
      userId: userState.userId,
      action,
      messageText: messageText?.substring(0, 50)
    });

    switch (action) {
      case 'list_groups':
        await this.handleListGroups(context);
        break;
      case 'list_coins':
        await this.handleListCoins(context);
        break;
      case 'create_group':
        await this.handleCreateGroup(context);
        break;
      case 'add_coin':
        await this.handleAddCoin(context);
        break;
      case 'claim_fees':
        await this.handleClaimFees(context);
        break;
      case 'general_help':
      default:
        await this.handleGeneralHelp(context);
        break;
    }
  }

  private async handleTransactionInquiryWithLLM(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState, openai } = context;
    
    if (!userState.pendingTransaction) {
      return null;
    }

    // Get transaction context
    let transactionContext = '';
    if (userState.pendingTransaction.type === 'group_creation') {
      const progress = userState.managementProgress;
      if (progress?.groupCreationData?.receivers && progress.groupCreationData.receivers.length > 0) {
        const receiverList = progress.groupCreationData.receivers
          .map((r: any) => {
            // Use resolved address for display if username is an address
            const displayName = (r.username && r.username.startsWith('0x') && r.username.length === 42)
              ? `${r.username.slice(0, 6)}...${r.username.slice(-4)}`
              : (r.username || `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`);
            return `${displayName}${r.percentage ? ` (${r.percentage}%)` : ''}`;
          })
          .join(', ');
        transactionContext = `Group creation transaction with fee receivers: ${receiverList}`;
      } else {
        transactionContext = 'Group creation transaction with equal fee splitting among all members';
      }
    } else if (userState.pendingTransaction.type === 'coin_creation') {
      transactionContext = 'Coin launch transaction with previously specified fee receivers';
    } else {
      transactionContext = 'Transaction pending in wallet';
    }

    const prompt = `
User has a pending ${userState.pendingTransaction.type} transaction.
Transaction context: ${transactionContext}

User message: "${messageText}"

Is this user asking about their pending transaction OR wanting to cancel it?

If asking about the transaction, provide a helpful response using the context above.
If wanting to cancel, return "CANCEL_TRANSACTION".
If this is NOT about the transaction, return "NOT_TRANSACTION_INQUIRY".

Guidelines for transaction info:
- Answer directly and naturally about the transaction details
- Use the transaction context to provide specific details about fee receivers
- Be concise and conversational, not formal
- Use casual, encouraging tone
- Don't start with phrases like "It looks like" or "It sounds like"
- Just answer the question directly
- For addresses, show them in truncated format (0x1234...5678)

Guidelines for cancellation detection:
- Look for words like "cancel", "stop", "abort", "don't want", "nevermind", "changed my mind"
- Be generous in detecting cancellation intent

Return one of:
1. A direct, helpful response about the transaction
2. "CANCEL_TRANSACTION" if they want to cancel
3. "NOT_TRANSACTION_INQUIRY" if neither
`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      });

      const result = response.choices[0]?.message?.content?.trim() || '';
      
      if (result === 'NOT_TRANSACTION_INQUIRY') {
        return null;
      }

      if (result === 'CANCEL_TRANSACTION') {
        await this.handleTransactionCancellation(context);
        return 'transaction cancelled! you can create a new group or launch a coin whenever you\'re ready.';
      }

      this.log('Transaction inquiry detected and responded to', {
        userId: userState.userId,
        messageText: messageText.substring(0, 100),
        transactionType: userState.pendingTransaction.type
      });

      return result;
    } catch (error) {
      this.logError('Failed to process transaction inquiry', error);
      return null;
    }
  }

  private async handleOngoingProcess(context: FlowContext): Promise<void> {
    const progress = context.userState.managementProgress!;
    
    this.log('Handling ongoing management process', {
      userId: context.userState.userId,
      action: progress.action,
      step: progress.step
    });

    if (progress.action === 'creating_group') {
      await this.handleGroupCreationProgress(context);
    } else if (progress.action === 'adding_coin') {
      await this.handleCoinAdditionProgress(context);
    }
  }

  private async handleGroupCreationProgress(context: FlowContext): Promise<void> {
    const progress = context.userState.managementProgress!;

    if (progress.step === 'collecting_fee_receivers') {
      // Use LLM to determine if user is confirming group creation or providing fee receivers
      const selectedChain = detectChainFromMessage(context.messageText || '');
      const chainDescription = selectedChain.name !== 'base' ? ` on ${getChainDescription(selectedChain)}` : '';
      
      const confirmationPrompt = `
        The user was asked: "want to see all groups or create one ${chainDescription}?"
        User responded: "${context.messageText}"
        
        Is this a confirmation to create a group, or are they providing fee receiver details?
        
        Return ONLY:
        "confirmation" - if they're confirming they want to create a group
        "fee_receivers" - if they're providing usernames/addresses/percentages
        "unclear" - if unclear
      `;

      const confirmationResponse = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: confirmationPrompt }],
        temperature: 0.1,
        max_tokens: 20
      });

      const userIntent = confirmationResponse.choices[0]?.message?.content?.trim();
      
      if (userIntent === 'confirmation') {
        // User is confirming they want to create a group, now ask for fee receivers
        const selectedChain = detectChainFromMessage(context.messageText || '');
        
        const response = await getCharacterResponse({
          openai: context.openai,
          character: context.character,
          prompt: `
            User confirmed they want to create a group${selectedChain.name !== 'base' ? ` on ${getChainDescription(selectedChain)}` : ''}. Now ask them who should receive the trading fees.
            
            They can specify:
            - Farcaster usernames (@alice)
            - ENS names (alice.eth)
            - Ethereum addresses (0x123...)
            - Optional percentages like "@alice 30%, @bob 70%"
            - Or "add everyone" for all group chat members
            
            Who should receive the fees for your new group?
          `
        });

        await this.sendResponse(context, response);
        return;
      }
      
      try {
        // Detect chain preference from user message
        const selectedChain = detectChainFromMessage(context.messageText || '');
        
        this.log('Chain detected for group creation', {
          userId: context.userState.userId,
          chainName: selectedChain.displayName,
          chainId: selectedChain.id
        });

        // Use LLM to detect "add everyone" commands
        const addEveryonePrompt = `
          User message: "${context.messageText}"
          
          Is the user requesting to include all group chat members in the fee split?
          Look for patterns like:
          - "add everyone"
          - "for everyone"
          - "everyone in the chat"
          - "all chat members"
          - "include everyone"
          - "all members"
          - "everyone here"
          - "split with everyone"
          
          Return ONLY:
          "yes" - if they want to add all group members
          "no" - if they're providing specific receivers or other intent
        `;

        const addEveryoneResponse = await context.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: addEveryonePrompt }],
          temperature: 0.1,
          max_tokens: 10
        });

        const isAddEveryone = addEveryoneResponse.choices[0]?.message?.content?.trim() === 'yes';
        
        if (isAddEveryone) {
          await this.handleAddEveryoneForManagement(context, selectedChain);
          return;
        }

        // Use shared utility for the complete group creation workflow
        const result = await GroupCreationUtils.createGroupFromMessage(
          context, 
          selectedChain,
          "Create Additional Group"
        );

        if (result) {
          this.log('Group creation successful, sending transaction', {
            userId: context.userState.userId,
            resolvedReceivers: result.resolvedReceivers,
            chain: result.chainConfig.displayName
          });

          // Update management progress and set pending transaction
          await context.updateState({
            managementProgress: undefined, // Clear management progress
            pendingTransaction: {
              type: 'group_creation',
              network: getNetworkName(result.chainConfig),
              timestamp: new Date()
            }
          });

          // Send the wallet transaction
          await context.conversation.send(result.walletSendCalls, ContentTypeWalletSendCalls);

          // Let user know what's happening
          const response = await getCharacterResponse({
            openai: context.openai,
            character: context.character,
            prompt: `
              Perfect! Sign the transaction to create your new group on ${getChainDescription(result.chainConfig)}!
              
              This will set up the fee splitting you specified. You can ask questions about the transaction or say "cancel" if you change your mind.
              
              Keep it concise and encouraging. Use your character's voice.
            `
          });

          await this.sendResponse(context, response);

      } else {
          // Ask for fee receivers again if extraction failed
          const response = await getCharacterResponse({
            openai: context.openai,
            character: context.character,
            prompt: `
              User didn't provide clear fee receivers for the new group.
              Ask them again to specify:
              - Farcaster usernames (@alice)
              - ENS names (alice.eth) 
              - Ethereum addresses (0x123...)
              - Optional percentages like "@alice 30%, @bob 70%"
              - Or "add everyone" for all group chat members
              - They can also specify "on Base Sepolia" or "on testnet" for network selection
              
              Be helpful and encourage them to try again.
            `
          });
          await this.sendResponse(context, response);
      }

      } catch (error) {
        this.logError('Failed to create group', error);
        await this.sendResponse(context, `failed to create group: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
      }
    }
  }

  private async handleCoinAdditionProgress(context: FlowContext): Promise<void> {
    // TODO: Implement coin addition progress handling
    this.log('Coin addition progress not yet implemented');
  }

  private async handleListGroups(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    if (userState.groups.length === 0) {
      await this.sendResponse(context, "you don't have any groups yet. want me to help you create one?");
      return;
    }

    // Detect chain preference from user message
    const requestedChain = detectChainFromMessage(context.messageText || '');
    
    // Filter groups by requested chain (if specific chain requested) or show all
    let groupsToShow = userState.groups;
    let chainFilter = '';
    
    // If user specifically mentioned a chain, filter by that chain
    if (context.messageText && (
      context.messageText.toLowerCase().includes('sepolia') ||
      context.messageText.toLowerCase().includes('testnet') ||
      context.messageText.toLowerCase().includes('mainnet') ||
      context.messageText.toLowerCase().includes('base sepolia') ||
      context.messageText.toLowerCase().includes('base mainnet')
    )) {
      groupsToShow = userState.groups.filter(group => group.chainName === requestedChain.name);
      chainFilter = ` on ${requestedChain.displayName}`;
      
      if (groupsToShow.length === 0) {
        // Set management progress to indicate user might want to create a group
        await context.updateState({
          managementProgress: {
            action: 'creating_group',
            step: 'collecting_fee_receivers',
            startedAt: new Date()
          }
        });
        
        await this.sendResponse(context, `you don't have any groups${chainFilter}. your groups are on different chains. want to see all groups or create one${chainFilter}?`);
        return;
      }
    }

    this.log('Listing groups', {
      userId: userState.userId,
      totalGroups: userState.groups.length,
      filteredGroups: groupsToShow.length,
      requestedChain: requestedChain.displayName
    });

    try {
      // Fetch live data for groups, grouped by chain
      const groupsByChain = new Map<string, { groups: any[], chainConfig: any }>();
      
      for (const group of groupsToShow) {
        const chainConfig = SUPPORTED_CHAINS[group.chainName];
        if (!chainConfig) continue;
        
        if (!groupsByChain.has(group.chainName)) {
          groupsByChain.set(group.chainName, { groups: [], chainConfig });
        }
        groupsByChain.get(group.chainName)!.groups.push(group);
      }

      let groupsList = `here are your groups${chainFilter}:\n\n`;
      let groupIndex = 1;

      for (const [chainName, { groups, chainConfig }] of groupsByChain) {
        // Fetch live data for this chain
        const groupAddresses = groups.map(g => g.id);
        const groupsData = await this.graphqlService.fetchGroupData(groupAddresses, chainConfig);
        
        // Only add chain header if NOT Base Mainnet OR if showing multiple chains
        if (chainConfig.name !== 'base' || groupsByChain.size > 1) {
          groupsList += `\n🔗 **${chainConfig.displayName}**\n`;
        }

        for (const group of groups) {
          const groupData = groupsData.find(gd => gd.id.toLowerCase() === group.id.toLowerCase());
        
          groupsList += `📁 Group ${groupIndex++} (${group.id.slice(-8)})\n`;
        
        // Format recipients (max 4 with +n for rest) - resolve addresses back to usernames when possible
        let recipientsList = '';
        if (groupData && groupData.recipients && groupData.recipients.length > 0) {
          const recipients = groupData.recipients.map(r => {
            // Try to find the original username for this address
            const originalReceiver = group.receivers.find((gr: { username: string; resolvedAddress: string; percentage: number }) => 
              gr.resolvedAddress.toLowerCase() === r.recipient.toLowerCase()
            );
            
            if (originalReceiver) {
              // Use original username if it's not an address, otherwise show truncated address
              if (originalReceiver.username.startsWith('0x')) {
                return `${originalReceiver.username.slice(0, 6)}...${originalReceiver.username.slice(-4)}`;
              } else {
                return originalReceiver.username;
              }
            } else {
              // Fallback to truncated address
              return `${r.recipient.slice(0, 6)}...${r.recipient.slice(-4)}`;
            }
          });
          
          if (recipients.length <= 4) {
            recipientsList = recipients.join(', ');
          } else {
            recipientsList = recipients.slice(0, 4).join(', ') + ` +${recipients.length - 4}`;
          }
        } else {
          recipientsList = `${group.receivers.length} members`;
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
            coinsList = group.coins.length > 0 ? group.coins.join(', ') : 'no coins yet';
        }
        
        groupsList += `- Recipients: ${recipientsList}\n`;
        groupsList += `- Coins: ${coinsList}\n`;
        groupsList += `- Total Fees Earned: $${totalFees.toLocaleString()}\n`;
          
          // Only add chain info for non-Base-Mainnet groups when showing all chains
          if (groupsByChain.size > 1 && chainConfig.name !== 'base') {
            groupsList += `- Network: ${chainConfig.displayName}\n`;
          }
        
        groupsList += '\n';
        }
    }

    // Add the mini.flaunch.gg link for coin management
    groupsList += `\nℹ️ **Manage your coins and claim fees at https://mini.flaunch.gg**`;

    await this.sendResponse(context, groupsList);
      
    } catch (error) {
      this.logError('Failed to fetch group data, falling back to basic display', error);
      
      // Fallback to basic group display if GraphQL fails
      let groupsList = `here are your groups${chainFilter}:\n\n`;
      
      for (let i = 0; i < groupsToShow.length; i++) {
        const group = groupsToShow[i];
        const chainConfig = SUPPORTED_CHAINS[group.chainName];
        
        groupsList += `📁 Group ${i + 1} (${group.id.slice(-8)})\n`;
        groupsList += `- Type: ${group.type.replace('_', ' ')}\n`;
        groupsList += `- Coins: ${group.coins.length > 0 ? group.coins.join(', ') : 'no coins yet'}\n`;
        groupsList += `- Members: ${group.receivers.length}\n`;
        
        // Only add chain info for non-Base-Mainnet groups
        if (chainConfig && chainConfig.name !== 'base') {
          groupsList += `- Network: ${chainConfig.displayName}\n`;
        }
        
        groupsList += '\n';
      }

      // Add the mini.flaunch.gg link for coin management
      groupsList += `\nℹ️ **Manage your coins and claim fees at https://mini.flaunch.gg**`;

      await this.sendResponse(context, groupsList);
    }
  }

  private async handleListCoins(context: FlowContext): Promise<void> {
    const { userState } = context;

    if (userState.coins.length === 0) {
      await this.sendResponse(context, "you don't have any coins yet. want me to help you launch one?");
      return;
    }

    // Detect chain preference from user message
    const requestedChain = detectChainFromMessage(context.messageText || '');
    
    // Filter coins by requested chain (if specific chain requested) or show all
    let coinsToShow = userState.coins;
    let chainFilter = '';
    
    // If user specifically mentioned a chain, filter by that chain
    if (context.messageText && (
      context.messageText.toLowerCase().includes('sepolia') ||
      context.messageText.toLowerCase().includes('testnet') ||
      context.messageText.toLowerCase().includes('mainnet') ||
      context.messageText.toLowerCase().includes('base sepolia') ||
      context.messageText.toLowerCase().includes('base mainnet')
    )) {
      coinsToShow = userState.coins.filter(coin => coin.chainName === requestedChain.name);
      chainFilter = ` on ${requestedChain.displayName}`;
      
      if (coinsToShow.length === 0) {
        await this.sendResponse(context, `you don't have any coins${chainFilter}. your coins are on different chains. want to see all coins or launch one${chainFilter}?`);
        return;
      }
    }

    this.log('Listing coins', {
      userId: userState.userId,
      totalCoins: userState.coins.length,
      filteredCoins: coinsToShow.length,
      requestedChain: requestedChain.displayName
    });

    // Group coins by chain for display
    const coinsByChain = new Map<string, { coins: any[], chainConfig: any }>();
    
    for (const coin of coinsToShow) {
      const chainConfig = SUPPORTED_CHAINS[coin.chainName];
      if (!chainConfig) continue;
      
      if (!coinsByChain.has(coin.chainName)) {
        coinsByChain.set(coin.chainName, { coins: [], chainConfig });
      }
      coinsByChain.get(coin.chainName)!.coins.push(coin);
    }

    let coinsList = `here are your coins${chainFilter}:\n\n`;
    let coinIndex = 1;

    for (const [chainName, { coins, chainConfig }] of coinsByChain) {
      // Only add chain header if NOT Base Mainnet OR if showing multiple chains
      if (chainConfig.name !== 'base' || coinsByChain.size > 1) {
        coinsList += `\n🔗 **${chainConfig.displayName}**\n`;
      }

      for (const coin of coins) {
        coinsList += `🪙 ${coinIndex++}. ${coin.name} (${coin.ticker})\n`;
        coinsList += `- Status: ${coin.launched ? 'Launched' : 'Pending'}\n`;
        coinsList += `- Group: ${coin.groupId.slice(-8)}\n`;
        
        if (coin.contractAddress) {
          coinsList += `- Contract: ${coin.contractAddress.slice(0, 6)}...${coin.contractAddress.slice(-4)}\n`;
        }
        
        // Only add chain info for non-Base-Mainnet coins when showing all chains
        if (coinsByChain.size > 1 && chainConfig.name !== 'base') {
          coinsList += `- Network: ${chainConfig.displayName}\n`;
        }
        
        coinsList += '\n';
      }
    }

    // Add the mini.flaunch.gg link for coin management
    coinsList += `\nℹ️ **Manage your coins and claim fees at https://mini.flaunch.gg**`;

    await this.sendResponse(context, coinsList);
  }

  private async handleAddCoin(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to add a coin to one of their groups. 
        
        Ask them:
        1. Which group they want to add the coin to (show group numbers/IDs)
        2. Coin details: name, ticker, image
        3. Network preference if they want to specify
        
        Be helpful and guide them through the process. Use your character's voice.
      `
    });

    await this.sendResponse(context, response);
  }

  private async handleCreateGroup(context: FlowContext): Promise<void> {
    const { userState } = context;

    // Start management progress for group creation
    await context.updateState({
      managementProgress: {
        action: 'creating_group',
        step: 'collecting_fee_receivers',
        startedAt: new Date()
      }
    });

    // Detect chain preference from user message
    const selectedChain = detectChainFromMessage(context.messageText || '');

    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to create an additional group. Ask them who should receive the trading fees.
        
        They can specify:
        - Farcaster usernames (@alice)
        - ENS names (alice.eth)
        - Ethereum addresses (0x123...)
        - Optional percentages like "@alice 30%, @bob 70%"
        - Or "add everyone" for all group chat members
        
        ${selectedChain.name !== 'base' ? `Current network selection: ${getChainDescription(selectedChain)}` : ''}
        ${selectedChain.name !== 'base' ? 'They can also say "on Base Mainnet" to switch networks.' : 'They can also say "on Base Sepolia" or "on testnet" to switch networks.'}
        
        Who should receive the fees for your new group?
      `
    });

    await this.sendResponse(context, response);
  }

  private async handleGeneralHelp(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User needs help with group/coin management. 
        
        You can help them:
        - View their groups/coins (with chain-specific filtering)
        - Create additional groups
        - Launch coins into existing groups  
        - Check fees earned
        
        Ask what they'd like to do and be helpful. Use your character's voice.
      `
    });

    await this.sendResponse(context, response);
  }

  /**
   * Handle "add everyone" command for management group creation
   */
  private async handleAddEveryoneForManagement(context: FlowContext, selectedChain: any): Promise<void> {
    this.log('Processing "add everyone" command for management', {
      userId: context.userState.userId,
      chain: selectedChain.displayName
    });

    try {
      // Get all participants from the XMTP conversation
      const members = await context.conversation.members();
      const feeReceivers = [];

      this.log(`Found ${members.length} total members in the conversation`);

      for (const member of members) {
        // Skip the sender and the bot
        if (member.inboxId !== context.senderInboxId && member.inboxId !== context.client.inboxId) {
          // Get the address for this member
          const memberInboxState = await context.client.preferences.inboxStateFromInboxIds([member.inboxId]);
          if (memberInboxState.length > 0 && memberInboxState[0].identifiers.length > 0) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            feeReceivers.push({
              username: memberAddress, // Use address as username for now
              resolvedAddress: memberAddress,
              percentage: undefined // Equal split
            });
            this.log(`Added fee receiver: ${memberAddress}`);
          }
        }
      }

      // Add the sender as well
      feeReceivers.push({
        username: context.creatorAddress,
        resolvedAddress: context.creatorAddress,
        percentage: undefined // Equal split
      });

      this.log(`Total fee receivers: ${feeReceivers.length}`);

      if (feeReceivers.length === 0) {
        await this.sendResponse(context, "couldn't find any group members to add. please specify fee receivers manually.");
        return;
      }

      // Create group deployment calls directly with the member addresses
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        feeReceivers,
        context.creatorAddress,
        selectedChain,
        "Create Group with All Members"
      );

      // Update management progress and set pending transaction
      await context.updateState({
        managementProgress: undefined, // Clear management progress
        pendingTransaction: {
          type: 'group_creation',
          network: getNetworkName(selectedChain),
          timestamp: new Date()
        }
      });

      // Send the wallet transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Let user know what's happening
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Perfect! I've added all ${feeReceivers.length} group chat members to your fee split group.
          
          Sign the transaction to create your group with equal fee splitting among all members! You can ask questions about it or say "cancel" if needed.
          
          Keep it concise and encouraging. Use your character's voice.
        `
      });

      await this.sendResponse(context, response);

    } catch (error) {
      this.logError('Failed to process "add everyone" command', error);
      await this.sendResponse(context, `failed to add everyone: ${error instanceof Error ? error.message : 'unknown error'}. please specify fee receivers manually.`);
    }
  }

  /**
   * Helper method to classify management actions using LLM
   */
  private async classifyManagementAction(messageText: string, context: FlowContext): Promise<ManagementAction> {
    const response = await context.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You are classifying user management requests. Return only one of these actions:
        
        - list_groups: user wants to see their groups, group data, group info, portfolio, or holdings
        - list_coins: user wants to see their coins, coin data, or launches
        - create_group: user wants to create a new group, additional group, or another group
        - add_coin: user wants to launch a coin, create a coin, or add a coin to a group
        - claim_fees: user wants to claim fees for their groups or coins
        - general_help: anything else, unclear requests, or general questions
        
        Consider chain-specific requests (e.g., "show my Base Sepolia groups") as the appropriate list action.
        
        Return ONLY the action name, nothing else.`
      }, {
        role: 'user',
        content: messageText
      }],
      temperature: 0.1,
      max_tokens: 20
    });

    const classification = response.choices[0]?.message?.content?.trim() as ManagementAction;
    
    // Validate classification
    const validActions: ManagementAction[] = ['list_groups', 'list_coins', 'add_coin', 'create_group', 'claim_fees', 'general_help'];
    return validActions.includes(classification) ? classification : 'general_help';
  }

  /**
   * Filter user items by chain preference
   */
  private filterByChain<T extends { chainName: string }>(
    items: T[], 
    messageText: string
  ): { filtered: T[], chainFilter: string, requestedChain: any } {
    const requestedChain = detectChainFromMessage(messageText || '');
    let filtered = items;
    let chainFilter = '';
    
    // If user specifically mentioned a chain, filter by that chain
    if (messageText && (
      messageText.toLowerCase().includes('sepolia') ||
      messageText.toLowerCase().includes('testnet') ||
      messageText.toLowerCase().includes('mainnet') ||
      messageText.toLowerCase().includes('base sepolia') ||
      messageText.toLowerCase().includes('base mainnet')
    )) {
      filtered = items.filter(item => item.chainName === requestedChain.name);
      chainFilter = ` on ${requestedChain.displayName}`;
    }
    
    return { filtered, chainFilter, requestedChain };
  }

  private async handleClaimFees(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User wants to claim fees from their groups or coins. Direct them to https://mini.flaunch.gg to manage their coins and claim fees.
        
        Explain that they can:
        - View all their coins and groups
        - Claim accumulated fees 
        - Manage their portfolio
        
        Be helpful and excited about their earnings. Use your character's voice.
      `
    });

    await this.sendResponse(context, response);
  }

  private async handleTransactionCancellation(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    this.log('Cancelling pending transaction', {
      userId: userState.userId,
      transactionType: userState.pendingTransaction?.type
    });

    // Clear the pending transaction and reset relevant progress
    const updates: Partial<typeof userState> = {
      pendingTransaction: undefined
    };

    // Reset progress based on transaction type
    if (userState.pendingTransaction?.type === 'group_creation') {
      // For group creation, clear management progress to start fresh
      updates.managementProgress = undefined;
    } else if (userState.pendingTransaction?.type === 'coin_creation') {
      // For coin creation, reset to collecting coin details
      if (userState.managementProgress) {
        updates.managementProgress = {
          ...userState.managementProgress,
          step: 'collecting_coin_details'
        };
      }
    }

    await context.updateState(updates);
  }
} 
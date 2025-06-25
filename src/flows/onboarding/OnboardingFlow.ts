import { ContentTypeRemoteAttachment } from "@xmtp/content-type-remote-attachment";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { 
  encodeAbiParameters, 
  encodeFunctionData,
  parseUnits, 
  zeroHash
} from "viem";
import { FlaunchZapAbi } from "../../../abi/FlaunchZap";
import { AddressFeeSplitManagerAddress, FlaunchZapAddress } from "../../../addresses";
import { getCharacterResponse } from "../../../utils/character";
import { numToHex } from "../../../utils/hex";
import { generateTokenUri } from "../../../utils/ipfs";
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { GroupCreationUtils } from "../utils/GroupCreationUtils";
import { createLaunchExtractionPrompt, LaunchExtractionResult } from "./launchExtractionTemplate";
import { detectChainFromMessage, getChainDescription, getNetworkName, DEFAULT_CHAIN, ChainConfig } from "../utils/ChainSelection";
import { ENSResolverService } from "../../services/ENSResolverService";

// Constants for token launch
const TOTAL_SUPPLY = 100n * 10n ** 27n; // 100 Billion tokens in wei

export class OnboardingFlow extends BaseFlow {
  constructor() {
    super('OnboardingFlow');
  }

  async processMessage(context: FlowContext): Promise<void> {
    const { userState } = context;
    let progress = userState.onboardingProgress;
    
    // If active user with no groups gets routed here, initialize onboarding progress
    if (userState.status === 'active' && userState.groups.length === 0 && !progress) {
      progress = {
        step: 'group_creation',
        startedAt: new Date()
      };
      
      // Update user state to onboarding
      await context.updateState({
        status: 'onboarding',
        onboardingProgress: progress
      });
      
      this.log('Initialized onboarding for active user with no groups', {
        userId: userState.userId,
        reason: 'group_creation_confirmation'
      });
    }
    
    // Log incoming message processing in onboarding flow
    this.log('📥 ONBOARDING MESSAGE RECEIVED', {
      userId: userState.userId,
      step: progress?.step || 'new_user',
      messageText: context.messageText || '[NO_TEXT]',
      hasAttachment: context.hasAttachment,
      userStatus: userState.status,
      timestamp: new Date().toISOString()
    });
    
    if (progress) {
      this.log(`Processing onboarding step: ${progress.step}`, { 
        userId: userState.userId,
        step: progress.step 
      });
    }

    // Start onboarding for completely new users
    if (userState.status === 'new') {
      // Check if the user's first message contains any relevant details - if so, skip welcome and go straight to processing
      const messageText = this.extractMessageText(context);
      const extraction = await this.extractLaunchDetails(context);
      
      if (extraction && extraction.feeReceivers && extraction.feeReceivers.confidence >= 0.5) {
        this.log('User provided group creation details in first message, processing group creation', {
          userId: userState.userId,
          extraction
        });
        
        // Initialize onboarding state for group creation
        await context.updateState({
          status: 'onboarding',
          onboardingProgress: {
            step: 'group_creation',
            startedAt: new Date()
          }
        });
        
        // Process the group creation with the extracted details
        await this.handleGroupCreation(context);
        return;
      } else if (extraction && extraction.tokenDetails && (extraction.tokenDetails.name || extraction.tokenDetails.ticker || extraction.tokenDetails.image)) {
        this.log('User provided coin details in first message, but need group first', {
          userId: userState.userId,
          extraction
        });
        
                 // Start with group creation but store coin details for later
         await context.updateState({
           status: 'onboarding',
           onboardingProgress: {
             step: 'group_creation',
             coinData: {
               name: extraction.tokenDetails.name || undefined,
               ticker: extraction.tokenDetails.ticker || undefined,
               image: extraction.tokenDetails.image || undefined
             },
             startedAt: new Date()
           }
         });
        
        // Ask for group creation first
        await this.handleGroupCreation(context);
        return;
      } else {
        // No relevant details detected, proceed with normal welcome flow
        await this.startOnboarding(context);
        return;
      }
    }

    // Handle the onboarding steps
    if (!progress) {
      this.logError('No onboarding progress found, starting fresh');
      await this.startOnboarding(context);
      return;
    }

    // PRIORITY: Check for pending transaction inquiries using LLM
    const messageText = this.extractMessageText(context);
    if (userState.pendingTransaction && messageText) {
      const transactionResponse = await this.handleTransactionInquiryWithLLM(context, messageText);
      if (transactionResponse) {
        await this.sendResponse(context, transactionResponse);
        return;
      }
    }

    // PRIORITY: Check for explicit group creation requests regardless of current step
    if (messageText && this.isExplicitGroupCreationRequest(messageText)) {
      this.log('Explicit group creation request detected, switching to group creation', {
        userId: userState.userId,
        currentStep: progress.step,
        messageText: messageText.substring(0, 100)
      });
      
      // Switch to group creation step
      await context.updateState({
        onboardingProgress: {
          ...progress,
          step: 'group_creation'
        }
      });
      
      await this.handleGroupCreation(context);
      return;
    }

    // If user has pending transaction, check if they want to modify it or create new one
    if (userState.pendingTransaction && messageText) {
      const modificationPrompt = `
        User has a pending group creation transaction and said: "${messageText}"
        
        Are they trying to:
        1. Modify/add to the existing transaction (add someone, change receivers)
        2. Create a completely new transaction (different group setup)
        3. Just asking about the existing transaction
        
        Return ONLY:
        "modify" - if they want to add/change receivers in current transaction
        "new" - if they want to create a completely different group
        "inquiry" - if they're just asking about current transaction
      `;

      const modificationResponse = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: modificationPrompt }],
        temperature: 0.1,
        max_tokens: 20
      });

      const userIntent = modificationResponse.choices[0]?.message?.content?.trim();
      
      if (userIntent === 'inquiry') {
        // Let the transaction inquiry handler deal with it
        const inquiryResponse = await this.handleTransactionInquiryWithLLM(context, messageText);
        if (inquiryResponse) {
          await this.sendResponse(context, inquiryResponse);
          return;
        }
      } else if (userIntent === 'modify') {
        // User wants to modify existing transaction - extract new receivers and combine
        this.log('User wants to modify existing transaction', {
          userId: userState.userId,
          messageText: messageText.substring(0, 100)
        });

        const existingReceivers = userState.onboardingProgress?.splitData?.receivers || [];
        const extraction = await this.extractLaunchDetails(context);
        
        if (extraction && extraction.feeReceivers && extraction.feeReceivers.receivers) {
          // Resolve new receivers
          const newReceivers = await GroupCreationUtils.resolveUsernames(
            context,
            extraction.feeReceivers.receivers.map(r => ({
              username: r.identifier === 'SELF_REFERENCE' ? context.creatorAddress : r.identifier,
              percentage: r.percentage || undefined
            }))
          );

          // Combine existing and new receivers, avoiding duplicates
          const combinedReceivers = [...existingReceivers];
          for (const newReceiver of newReceivers) {
            const exists = combinedReceivers.some(existing => 
              existing.resolvedAddress?.toLowerCase() === newReceiver.resolvedAddress?.toLowerCase()
            );
            if (!exists && newReceiver.resolvedAddress) {
              combinedReceivers.push(newReceiver);
            }
          }

          // Detect chain preference
          const selectedChain = detectChainFromMessage(messageText);

          // Create new transaction with combined receivers
          const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
            combinedReceivers,
            context.creatorAddress,
            selectedChain,
            "Create Group"
          );

          // Update state with combined receivers
          await context.updateState({
            onboardingProgress: {
              ...userState.onboardingProgress!,
              splitData: {
                receivers: combinedReceivers,
                equalSplit: !combinedReceivers.some(r => r.percentage),
                creatorPercent: 0
              }
            },
            pendingTransaction: {
              type: 'group_creation',
              network: getNetworkName(selectedChain),
              timestamp: new Date()
            }
          });

          // Send the wallet transaction
          await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

          const response = await getCharacterResponse({
            openai: context.openai,
            character: context.character,
            prompt: `
              Perfect! I've successfully updated your PENDING group creation transaction to include ${combinedReceivers.length} receivers (including the new one you added).
              
              This is still a pending transaction - the group hasn't been created yet. You can continue to modify it or sign it to create the group.
              
              Sign the transaction to create your group with the updated fee splitting! You can ask questions about it or say "cancel" if needed.
              
              Keep it concise and encouraging. Use your character's voice.
            `
          });

          await this.sendResponse(context, response);
          return;
        } else {
          // If extraction failed, ask for clarification
          const response = await getCharacterResponse({
            openai: context.openai,
            character: context.character,
            prompt: `
              I couldn't understand who you want to add to your group. Please specify:
              - Farcaster usernames (@alice)
              - ENS names (alice.eth)
              - Ethereum addresses (0x123...)
              - Or say "add everyone" to include all chat members
              
              Who would you like to add to your group?
              
              Keep it simple and helpful. Use your character's voice.
            `
          });

          await this.sendResponse(context, response);
          return;
        }
      }
      
      // If not modifying, clear the pending transaction since they're providing new input
      this.log('Clearing pending transaction due to new user input', {
        userId: userState.userId,
        currentNetwork: userState.pendingTransaction.network
      });
      
      await context.updateState({
        pendingTransaction: undefined
      });
    }

    switch (progress.step) {
      case 'group_creation':
        await this.handleGroupCreation(context);
        break;
      case 'coin_creation':
        await this.handleCoinCreation(context);
        break;
      case 'username_collection':
        await this.handleUsernameCollection(context);
        break;
      default:
        this.logError(`Unknown onboarding step: ${progress.step}`);
        await this.sendResponse(context, "something went wrong with your onboarding. let me restart it for you...");
        await this.startOnboarding(context);
    }
  }

  private async startOnboarding(context: FlowContext): Promise<void> {
    this.log('Starting onboarding for new user');
    
    // Update user to onboarding status with group creation step
    await context.updateState({ 
      status: 'onboarding',
      onboardingProgress: {
        step: 'group_creation',
        startedAt: new Date()
      }
    });

    // Determine conversation context
    let isGroupChat = false;
    let memberCount = 1;
    try {
      const members = await context.conversation.members();
      memberCount = members.length;
      isGroupChat = memberCount > 2; // More than just user and bot
    } catch (error) {
      this.log('Could not get conversation members, assuming 1:1 chat');
    }

    const conversationContext = isGroupChat 
      ? `You are in a group chat with ${memberCount} people.`
      : `You are in a 1:1 chat.`;
    
    const welcomeMessage = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        A new user just greeted you! Give them a proper introduction and welcome. Context: ${conversationContext}
        
        FIRST: Introduce yourself as Flaunchy
        - You're a cat who helps people create fair token launches
        - You build groups that split trading fees automatically
        - You make crypto launches more collaborative and less scammy
        
        THEN: Explain how it works with the two-step process:
        
        STEP 1: Create a Group
        - Groups let you split trading fees from any coins launched in that group
        - You can split fees with people in this chat, or anyone else (friends, collaborators, etc.)
        - You can even keep 100% for yourself if you want - the group can be fully owned by you
        ${isGroupChat ? '- You can say "add everyone" to include all chat members' : ''}
        
        STEP 2: Launch Coins into the Group  
        - Once your group is set up, you can launch unlimited coins into it
        - All coins in that group will split trading fees according to your group settings
        
        FINALLY: Ask who should receive the trading fees for this group:
        - Farcaster usernames (@alice)
        - ENS names (alice.eth)
        - Ethereum addresses (0x123...)
        - Percentages like "me 80%, @alice 20%" (or equal split)
        - Or just "me 100%" to keep everything
        
        Be welcoming and helpful. Use your character's voice. Don't be overly excited or cringe.
      `
    });
    
    await this.sendResponse(context, welcomeMessage);
  }

  private async handleGroupCreation(context: FlowContext): Promise<void> {
    const { userState } = context;
    const messageText = this.extractMessageText(context);

    this.log('Processing group creation', {
      userId: userState.userId,
      messageText: messageText?.substring(0, 100) + '...'
    });

    // Check if user is asking a question about fee receivers or groups
    if (messageText && this.isAskingAboutFeeReceivers(messageText)) {
      await this.handleFeeReceiverExplanation(context);
      return;
    }

    // Check for reset commands
    if (messageText && (
      messageText.toLowerCase().includes('start over') ||
      messageText.toLowerCase().includes('reset') ||
      messageText.toLowerCase().includes('clear') ||
      messageText.toLowerCase().includes('cancel')
    )) {
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          splitData: undefined
        }
      });

      await this.sendResponse(context, "okay, let's start fresh! who should receive the trading fees?");
      return;
    }

    // Check for "add everyone" command first with better pattern detection
    if (messageText) {
      const everyonePrompt = `
        User message: "${messageText}"
        
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

      const everyoneResponse = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: everyonePrompt }],
        temperature: 0.1,
        max_tokens: 10
      });

      const isAddEveryone = everyoneResponse.choices[0]?.message?.content?.trim() === 'yes';
      
      if (isAddEveryone) {
        this.log('Detected "add everyone" request via LLM', {
          userId: userState.userId,
          messageText: messageText.substring(0, 100)
        });
        await this.handleAddEveryone(context);
        return;
      }
    }



    // Detect chain preference from user message (this handles all chain detection naturally)
    const selectedChain = detectChainFromMessage(messageText || '');
    
    this.log('Chain detected for onboarding group creation', {
      userId: userState.userId,
      chainName: selectedChain.displayName,
      chainId: selectedChain.id
    });

    // Check if we have existing split data and the user is just switching chains
    const existingSplitData = userState.onboardingProgress?.splitData;
    const chainMentioned = messageText && (
      messageText.toLowerCase().includes('sepolia') ||
      messageText.toLowerCase().includes('mainnet') ||
      messageText.toLowerCase().includes('base')
    );
    
    // If user has existing split data and is just mentioning a chain, use existing data
    if (existingSplitData && existingSplitData.receivers && existingSplitData.receivers.length > 0 && chainMentioned) {
      this.log('User switching chains with existing fee receivers, preserving split data', {
        userId: userState.userId,
        existingReceivers: existingSplitData.receivers.length,
        newChain: selectedChain.displayName
      });

      try {
        // Create group transaction calls using existing split data
        const splitData = {
          receivers: existingSplitData.receivers,
          equalSplit: existingSplitData.equalSplit,
          creatorPercent: existingSplitData.creatorPercent || 0
        };

        const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
          existingSplitData.receivers,
          context.creatorAddress,
          selectedChain,
          "Create Group"
        );

        // Update onboarding progress and send transaction
        await context.updateState({
          onboardingProgress: {
            ...userState.onboardingProgress!,
            splitData: existingSplitData // Keep existing split data
          },
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
            Perfect! I've preserved your fee receivers and updated the network settings.
            
            Sign the transaction to create your group with the same fee splitting setup!
            
            Keep it concise and encouraging. Use your character's voice.
          `
        });

        await this.sendResponse(context, response);
        return;

      } catch (error) {
        this.logError('Failed to create group with existing split data', error);
        // Fall through to normal extraction if this fails
      }
    }

    // Extract coin details from the message for later use
    const extraction = await this.extractLaunchDetails(context);
    
    // Store any coin details found during group creation
    let updatedCoinData = userState.onboardingProgress?.coinData || { name: undefined, ticker: undefined, image: undefined };
    if (extraction && extraction.tokenDetails) {
      if (extraction.tokenDetails.name) updatedCoinData.name = extraction.tokenDetails.name;
      if (extraction.tokenDetails.ticker) updatedCoinData.ticker = extraction.tokenDetails.ticker;
      if (extraction.tokenDetails.image) updatedCoinData.image = extraction.tokenDetails.image;
      
      this.log('Coin details detected during group creation', {
        userId: userState.userId,
        coinData: updatedCoinData
      });
    }
    
    try {
      // Use shared utility for group creation with selected chain
      const result = await GroupCreationUtils.createGroupFromMessage(
        context, 
        selectedChain,
        "Create Group"
      );

      if (result) {
        this.log('Group creation successful, sending transaction', {
        userId: userState.userId,
          resolvedReceivers: result.resolvedReceivers,
          chain: result.chainConfig.displayName
        });

        // Update onboarding progress with both group data and coin data
          await context.updateState({
            onboardingProgress: {
              ...userState.onboardingProgress!,
            coinData: updatedCoinData,
            splitData: {
              receivers: result.resolvedReceivers,
              equalSplit: !result.resolvedReceivers.some(r => r.percentage),
              creatorPercent: 0 // Creator gets 0%, all fees go to specified recipients
            }
          },
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
            Perfect! Sign the transaction to create your group with the fee splitting you specified.
            
            You can ask me questions about the transaction or say "cancel" if you change your mind.
            
            Keep it concise and encouraging. Use your character's voice.
          `
        });

        await this.sendResponse(context, response);
      
    } else {
        // Ask for fee receivers if extraction failed
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
            User said "${messageText}" but I need to know who should receive the trading fees for your group.
            
            You can specify:
          - Farcaster usernames (@alice)
          - ENS names (alice.eth)
          - Ethereum addresses (0x123...)
            - Optional custom percentages like "@alice 30%, @bob 70%"
            - Or say "add everyone" to include all chat members
            
            Be friendly and ask who should receive the fees. Don't mention chains unless they specifically asked about networks.
            Use your character's voice and keep it simple.
        `
      });
      await this.sendResponse(context, response);
      }

    } catch (error) {
      this.logError('Failed to create group', error);
      await this.sendResponse(context, `failed to create group: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
    }
  }

  private async handleAddEveryone(context: FlowContext): Promise<void> {
    const { userState } = context;

    this.log('Processing "add everyone" command', {
      userId: userState.userId,
      conversation: context.conversation ? 'group_chat' : 'direct_message'
    });

    try {
      // Get all participants from the XMTP conversation
      // For now, use the creator and a mock member for testing
      // TODO: Replace with actual XMTP conversation member resolution
      const groupMembers = [
        { username: context.creatorAddress, resolvedAddress: context.creatorAddress, percentage: undefined },
        { username: '0x1234567890123456789012345678901234567890', resolvedAddress: '0x1234567890123456789012345678901234567890', percentage: undefined }
      ];

      if (groupMembers.length === 0) {
        await this.sendResponse(context, "couldn't find any group members to add. please specify fee receivers manually.");
        return;
      }

      // Create equal split data for all participants
      const splitData = {
        receivers: groupMembers,
        equalSplit: true,
        creatorPercent: 0 // Equal split among all members
      };

      this.log('Creating group with all members', {
        userId: userState.userId,
        memberCount: groupMembers.length,
        members: groupMembers.map(m => ({ username: m.username, address: m.resolvedAddress }))
      });

      // Detect chain preference (default to base)
      const selectedChain = detectChainFromMessage(context.messageText || '');

      // Create the group transaction immediately
      const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
        groupMembers,
        context.creatorAddress,
        selectedChain,
        "Create Group with All Members"
      );

      // Update onboarding progress and set pending transaction
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          splitData,
          coinData: userState.onboardingProgress?.coinData || { name: undefined, ticker: undefined, image: undefined }
        },
        pendingTransaction: {
          type: 'group_creation',
          network: getNetworkName(selectedChain),
          timestamp: new Date()
        }
      });

      // Send the wallet transaction
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Perfect! I've set up your group with equal fee splitting for all ${groupMembers.length} members.
          
          Sign the transaction to create your group! You can ask questions about it or say "cancel" if needed.
          
          Keep it concise and encouraging. Use your character's voice.
        `
      });

      await this.sendResponse(context, response);

    } catch (error) {
      this.logError('Failed to process "add everyone" command', error);
      await this.sendResponse(context, "couldn't get group members. please specify fee receivers manually.");
    }
  }

  private async handleCoinCreation(context: FlowContext): Promise<void> {
    const { userState, message } = context;
    let coinData = userState.onboardingProgress!.coinData!;
    const messageText = this.extractMessageText(context);

    // Log current state at the beginning
    this.log('Current coin creation state', {
      userId: userState.userId,
      step: userState.onboardingProgress!.step,
      currentCoinData: coinData,
      messageText: messageText
    });

    // Use LLM to detect if user wants to go back to group creation
    if (messageText) {
      const groupDetectionPrompt = `
        User is currently in coin creation step but sent this message: "${messageText}"
        
        Are they trying to:
        1. Create/modify a group or fee split setup
        2. Add everyone to a group
        3. Continue with coin creation
        
        Return ONLY:
        "group_creation" - if they want to create/modify group or fee receivers
        "add_everyone" - if they want to add all group members
        "coin_creation" - if they're providing coin details or continuing coin creation
      `;

      const detectionResponse = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: groupDetectionPrompt }],
        temperature: 0.1,
        max_tokens: 20
      });

      const userIntent = detectionResponse.choices[0]?.message?.content?.trim();
      
      if (userIntent === 'add_everyone') {
        this.log('User wants to add everyone during coin creation, redirecting to handleAddEveryone', {
          userId: userState.userId,
          messageText: messageText
        });
        await this.handleAddEveryone(context);
        return;
      } else if (userIntent === 'group_creation') {
        this.log('User wants group creation during coin creation, redirecting to group creation', {
          userId: userState.userId,
          messageText: messageText
        });

        // Redirect to group creation
        await context.updateState({
          onboardingProgress: {
            ...userState.onboardingProgress!,
            step: 'group_creation'
          }
        });

        await this.handleGroupCreation(context);
        return;
      }
    }

    // Check for reset commands
    if (messageText && (
      messageText.toLowerCase().includes('start over') ||
      messageText.toLowerCase().includes('reset') ||
      messageText.toLowerCase().includes('clear') ||
      messageText.toLowerCase().includes('cancel')
    )) {
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          coinData: { name: undefined, ticker: undefined, image: undefined }
        }
      });

      await this.sendResponse(context, "okay, let's start fresh! what's the name of your coin?");
      return;
    }

    // Check if user is switching chains
    const chainMentioned = messageText && (
      messageText.toLowerCase().includes('sepolia') ||
      messageText.toLowerCase().includes('mainnet') ||
      messageText.toLowerCase().includes('base') ||
      messageText.toLowerCase().includes('switch') ||
      messageText.toLowerCase().includes('change')
    );
    
    // If user is switching chains, check what they want to switch
    if (chainMentioned) {
      const selectedChain = detectChainFromMessage(messageText || '');
      
      // Check if they have existing group/split data and want to recreate group on new chain
      const splitData = userState.onboardingProgress!.splitData;
      if (splitData && splitData.receivers && splitData.receivers.length > 0) {
        this.log('User switching chains with existing group data, recreating group', {
          userId: userState.userId,
          existingSplitData: splitData,
          newChain: selectedChain.displayName,
          messageText: messageText
        });

                 try {
           // Validate that all receivers have resolved addresses
           const validReceivers = splitData.receivers.filter(r => r.resolvedAddress);
           if (validReceivers.length !== splitData.receivers.length) {
             this.logError('Some receivers missing resolved addresses', {
               totalReceivers: splitData.receivers.length,
               validReceivers: validReceivers.length,
               receivers: splitData.receivers
             });
             throw new Error('Some fee receivers are missing resolved addresses');
           }

           this.log('Creating group deployment calls for chain switch', {
             userId: userState.userId,
             receiversCount: validReceivers.length,
             chainId: selectedChain.id,
             chainName: selectedChain.name,
             chainDisplayName: selectedChain.displayName,
             chainHexId: selectedChain.hexId,
             fullChainConfig: selectedChain
           });

           // Recreate the group transaction on the new chain using existing split data
           const walletSendCalls = await GroupCreationUtils.createGroupDeploymentCalls(
             validReceivers,
             context.creatorAddress,
             selectedChain,
             "Create Group"
           );

          // Update onboarding progress and send transaction
          await context.updateState({
            onboardingProgress: {
              ...userState.onboardingProgress!,
              splitData: splitData // Keep existing split data
            },
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
              Perfect! I've switched to ${selectedChain.displayName} and preserved your fee receivers.
              
              Sign the transaction to create your group with the same fee splitting setup on the new chain!
              
              Keep it concise and encouraging. Use your character's voice.
            `
          });

          await this.sendResponse(context, response);
          return;

                 } catch (error) {
           this.logError('Failed to recreate group on new chain', error);
           
           // Don't fall through - provide specific error message for chain switching
           const response = await getCharacterResponse({
             openai: context.openai,
             character: context.character,
             prompt: `
               There was an error switching chains for the group creation.
               
               Error: ${error instanceof Error ? error.message : 'Unknown error'}
               
               Ask the user to try again or provide the fee receivers again.
               Use your character's voice and be helpful.
             `
           });
           
           await this.sendResponse(context, response);
           return;
         }
      }
      
             // If user has complete coin data and is switching chains for coin launch
       if (coinData.name && coinData.ticker && coinData.image) {
          this.log('User switching chains with existing coin data, preserving data', {
            userId: userState.userId,
            existingCoinData: coinData,
            messageText: messageText
          });

          try {
            // Use existing coin data and split data to launch on new chain
            const splitDataForCoin = userState.onboardingProgress!.splitData;
            if (splitDataForCoin && splitDataForCoin.receivers) {
              this.log('Launching coin with preserved data on new chain', {
                userId: userState.userId,
                coinData,
                splitData: splitDataForCoin,
                newChain: selectedChain.displayName
              });

              await this.launchCoin(context, coinData, splitDataForCoin, selectedChain);
              return;
            }
          } catch (error) {
            this.logError('Failed to launch coin with preserved data', error);
            // Fall through to normal extraction if this fails
          }
        }
      }

    // Try to extract ALL details from the current message (token details AND fee receivers)
    const extraction = await this.extractLaunchDetails(context);
    
    let responseGiven = false;
    
    if (extraction) {
      const { tokenDetails, feeReceivers } = extraction;
      
      // Handle token details if extracted
      if (tokenDetails && (tokenDetails.name || tokenDetails.ticker || tokenDetails.image)) {
        // Only update fields that were extracted (don't overwrite existing values with null)
        const updatedCoinData = {
          ...coinData,
          ...(tokenDetails.name && { name: tokenDetails.name }),
          ...(tokenDetails.ticker && { ticker: tokenDetails.ticker }),
          ...(tokenDetails.image && { image: tokenDetails.image })
        };

        // Check if anything was actually extracted
        const hasNewData = (tokenDetails.name && tokenDetails.name !== coinData.name) ||
                          (tokenDetails.ticker && tokenDetails.ticker !== coinData.ticker) ||
                          (tokenDetails.image && tokenDetails.image !== coinData.image);

        if (hasNewData) {
          await context.updateState({
            onboardingProgress: {
              ...userState.onboardingProgress!,
              coinData: updatedCoinData
            }
          });

          // Update our local reference
          coinData = updatedCoinData;

          // Log the updated state
          this.log('Token creation state updated', {
            userId: userState.userId,
            coinData: updatedCoinData,
            step: userState.onboardingProgress!.step
          });

          // Don't acknowledge partial extractions - only respond when we need more info

          // Check if we have all details now
          if (updatedCoinData.name && updatedCoinData.ticker && updatedCoinData.image) {
            // Check if fee receiver extraction also found fee receivers in the same message
            if (feeReceivers && feeReceivers.receivers && feeReceivers.confidence >= 0.5) {
              this.log('Found both coin details AND fee receivers in same message - launching directly', {
                userId: userState.userId,
                completedCoinData: updatedCoinData,
                feeReceivers
              });

              // Store both coin data and proceed directly to username processing
              await context.updateState({
                onboardingProgress: {
                  ...userState.onboardingProgress!,
                  step: 'username_collection',
                  coinData: updatedCoinData
                }
              });
              
              // Update the context with the new coin data before processing username collection
              const updatedContext = {
                ...context,
                userState: {
                  ...context.userState,
                  onboardingProgress: {
                    ...context.userState.onboardingProgress!,
                    step: 'username_collection' as const,
                    coinData: updatedCoinData
                  }
                }
              };
              
              // Process the username collection immediately with updated context (no extra messages)
              await this.handleUsernameCollection(updatedContext);
              return;
            } else {
              // Check if we already have a group created
              const hasExistingGroup = userState.onboardingProgress!.groupData?.managerAddress;
              
              if (hasExistingGroup) {
                this.log('All coin details complete and group exists - proceeding to launch', {
                  userId: userState.userId,
                  completedCoinData: updatedCoinData,
                  groupAddress: hasExistingGroup
                });

                // Launch the coin directly using the existing group
                await this.launchCoin(context, updatedCoinData, {
                  managerAddress: hasExistingGroup,
                  equalSplit: false, // Group was already configured
                  creatorPercent: 0
                });
                return;
              } else {
                // Move to username collection step normally
                await context.updateState({
                  onboardingProgress: {
                    ...userState.onboardingProgress!,
                    step: 'username_collection',
                    coinData: updatedCoinData
                  }
                });

                this.log('Moving to username collection - all coin details complete', {
                  userId: userState.userId,
                  completedCoinData: updatedCoinData
                });

                const response = await getCharacterResponse({
                  openai: context.openai,
                  character: context.character,
                  prompt: `
                    Perfect! Got all coin details: ${updatedCoinData.name} (${updatedCoinData.ticker}) with image.
                    
                    Now ask for fee receiver addresses for trading fee splits. Explain they can provide:
                    - Farcaster usernames (@alice)
                    - ENS names (alice.eth)  
                    - Ethereum addresses (0x123...)
                    - Optional custom percentages like "@alice 30%, @bob 70%"
                    - Otherwise equal split among all receivers
                    
                    Be excited about the launch and use your style!
                  `
                });

                await this.sendResponse(context, response);
                return;
              }
            }
          }
        }
      }
    }

    // Only respond if we need more information - check what's missing
    if (messageText && !responseGiven && (!coinData.name || !coinData.ticker || !coinData.image)) {
      this.log('Need more information - responding to request missing details', {
        userId: userState.userId,
        missing: {
          name: !coinData.name,
          ticker: !coinData.ticker,
          image: !coinData.image
        }
      });

      // Only ask for missing details using the updated coinData
      await this.askForMissingDetails(context, coinData);
      responseGiven = true;
    }

    // Handle image attachment if present
    const isAttachment = message.contentType?.sameAs(ContentTypeRemoteAttachment);
    if (isAttachment && context.hasAttachment && !coinData.image) {
      try {
        this.log('Processing image attachment');
        
        await this.sendResponse(context, "got your image! processing it now...");
        
        // Process the image attachment
        const imageUrl = await context.processImageAttachment(context.attachment);
        
        const updatedCoinData = { ...coinData, image: imageUrl };
        
        await context.updateState({
          onboardingProgress: {
            ...userState.onboardingProgress!,
            coinData: updatedCoinData
          }
        });

        // Update our local reference
        coinData = updatedCoinData;
        
        // Check if we have all details now
        if (updatedCoinData.name && updatedCoinData.ticker && updatedCoinData.image) {
          // Check if we already have a group created
          const hasExistingGroup = userState.onboardingProgress!.groupData?.managerAddress;
          
          if (hasExistingGroup) {
            this.log('All coin details complete via image and group exists - proceeding to launch', {
              userId: userState.userId,
              completedCoinData: updatedCoinData,
              groupAddress: hasExistingGroup
            });

            // Launch the coin directly using the existing group
            await this.launchCoin(context, updatedCoinData, {
              managerAddress: hasExistingGroup,
              equalSplit: false, // Group was already configured
              creatorPercent: 0
            });
            return;
          } else {
            // Move to username collection step
            await context.updateState({
              onboardingProgress: {
                ...userState.onboardingProgress!,
                step: 'username_collection',
                coinData: updatedCoinData
              }
            });

            const response = await getCharacterResponse({
              openai: context.openai,
              character: context.character,
              prompt: `
                Great! Now you have all coin info for ${updatedCoinData.name} (${updatedCoinData.ticker}).
                Moving to step 2. Ask for usernames/addresses for fee splitting.
                Explain they can provide:
                - Farcaster usernames (@alice)
                - ENS names (alice.eth)
                - Ethereum addresses (0x123...)
                - Optional custom percentages like "@alice 30%, @bob 70%"
                - Otherwise equal split
                
                Keep it clear and friendly.
              `
            });

            await this.sendResponse(context, response);
            return;
          }
        }
        
      } catch (error) {
        this.logError('Failed to process image attachment', error);
        await this.sendResponse(context, "couldn't process your image. please try sending it again or provide an image URL.");
        return;
      }
    }

    // Ask for missing details using the updated coinData (only if no response was given yet)
    if (!responseGiven) {
      await this.askForMissingDetails(context, coinData);
    }
  }

  private async extractLaunchDetails(context: FlowContext): Promise<LaunchExtractionResult | null> {
    const messageText = this.extractMessageText(context);
    if (!messageText) return null;

    try {
      // Check if user sent an attachment
      const isAttachment = context.message.contentType?.sameAs(ContentTypeRemoteAttachment);
      
      // Build context from conversation history
      let conversationContext = '';
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        const historyTexts = context.conversationHistory
          .filter(msg => typeof msg.content === 'string')
          .map(msg => msg.content as string)
          .slice(-3); // Last 3 messages for context
        
        if (historyTexts.length > 0) {
          conversationContext = `\n\nRecent conversation context:\n${historyTexts.join('\n---\n')}`;
          this.log('Using conversation history for extraction', {
            historyCount: historyTexts.length,
            context: conversationContext.substring(0, 200) + '...'
          });
        }
      }
      
      const extractionPrompt = createLaunchExtractionPrompt({
        message: messageText + conversationContext,
        hasAttachment: isAttachment && context.hasAttachment,
        attachmentType: isAttachment ? 'image' : undefined,
        imageUrl: context.hasAttachment ? 'attachment_provided' : undefined
      });

      this.log('Extracting launch details with context', { 
        messageText: messageText.substring(0, 100) + '...',
        hasContext: !!conversationContext
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

      // Parse JSON response with error handling
      let result: LaunchExtractionResult;
      try {
        // Try to extract JSON from the response (in case there's extra text)
        let jsonContent = content;
        
        // Look for JSON object in the response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonContent = jsonMatch[0];
        }
        
        result = JSON.parse(jsonContent) as LaunchExtractionResult;
      } catch (parseError) {
        this.logError('Failed to parse JSON from LLM response', { content, parseError });
        
        // Return minimal result to avoid breaking the flow
        result = {
          tokenDetails: { name: null, ticker: null, image: null },
          feeReceivers: { receivers: null, splitType: null, confidence: 0 }
        };
      }
      
      this.log('🔍 LAUNCH EXTRACTION RESULT', {
        messageText: messageText.substring(0, 100) + (messageText.length > 100 ? '...' : ''),
        tokenDetails: result.tokenDetails,
        feeReceivers: result.feeReceivers,
        extractionSuccess: !!(result.tokenDetails || result.feeReceivers),
        timestamp: new Date().toISOString()
      });
      
      return result;

    } catch (error) {
      this.logError('Failed to extract launch details', error);
      return null;
    }
  }

  private async askForMissingDetails(context: FlowContext, coinData: any): Promise<void> {
    const { name, ticker, image } = coinData;

    if (!name) {
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `Ask the user for their coin name. Be brief and use your character style.`
      });
      await this.sendResponse(context, response);
    } else if (!ticker) {
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `User named their coin "${name}". Ask for ticker symbol. Keep it brief.`
      });
      await this.sendResponse(context, response);
    } else if (!image) {
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `User has "${name}" (${ticker}). Ask for image. Keep it brief.`
      });
      await this.sendResponse(context, response);
    }
  }

  private async handleUsernameCollection(context: FlowContext): Promise<void> {
    const { userState } = context;
    const coinData = userState.onboardingProgress!.coinData!;
    const messageText = this.extractMessageText(context);

    if (!messageText) {
      await this.sendResponse(context, "please provide the usernames or addresses for your group members.");
      return;
    }

    this.log('Processing username input', { 
      input: messageText,
      userId: userState.userId,
      creatorAddress: context.creatorAddress 
    });

    // Extract username/address details using combined LLM extraction
    const extraction = await this.extractLaunchDetails(context);
    const extractionResult = extraction?.feeReceivers;
    
    this.log('Username extraction result', {
      extractionResult,
      creatorAddress: context.creatorAddress
    });
    
    if (!extractionResult || extractionResult.confidence < 0.5) {
      await this.sendResponse(context, "please provide usernames/addresses separated by commas or specify percentages");
      return;
    }

    // Convert extraction result to our format
    const receivers = extractionResult.receivers!.map(r => ({
      username: r.identifier === 'SELF_REFERENCE' ? context.creatorAddress : r.identifier,
      percentage: r.percentage || undefined
    }));

    // Skip acknowledgment - go straight to launch

    // Resolve usernames to addresses
    try {
      this.log('Resolving usernames to addresses');
      
      const resolvedReceivers = await this.resolveUsernames(context, receivers);
      
      // Check if any failed to resolve
      const failed = resolvedReceivers.filter(r => !r.resolvedAddress);
      if (failed.length > 0) {
        const failedNames = failed.map(r => r.username).join(', ');
        await this.sendResponse(context, `couldn't resolve these usernames: ${failedNames}. please check and try again.`);
        return;
      }

      this.log('All addresses resolved successfully');

      // Update split data with resolved addresses
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          splitData: {
            receivers: resolvedReceivers,
            equalSplit: extractionResult.splitType === 'equal',
            creatorPercent: extractionResult.splitType === 'self_only' ? 100 : undefined
          }
        }
      });

      // Show resolved addresses and launch coin
      await this.launchCoin(context, coinData, {
        receivers: resolvedReceivers,
        equalSplit: extractionResult.splitType === 'equal',
        creatorPercent: extractionResult.splitType === 'self_only' ? 100 : undefined
      });

    } catch (error) {
      this.logError('Failed to resolve usernames or launch coin', error);
      await this.sendResponse(context, `something went wrong: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
    }
  }

  // Username extraction is now handled by extractLaunchDetails method

  private async resolveUsernames(context: FlowContext, receivers: Array<{ username: string; percentage?: number }>): Promise<Array<{
    username: string;
    percentage?: number;
    resolvedAddress?: string;
  }>> {
    return GroupCreationUtils.resolveUsernames(context, receivers);
  }

  private async launchCoin(context: FlowContext, coinData: any, splitData: any, chainConfig?: ChainConfig): Promise<void> {
    const { userState } = context;

    // Use detected chain or default to Base Mainnet
    const selectedChain = chainConfig || detectChainFromMessage(context.messageText || '');

    this.log('Preparing coin launch transaction', {
      userId: userState.userId,
      coinData,
      splitData,
      chain: selectedChain.displayName
    });

    try {
      // Create the transaction calls for the user's wallet (no messages, just transaction)
      const walletSendCalls = await this.createLaunchTransactionCalls(coinData, splitData, context.creatorAddress, context, selectedChain);

      // Set pending transaction state before sending wallet call
      await context.updateState({
        pendingTransaction: {
          type: 'coin_creation', // This is a coin launch, not group creation
          coinData: {
            name: coinData.name,
            ticker: coinData.ticker,
            image: coinData.image
          },
          network: getNetworkName(selectedChain),
          timestamp: new Date()
        }
      });

      // Send ONLY the wallet transaction prompt - no text messages
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Complete the onboarding (user state update)
      await this.completeOnboarding(context, splitData);

    } catch (error) {
      this.logError('Failed to prepare launch transaction', error);
      await this.sendResponse(context, `failed to prepare your launch transaction: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
    }
  }

  private async createLaunchTransactionCalls(coinData: any, splitData: any, creatorAddress: string, context: FlowContext, chainConfig: ChainConfig): Promise<any> {
    const chain = chainConfig.viemChain;
    
    // Log the received coin data for debugging
    this.log('🚀 CREATING LAUNCH TRANSACTION - Received coin data', {
      coinData,
      hasName: !!coinData.name,
      hasTicker: !!coinData.ticker,
      hasImage: !!coinData.image,
      imageType: typeof coinData.image
    });

    // Environment variables for IPFS
    const pinataJWT = process.env.PINATA_JWT;
    if (!pinataJWT) {
      throw new Error('Missing required environment variable: PINATA_JWT');
    }

    try {
      // Convert image URL to base64 if it's a URL
      let base64Image = coinData.image || '';
      if (coinData.image && typeof coinData.image === 'string' && coinData.image.startsWith('http')) {
        try {
          this.log('Converting image URL to base64');
          const response = await fetch(coinData.image);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const mimeType = response.headers.get('content-type') || 'image/png';
          base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`;
          this.log('Image converted to base64 successfully');
        } catch (error) {
          this.logError('Failed to convert image URL to base64', error);
          throw new Error(`Failed to process image: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }

      // Generate token URI with IPFS upload
      let tokenUri = '';
      if (base64Image) {
        this.log('Generating token URI with image');
        tokenUri = await generateTokenUri(coinData.name, {
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
      const premineAmount = 0n; // 1000 tokens premine for immediate launch

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

      // Check if we're using an existing group or creating a new one
      const isExistingGroup = splitData.managerAddress && !splitData.receivers;
      let recipientShares: Array<{ recipient: `0x${string}`; share: bigint }> = [];
      let initializeData = '0x' as `0x${string}`;
      let totalReceivers = 0;
      const creatorShare = 0n; // Creator gets 0% share (all goes to recipients)
      
      if (!isExistingGroup) {
        // Deduplicate receivers first - combine shares for duplicate addresses
        const addressShareMap = new Map<string, bigint>();
        const TOTAL_SHARE = 10000000n; // 100% in the format expected by the contract (100.00000)
        let totalAllocated = 0n;
        const uniqueAddresses = Array.from(new Set(splitData.receivers.map((r: any) => r.resolvedAddress.toLowerCase())));
        
        this.log('Launch receivers before deduplication', {
          receivers: splitData.receivers.map((r: any) => ({
            username: r.username,
            resolvedAddress: r.resolvedAddress,
            percentage: r.percentage
          }))
        });

        // Build address share map by combining duplicate addresses (case-insensitive)
        for (let i = 0; i < splitData.receivers.length; i++) {
          const receiver = splitData.receivers[i];
          const address = (receiver.resolvedAddress as string).toLowerCase();
          
          let share: bigint;
          if (receiver.percentage) {
            // Use explicit percentage
            share = BigInt(Math.floor(receiver.percentage * 100000));
          } else {
            // Equal split calculation
            const baseShare = TOTAL_SHARE / BigInt(uniqueAddresses.length);
            const isLastReceiver = i === splitData.receivers.length - 1;
            
            if (isLastReceiver) {
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

        totalReceivers = addressShareMap.size;

        this.log('Launch receivers after deduplication', {
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

        this.log('✅ Total shares validation passed:', calculatedTotal.toString());

        // Calculate recipient shares using deduplicated data
        recipientShares = Array.from(addressShareMap.entries()).map(([address, share]) => ({
          recipient: address as `0x${string}`,
          share: share
        }));

        // Encode initialization data using the correct structure
        initializeData = encodeAbiParameters(
          [
            { name: 'creatorShare', type: 'uint256' },
            {
              name: 'recipientShares',
              type: 'tuple[]',
              components: [
                { name: 'recipient', type: 'address' },
                { name: 'share', type: 'uint256' },
              ],
            },
          ],
          [creatorShare, recipientShares]
        );
      } else {
        this.log('Using existing group - no need to calculate recipient shares', {
          managerAddress: splitData.managerAddress
        });
        // For existing groups, we don't display individual receivers since they're already configured
        totalReceivers = 1; // Just for display purposes
      }

      // Prepare flaunch parameters
      const flaunchParams = {
        name: coinData.name,
        symbol: coinData.ticker,
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

      // Treasury manager parameters - use the deployed manager address
      // For the new flow, the manager is already deployed during group creation
      // and initializeData/depositData are empty since the manager is pre-configured
      const treasuryManagerParams = {
        manager: splitData.managerAddress || AddressFeeSplitManagerAddress[chain.id], // Use deployed manager or fallback
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
        name: coinData.name,
        symbol: coinData.ticker,
        creatorShare: creatorShare.toString(),
        totalReceivers,
        recipientShares: recipientShares.map(r => ({
          recipient: r.recipient,
          share: r.share.toString()
        })),
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

      // Format fee receivers for display
      let feeReceiverDisplays = [];
      let description = '';
      
      if (isExistingGroup) {
        // For existing groups, show the group address
        const groupAddress = splitData.managerAddress;
        description = `Launch $${coinData.ticker} into existing Group (${groupAddress.slice(0, 6)}...${groupAddress.slice(-4)})`;
      } else {
        // For new groups, show individual receivers
        feeReceiverDisplays = recipientShares.map(r => {
          // Try to find original username if available (case-insensitive comparison)
          const originalReceiver = splitData.receivers.find((receiver: any) => 
            (receiver.resolvedAddress as string)?.toLowerCase() === r.recipient.toLowerCase()
          );
          
          if (originalReceiver && originalReceiver.username.startsWith('@')) {
            return originalReceiver.username;
          } else {
            return `${r.recipient.slice(0, 6)}...${r.recipient.slice(-4)}`;
          }
        });
        description = `Launch $${coinData.ticker} with ${recipientShares.length} fee receivers: ${feeReceiverDisplays.join(', ')}`;
      }

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
              description,
            },
          },
        ],
      };

      this.log('Created wallet send calls', {
        walletSendCalls: JSON.stringify(walletSendCalls, null, 2),
      });

      return walletSendCalls;

    } catch (error) {
      this.logError('Failed to create launch transaction', error);
      throw error;
    }
  }

  private async completeOnboarding(context: FlowContext, splitData: any): Promise<void> {
    const { userState } = context;

    // Update user state to completed
    await context.updateState({
      status: 'active',
      onboardingProgress: undefined
    });

    // No success message - just log completion
    const isExistingGroup = splitData.managerAddress && !splitData.receivers;
    this.log('Onboarding completed successfully - transaction sent', {
      userId: userState.userId,
      tokenName: userState.onboardingProgress!.coinData!.name,
      tokenTicker: userState.onboardingProgress!.coinData!.ticker,
      feeReceivers: isExistingGroup ? 'existing group' : splitData.receivers.length + 1
    });
  }

  private isAskingAboutFeeReceivers(messageText: string): boolean {
    const lowerMessage = messageText.toLowerCase();
    
    // Questions about fee receivers, groups, or basic concepts
    const feeReceiverQuestions = [
      'who are the fee receivers',
      'what are fee receivers',
      'who should receive',
      'what is a fee receiver',
      'how do fee receivers work',
      'what does fee receiver mean',
      'who gets the fees',
      'how does fee splitting work',
      'what are fees',
      'what fees',
      'how does this work',
      'can you explain',
      'i don\'t understand',
      'what does this mean'
    ];
    
    return feeReceiverQuestions.some(question => lowerMessage.includes(question));
  }

  private async handleFeeReceiverExplanation(context: FlowContext): Promise<void> {
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User is asking about fee receivers during onboarding. Explain what fee receivers are in simple terms:
        
        - Fee receivers are the people who get paid when your coins are traded
        - Every time someone buys or sells coins in your group, trading fees are generated
        - These fees are automatically split among the fee receivers you specify
        - You can specify friends, collaborators, or yourself - whoever should benefit from the trading activity
        - You can set custom percentages or equal splits
        
        Examples of who you can add:
        - Farcaster usernames like @alice
        - ENS names like alice.eth  
        - Ethereum addresses like 0x123...
        - Say "add everyone" to include all group chat members
        - Custom splits like "@alice 30%, @bob 70%"
        
        After explaining, ask them who they want as their fee receivers.
        Be helpful and encouraging. Use your character's voice.
      `
    });

    await this.sendResponse(context, response);
  }

  private isExplicitGroupCreationRequest(messageText: string): boolean {
    const lowerMessage = messageText.toLowerCase();
    
    // Explicit group creation phrases
    const groupCreationPhrases = [
      'create a group',
      'create group',
      'start a group',
      'start group',
      'make a group',
      'make group',
      'set up a group',
      'set up group',
      'launch a group',
      'launch group',
      'new group',
      'another group',
      'additional group',
      'group for',
      'group with',
      'i want to create a group',
      'i want to start a group',
      'i want to make a group',
      'i want a group',
      'let\'s create a group',
      'let\'s start a group',
      'let\'s make a group',
      'can you create a group',
      'can you start a group',
      'help me create a group',
      'help me start a group'
    ];
    
    // Check if message contains explicit group creation phrases
    const hasGroupCreationPhrase = groupCreationPhrases.some(phrase => lowerMessage.includes(phrase));
    
    // Additional check: contains "group" and creation verbs but NOT coin-specific words
    const hasGroup = lowerMessage.includes('group');
    const hasCreationVerb = ['create', 'start', 'make', 'launch', 'set up', 'new'].some(verb => lowerMessage.includes(verb));
    const hasCoinWords = ['coin', 'token', 'ticker', 'symbol'].some(word => lowerMessage.includes(word));
    
    return hasGroupCreationPhrase || (hasGroup && hasCreationVerb && !hasCoinWords);
  }

  private async handleTransactionInquiryWithLLM(context: FlowContext, messageText: string): Promise<string | null> {
    const { userState, openai, character } = context;
    
    if (!userState.pendingTransaction) {
      return null;
    }

    // Get transaction context
    let transactionContext = '';
    if (userState.pendingTransaction.type === 'group_creation') {
      const progress = userState.onboardingProgress;
      if (progress?.splitData?.receivers && progress.splitData.receivers.length > 0) {
        const receiverList = progress.splitData.receivers
          .map((r: any) => {
            // Use resolved address for display if username is an address
            const displayName = r.username.startsWith('0x') && r.username.length === 42 
              ? `${r.username.slice(0, 6)}...${r.username.slice(-4)}`
              : r.username;
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
- Use the character's voice (casual, encouraging)
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
        return 'transaction cancelled! you can start fresh whenever you\'re ready.';
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
      // For group creation, reset to the step before transaction creation
      if (userState.onboardingProgress) {
        updates.onboardingProgress = {
          ...userState.onboardingProgress,
          // Keep the progress but clear any transaction-related data
          groupData: undefined
        };
      }
    } else if (userState.pendingTransaction?.type === 'coin_creation') {
      // For coin creation, reset to coin creation step
      if (userState.onboardingProgress) {
        updates.onboardingProgress = {
          ...userState.onboardingProgress,
          step: 'coin_creation'
        };
      }
    }

    await context.updateState(updates);
  }
} 
import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
import { ContentTypeRemoteAttachment } from "@xmtp/content-type-remote-attachment";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { NETWORK_CONFIG } from "../../config/networks";
import { createLaunchExtractionPrompt, LaunchExtractionResult } from "./launchExtractionTemplate";
import { 
  encodeFunctionData, 
  encodeAbiParameters, 
  parseUnits, 
  zeroAddress, 
  zeroHash,
  type Address
} from "viem";
import { baseSepolia } from "viem/chains";
import { FlaunchZapAddress, AddressFeeSplitManagerAddress, TreasuryManagerFactoryAddress } from "../../../addresses";
import { FlaunchZapAbi } from "../../../abi/FlaunchZap";
import { TreasuryManagerFactoryAbi } from "../../../abi/TreasuryManagerFactory";
import { generateTokenUri } from "../../../utils/ipfs";
import { numToHex } from "../../../utils/hex";
import { createAddressFeeSplitManager } from "../../utils/groupCreation";

// Constants for token launch
const TOTAL_SUPPLY = 100n * 10n ** 27n; // 100 Billion tokens in wei
const chain = baseSepolia; // Force Base Sepolia for onboarding flow

// Using LaunchExtractionResult from launchExtractionTemplate.ts

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
        Welcome a new user and explain how Groups and Coins work. Context: ${conversationContext}
        
        Explain the two-step process:
        
        STEP 1: Create a Group
        - Groups let you split trading fees from any coins launched in that group
        - You can split fees with people in this chat, or anyone else (friends, collaborators, etc.)
        - You can even keep 100% for yourself if you want - the group can be fully owned by you
        ${isGroupChat ? '- You can say "add everyone" to include all chat members' : ''}
        
        STEP 2: Launch Coins into the Group  
        - Once your group is set up, you can launch unlimited coins into it
        - All coins in that group will split trading fees according to your group settings
        
        Ask who should receive the trading fees for this group:
        - Farcaster usernames (@alice)
        - ENS names (alice.eth)
        - Ethereum addresses (0x123...)
        - Percentages like "me 80%, @alice 20%" (or equal split)
        - Or just "me 100%" to keep everything
        
        Be helpful and use your character's voice. Don't be overly excited or cringe.
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

    // Check for "add everyone" command first
    if (messageText && messageText.toLowerCase().includes('add everyone')) {
      await this.handleAddEveryone(context);
      return;
    }

    // Extract fee receivers AND coin details from the message
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
    
    if (extraction && extraction.feeReceivers && extraction.feeReceivers.confidence >= 0.5 && extraction.feeReceivers.receivers) {
      const { feeReceivers } = extraction;
      
      this.log('Fee receivers extracted', {
        userId: userState.userId,
        receivers: feeReceivers.receivers,
        confidence: feeReceivers.confidence
      });

      // Create the AddressFeeSplitManager deployment transaction
      const receivers = feeReceivers.receivers!;
      const splitData = {
        receivers: receivers.map(r => ({
          username: r.identifier,
          resolvedAddress: r.identifier === 'SELF_REFERENCE' ? context.creatorAddress : r.identifier,
          percentage: r.percentage || 0
        })),
        equalSplit: !receivers.some(r => r.percentage),
        creatorPercent: 0 // Creator gets 0%, all fees go to specified recipients
      };

      // Update onboarding progress with coin data if found
      if (extraction.tokenDetails && (extraction.tokenDetails.name || extraction.tokenDetails.ticker || extraction.tokenDetails.image)) {
        await context.updateState({
          onboardingProgress: {
            ...userState.onboardingProgress!,
            coinData: updatedCoinData
          }
        });
      }

      // Create group creation transaction
      await this.createGroupCreationTransaction(context, splitData);
      
    } else {
      // Ask for fee receivers with better explanation
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          User didn't provide clear fee receiver information. Remind them about the group concept and ask for clarification.
          
          Explain:
          - Groups let you split trading fees from coins launched in that group
          - They can split with anyone (chat members, friends, collaborators, etc.)
          - Or keep 100% for themselves if they want
          
          Ask them to specify who should receive trading fees:
          - Farcaster usernames (@alice)
          - ENS names (alice.eth)
          - Ethereum addresses (0x123...)
          - Percentages like "me 80%, @alice 20%" (or equal split)
          - Or just "me 100%" to keep everything
          
          Be helpful and use your style.
        `
      });

      await this.sendResponse(context, response);
    }
  }

  private async handleAddEveryone(context: FlowContext): Promise<void> {
    const { userState } = context;

    this.log('Processing "add everyone" command', {
      userId: userState.userId,
      conversation: context.conversation ? 'group_chat' : 'direct_message'
    });

    try {
      // TODO: Get all participants from the XMTP conversation
      // For now, create a mock implementation
      const allParticipants = [
        // Mock participants - replace with actual XMTP conversation member extraction
        { username: 'member1', resolvedAddress: '0x1234567890123456789012345678901234567890' },
        { username: 'member2', resolvedAddress: '0x2345678901234567890123456789012345678901' },
        { username: 'member3', resolvedAddress: '0x3456789012345678901234567890123456789012' }
      ];

      // Create equal split data for all participants
      const splitData = {
        receivers: allParticipants,
        equalSplit: true,
        creatorPercent: 0 // Equal split among all members
      };

      // Move to coin creation step
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          step: 'coin_creation',
          splitData,
          coinData: { name: undefined, ticker: undefined, image: undefined }
        }
      });

      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          User said "add everyone" to include all group chat members in the fee split.
          Confirm that all ${allParticipants.length} group members will receive equal trading fee splits.
          Now ask for coin details: name, ticker, and image.
          Be excited about including everyone and use your style!
        `
      });

      await this.sendResponse(context, response);

    } catch (error) {
      this.logError('Failed to process "add everyone" command', error);
      await this.sendResponse(context, "couldn't get group members. please specify fee receivers manually.");
    }
  }

  private async createGroupCreationTransaction(context: FlowContext, splitData: any): Promise<void> {
    const { userState } = context;

    this.log('Creating group creation transaction', {
      userId: userState.userId,
      splitData
    });

    try {
      // Create the wallet transaction for AddressFeeSplitManager deployment
      const walletSendCalls = await this.createGroupDeploymentCalls(splitData, context.creatorAddress);

      // Store split data and set pending transaction state
      await context.updateState({
        onboardingProgress: {
          ...userState.onboardingProgress!,
          splitData
        },
        pendingTransaction: {
          type: 'group_creation',
          network: process.env.XMTP_ENV === 'production' ? 'base' : 'base-sepolia',
          timestamp: new Date()
        }
      });

      // Send the wallet transaction for user to sign
      await context.conversation.send(walletSendCalls, ContentTypeWalletSendCalls);

      // Let user know what's happening
      const response = await getCharacterResponse({
        openai: context.openai,
        character: context.character,
        prompt: `
          Perfect! Sign the transaction to start your group!
          
          This will set up the fee splitting you specified. Then we can launch coins!
          
          Keep it concise and encouraging. Use your character's voice.
        `
      });

      await this.sendResponse(context, response);

    } catch (error) {
      this.logError('Failed to create group creation transaction', error);
      await this.sendResponse(context, `failed to prepare group creation: ${error instanceof Error ? error.message : 'unknown error'}. please try again.`);
    }
  }

  private async createGroupDeploymentCalls(splitData: any, creatorAddress: string): Promise<any> {
    this.log('Creating group deployment transaction calls', {
      splitData,
      creatorAddress
    });

    // Deduplicate receivers first - combine shares for duplicate addresses
    const addressShareMap = new Map<Address, bigint>();
    const totalReceiverPercent = 100; // All 100% goes to recipients
    
    this.log('Receivers before deduplication', {
      receivers: splitData.receivers.map((r: any) => ({
        username: r.username,
        resolvedAddress: r.resolvedAddress,
        percentage: r.percentage
      }))
    });

    // Build address share map by combining duplicate addresses (case-insensitive)
    for (const receiver of splitData.receivers) {
      const address = (receiver.resolvedAddress as string).toLowerCase() as Address;
      const sharePercent = receiver.percentage || (totalReceiverPercent / splitData.receivers.length);
      const share = BigInt(Math.floor(sharePercent * 100000)); // Convert to basis points (100000 = 100%)
      
      const currentShare = addressShareMap.get(address) || 0n;
      addressShareMap.set(address, currentShare + share);
    }

    this.log('Receivers after deduplication', {
      uniqueReceivers: Array.from(addressShareMap.entries()).map(([addr, share]) => ({
        address: addr,
        share: share.toString(),
        percentage: (Number(share) / 100000).toFixed(2) + '%'
      }))
    });

    // Calculate recipient shares using deduplicated data
    const recipientShares = Array.from(addressShareMap.entries()).map(([address, share]) => ({
      recipient: address,
      share: share
    }));

    // Create the InitializeParams structure
    const initializeParamsStruct = {
      creatorShare: BigInt(0), // Creator always gets 0%
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

    // Use actual contract addresses
    const treasuryManagerFactory = TreasuryManagerFactoryAddress[baseSepolia.id];
    const addressFeeSplitManagerImplementation = AddressFeeSplitManagerAddress[baseSepolia.id];
    const flaunchyOwner = creatorAddress as Address; // Use creator as owner

    // Create user-friendly description using deduplicated addresses
    const receiverList = Array.from(addressShareMap.keys()).map((address) => {
      // Find the original receiver data for display name (case-insensitive comparison)
      const originalReceiver = splitData.receivers.find((r: any) => 
        (r.resolvedAddress as string).toLowerCase() === address.toLowerCase()
      );
      
      if (address.toLowerCase() === creatorAddress.toLowerCase()) {
        return 'You';
      } else if (originalReceiver?.username === 'SELF_REFERENCE') {
        return 'You';
      } else if (originalReceiver?.username) {
        return originalReceiver.username.startsWith('0x') ? `${address.slice(0, 6)}...${address.slice(-4)}` : originalReceiver.username;
      } else {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
      }
    }).join(', ');

    // Encode the deployment function call
    const functionData = encodeFunctionData({
      abi: TreasuryManagerFactoryAbi,
      functionName: 'deployAndInitializeManager',
      args: [
        addressFeeSplitManagerImplementation,
        flaunchyOwner,
        initializeParams
      ]
    });

    // Return wallet send calls in the correct format
    return {
      version: '1.0',
      from: creatorAddress, // Use creator address as sender
      chainId: numToHex(baseSepolia.id),
      calls: [
        {
          chainId: baseSepolia.id,
          to: treasuryManagerFactory,
          data: functionData,
          value: '0',
          metadata: {
            description: `Create Group for ${receiverList}`
          }
        }
      ]
    };
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

      // Parse JSON response
      const result = JSON.parse(content) as LaunchExtractionResult;
      
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
    const resolved = [];

    for (const receiver of receivers) {
      let address: string | undefined;

      // Check if it's already an Ethereum address
      if (this.isValidEthereumAddress(receiver.username)) {
        address = receiver.username;
      } else {
        // Try resolving via context helper
        try {
          address = await context.resolveUsername(receiver.username);
        } catch (error) {
          this.log(`Failed to resolve username: ${receiver.username}`, error);
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

  private async launchCoin(context: FlowContext, coinData: any, splitData: any): Promise<void> {
    const { userState } = context;

    this.log('Preparing coin launch transaction', {
      userId: userState.userId,
      coinData,
      splitData
    });

    try {
      // Create the transaction calls for the user's wallet (no messages, just transaction)
      const walletSendCalls = await this.createLaunchTransactionCalls(coinData, splitData, context.creatorAddress, context);

      // Set pending transaction state before sending wallet call
      await context.updateState({
        pendingTransaction: {
          type: 'coin_creation', // This is a coin launch, not group creation
          coinData: {
            name: coinData.name,
            ticker: coinData.ticker,
            image: coinData.image
          },
          network: process.env.XMTP_ENV === 'production' ? 'base' : 'base-sepolia',
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

  private async createLaunchTransactionCalls(coinData: any, splitData: any, creatorAddress: string, context: FlowContext): Promise<any> {
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

    this.log('Creating launch transaction for Base Sepolia', {
      network: NETWORK_CONFIG.CHAIN_NAME,
      chainId: NETWORK_CONFIG.CHAIN_ID,
      coinData,
      splitData,
      creatorAddress
    });

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
        
        this.log('Launch receivers before deduplication', {
          receivers: splitData.receivers.map((r: any) => ({
            username: r.username,
            resolvedAddress: r.resolvedAddress,
            percentage: r.percentage
          }))
        });

        // Build address share map by combining duplicate addresses (case-insensitive)
        for (const receiver of splitData.receivers) {
          const address = (receiver.resolvedAddress as string).toLowerCase();
          const sharePercent = receiver.percentage || (100 / splitData.receivers.length);
          const share = BigInt(Math.round(sharePercent * 100000)); // Convert percentage to share format
          
          const currentShare = addressShareMap.get(address) || 0n;
          addressShareMap.set(address, currentShare + share);
        }

        totalReceivers = addressShareMap.size;

        this.log('Launch receivers after deduplication', {
          uniqueReceivers: Array.from(addressShareMap.entries()).map(([addr, share]) => ({
            address: addr,
            share: share.toString(),
            percentage: (Number(share) / 100000).toFixed(2) + '%'
          }))
        });

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

  protected isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
} 
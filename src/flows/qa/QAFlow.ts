import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";
import { createLaunchExtractionPrompt, LaunchExtractionResult } from "../onboarding/launchExtractionTemplate";

export class QAFlow extends BaseFlow {
  constructor() {
    super('QAFlow');
  }

  async processMessage(context: FlowContext): Promise<void> {
    const messageText = this.extractMessageText(context);
    
    this.log('Processing Q&A message', { 
      userId: context.userState.userId,
      message: messageText.substring(0, 100) + '...'
    });

    // If user is in onboarding, check for coin details and fee receivers and store them
    if (context.userState.status === 'onboarding' && context.userState.onboardingProgress) {
      const extraction = await this.extractLaunchDetails(context);
      if (extraction) {
        let hasUpdates = false;
        let updatedProgress = { ...context.userState.onboardingProgress };

        // Store coin details if found
        if (extraction.tokenDetails && (extraction.tokenDetails.name || extraction.tokenDetails.ticker || extraction.tokenDetails.image)) {
          const currentCoinData = context.userState.onboardingProgress.coinData || { name: undefined, ticker: undefined, image: undefined };
          const updatedCoinData = {
            name: extraction.tokenDetails.name || currentCoinData.name,
            ticker: extraction.tokenDetails.ticker || currentCoinData.ticker,
            image: extraction.tokenDetails.image || currentCoinData.image
          };

          this.log('Coin details detected in QA flow, storing for onboarding', {
            userId: context.userState.userId,
            coinData: updatedCoinData
          });

          updatedProgress.coinData = updatedCoinData;
          hasUpdates = true;
        }

        // Store fee receiver data if found
        if (extraction.feeReceivers && extraction.feeReceivers.receivers && extraction.feeReceivers.receivers.length > 0) {
          this.log('Fee receivers detected in QA flow, storing for onboarding', {
            userId: context.userState.userId,
            receivers: extraction.feeReceivers.receivers,
            splitType: extraction.feeReceivers.splitType
          });

          // Convert extraction format to onboarding progress format
          const convertedReceivers = extraction.feeReceivers.receivers.map(receiver => ({
            username: receiver.type === 'self' ? context.creatorAddress : receiver.identifier,
            resolvedAddress: receiver.type === 'self' ? context.creatorAddress : undefined,
            percentage: receiver.percentage || undefined
          }));

          updatedProgress.splitData = {
            receivers: convertedReceivers,
            equalSplit: extraction.feeReceivers.splitType === 'equal',
            creatorPercent: 0
          };
          hasUpdates = true;
        }

        // Update state if we found any data
        if (hasUpdates) {
          await context.updateState({
            onboardingProgress: updatedProgress
          });
        }
      }
    }

    // For now, use character to generate a helpful response
    // TODO: Integrate with knowledge base
    const response = await getCharacterResponse({
      openai: context.openai,
      character: context.character,
      prompt: `
        User asked: "${messageText}"
        
        User context:
        - Status: ${context.userState.status}
        - Has ${context.userState.coins.length} coins
        - Has ${context.userState.groups.length} groups
        
        CRITICAL: Keep your response concise.
        
        Provide a helpful but concise response based on your knowledge about:
        - Group creation and management
        - Coin launching with Flaunch
        - Fee splitting mechanisms
        - Trading and fair launches
        
        Use your character's voice but prioritize brevity above all else.
      `
    });

    await this.sendResponse(context, response);
  }

  private async extractLaunchDetails(context: FlowContext): Promise<LaunchExtractionResult | null> {
    const messageText = this.extractMessageText(context);
    
    // Allow extraction even with empty message if there's an attachment
    if (!messageText && !context.hasAttachment) {
      return null;
    }

    try {
      const extractionPrompt = createLaunchExtractionPrompt({ 
        message: messageText || '',
        hasAttachment: context.hasAttachment,
        attachmentType: context.hasAttachment ? 'image' : undefined
      });
      
      const completion = await context.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 1000
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) {
        return null;
      }

      const result = JSON.parse(response) as LaunchExtractionResult;
      
      this.log('🔍 LAUNCH EXTRACTION RESULT', {
        messageText: messageText || '(empty with attachment)',
        hasAttachment: context.hasAttachment,
        tokenDetails: result.tokenDetails,
        feeReceivers: result.feeReceivers,
        timestamp: new Date().toISOString()
      });

      return result;
    } catch (error) {
      this.logError('Failed to extract launch details', error);
      return null;
    }
  }
} 
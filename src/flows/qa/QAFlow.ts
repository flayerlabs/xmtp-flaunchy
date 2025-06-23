import { BaseFlow } from "../../core/flows/BaseFlow";
import { FlowContext } from "../../core/types/FlowContext";
import { getCharacterResponse } from "../../../utils/character";

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
        
        Provide a helpful response based on your knowledge about:
        - Group creation and management
        - Coin launching with Flaunch
        - Fee splitting mechanisms
        - Trading and fair launches
        
        If you don't know something specific, acknowledge it and suggest they can ask more questions.
        Use your character's personality and style.
      `
    });

    await this.sendResponse(context, response);
  }
} 
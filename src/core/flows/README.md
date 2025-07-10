# Flow Routing System

## Overview

The flow routing system uses LLM-based intent classification to determine user intent and route messages to the appropriate flow handler. This replaces the previous keyword-based matching system with a more robust and flexible approach.

## Components

### IntentClassifier

The `IntentClassifier` uses GPT-3.5-turbo to classify user messages into one of five intent categories:

- **onboarding** - User wants to create their first group or is new
- **coin_launch** - User wants to launch a coin into an existing group
- **management** - User wants to view/manage existing groups/coins
- **qa** - General questions, help, or conversation
- **confirmation** - Confirming a previous request

### FlowRouter

The `FlowRouter` coordinates message routing using the intent classifier:

1. Receives message and user context
2. Calls IntentClassifier to determine intent
3. Maps intent to appropriate flow type
4. Routes message to the corresponding flow handler

## Intent Classification

The system uses a structured prompt template that includes:

- User context (status, group count, coin count)
- Clear intent definitions with examples
- Routing rules based on user state
- JSON response format for consistency

### Context-Aware Routing

The system considers user context when routing:

- **New users** → Onboarding flow
- **Active users with groups** → Coin launch or management flows
- **Confirmations** → Context-dependent routing based on user state

## Benefits

1. **Flexibility** - Handles natural language variations better than keywords
2. **Accuracy** - Uses AI understanding rather than simple pattern matching
3. **Maintainability** - Single prompt template vs. multiple keyword lists
4. **Extensibility** - Easy to add new intents or modify existing ones

## Configuration

The classifier uses:

- Model: `gpt-3.5-turbo` (lightweight for speed)
- Temperature: `0.1` (low for consistent classification)
- Max tokens: `150` (sufficient for JSON response)

## Error Handling

The system includes robust fallback mechanisms:

- OpenAI API errors → Fallback to user state-based routing
- Invalid JSON responses → Default to Q&A flow
- Network issues → Graceful degradation with logging

# Complete Refactor Architecture Proposal

## 🎯 Overview
This proposal outlines a complete refactor to implement:
1. Two-step onboarding flow for new users
2. Knowledge-based Q&A system
3. User state management with persistent sessions
4. API integration for user data queries
5. Extensible architecture for multiple groups/coins

## 📁 Proposed Directory Structure

```
src/
├── core/
│   ├── session/
│   │   ├── SessionManager.ts       # Manages user sessions & state
│   │   ├── UserState.ts           # User state interface & storage
│   │   └── StateStore.ts          # Persistent state management
│   ├── flows/
│   │   ├── FlowRouter.ts          # Routes messages to correct flow
│   │   ├── BaseFlow.ts            # Abstract base flow class
│   │   └── FlowContext.ts         # Shared flow context
│   └── messaging/
│       ├── MessageCoordinator.ts   # Enhanced message coordination
│       └── ResponseGenerator.ts    # Centralized response generation
├── flows/
│   ├── onboarding/
│   │   ├── OnboardingFlow.ts      # Main onboarding orchestrator
│   │   ├── CoinCreationStep.ts    # Step 1: Coin details collection
│   │   ├── GroupTypeStep.ts       # Step 2: Group type selection
│   │   └── OnboardingState.ts     # Onboarding-specific state
│   ├── qa/
│   │   ├── QAFlow.ts              # Question & Answer handler
│   │   ├── KnowledgeBase.ts       # Knowledge retrieval system
│   │   └── ContextMatcher.ts      # Intent recognition
│   └── management/
│       ├── GroupManagementFlow.ts # Existing group management
│       ├── CoinManagementFlow.ts  # Coin management
│       └── UserDataFlow.ts        # User data queries
├── api/
│   ├── client/
│   │   ├── ApiClient.ts           # Main API client
│   │   ├── UserDataApi.ts         # User coins/groups API
│   │   └── GroupsApi.ts           # Groups management API
│   └── types/
│       ├── UserData.ts            # API response types
│       └── GroupData.ts           # Group-related types
├── knowledge/
│   ├── base/
│   │   ├── groups.md              # Group creation knowledge
│   │   ├── coins.md               # Coin launching knowledge
│   │   └── fees.md                # Fee splitting knowledge
│   ├── KnowledgeLoader.ts         # Knowledge base loader
│   └── Embeddings.ts              # Vector embeddings for search
├── state/
│   ├── types/
│   │   ├── UserState.ts           # User state interface
│   │   ├── OnboardingState.ts     # Onboarding progress
│   │   └── SessionState.ts        # Session management types
│   └── storage/
│       ├── StateStorage.ts        # State persistence layer
│       └── MemoryStore.ts         # In-memory state store
├── tools/
│   ├── onboarding/
│   │   ├── CreateFirstCoin.ts     # First coin creation tool
│   │   └── SetupGroup.ts          # Group setup tool
│   ├── management/
│   │   ├── AddCoin.ts             # Add new coin to group
│   │   ├── ListUserCoins.ts       # List user's coins
│   │   └── ListUserGroups.ts      # List user's groups
│   └── enhanced/
│       ├── SmartFlaunch.ts        # Enhanced flaunch with context
│       └── GroupQuery.ts          # Query group information
└── utils/
    ├── validation/
    │   ├── OnboardingValidation.ts # Onboarding input validation
    │   └── StateValidation.ts      # State validation helpers
    └── helpers/
        ├── UserIdentification.ts   # User identification helpers
        └── ProgressTracking.ts     # Progress tracking utilities
```

## 🔄 Core Flow Architecture

### 1. Session Management System

```typescript
interface UserState {
  userId: string;
  status: 'new' | 'onboarding' | 'active';
  onboardingProgress?: OnboardingProgress;
  coins: UserCoin[];
  groups: UserGroup[];
  preferences: UserPreferences;
}

interface OnboardingProgress {
  step: 'coin_creation' | 'username_collection' | 'completed';
  coinData?: {
    name?: string;
    ticker?: string;
    image?: string;
  };
  splitData?: {
    receivers: Array<{
      username: string;
      resolvedAddress?: string;
      percentage?: number;
    }>;
    equalSplit: boolean;
  };
  startedAt: Date;
  completedAt?: Date;
}
```

### 2. Flow Router System

The FlowRouter determines which flow handles each message:

```typescript
class FlowRouter {
  route(userState: UserState, message: string): FlowType {
    // New user -> Onboarding
    if (userState.status === 'new') return 'onboarding';
    
    // Onboarding in progress -> Continue onboarding
    if (userState.status === 'onboarding') return 'onboarding';
    
    // Question detection -> Q&A
    if (this.isQuestion(message)) return 'qa';
    
    // Management commands -> Management
    if (this.isManagementCommand(message)) return 'management';
    
    // Default -> Q&A for general conversation
    return 'qa';
  }
}
```

### 3. Onboarding Flow Implementation

```typescript
class OnboardingFlow extends BaseFlow {
  async processMessage(context: FlowContext): Promise<void> {
    const { userState, message } = context;
    
    switch (userState.onboardingProgress?.step) {
      case undefined:
      case 'coin_creation':
        return this.handleCoinCreationStep(context);
      case 'username_collection':
        return this.handleUsernameCollectionStep(context);
      default:
        return this.completeOnboarding(context);
    }
  }
}
```

## 🎯 Key Features Implementation

### 1. Two-Step Onboarding

**Step 1: Coin Creation**
- Prompts: "To get started we need to launch a coin for your Group..."
- Collects: name, ticker, image
- Validates input and provides feedback
- Stores partial state

**Step 2: Username Split Setup**
- Prompts: "Now I need the usernames/addresses for your Group..."
- Collects: usernames, ENS names, or Ethereum addresses
- Optionally collects: custom fee percentages (defaults to equal split)
- Resolves usernames to addresses
- Validates percentages sum to 100%
- Uses @flaunch/sdk for actual coin launch

### 2. Knowledge-Based Q&A

```typescript
class QAFlow extends BaseFlow {
  async processMessage(context: FlowContext): Promise<void> {
    const intent = await this.classifyIntent(context.message);
    const knowledgeContext = await this.knowledgeBase.search(context.message);
    
    const response = await this.generateContextualResponse({
      message: context.message,
      intent,
      knowledge: knowledgeContext,
      userState: context.userState
    });
    
    await context.sendResponse(response);
  }
}
```

### 3. User Data Integration

```typescript
class UserDataFlow extends BaseFlow {
  async getUserCoins(userId: string): Promise<UserCoin[]> {
    return this.apiClient.getUserCoins(userId);
  }
  
  async getUserGroups(userId: string): Promise<UserGroup[]> {
    return this.apiClient.getUserGroups(userId);
  }
}
```

## 🛠️ Enhanced Tools

### New Onboarding Tools

1. **create_first_coin** - Streamlined first coin creation with @flaunch/sdk
2. **resolve_usernames** - Resolve usernames/ENS to addresses
3. **validate_fee_splits** - Validate fee percentages sum to 100%
4. **complete_onboarding** - Finalize onboarding with SDK launch

### Enhanced Management Tools

1. **add_coin_to_group** - Add new coins to existing groups
2. **list_my_coins** - Show user's coins with API data
3. **list_my_groups** - Show user's groups with member info
4. **group_info** - Detailed group information

## 📊 State Management Strategy

### Persistent State Storage
- User sessions persist across conversations
- Progress tracking for incomplete onboarding
- Cached user data with refresh mechanisms

### State Transitions
```
New User -> Onboarding (Step 1) -> Onboarding (Step 2) -> Active User
                                                       -> Existing User (returning)
```

## 🔌 API Integration Architecture

### User Data API
```typescript
interface UserDataApi {
  getUserCoins(userId: string): Promise<UserCoin[]>;
  getUserGroups(userId: string): Promise<UserGroup[]>;
  getGroupMembers(groupId: string): Promise<GroupMember[]>;
  getGroupStats(groupId: string): Promise<GroupStats>;
}
```

### Caching Strategy
- Cache user data for performance
- Invalidate cache on state changes
- Background refresh for active users

## 🎨 Character Enhancement

### Context-Aware Responses
- Onboarding: Friendly, guiding tone
- Q&A: Knowledgeable, helpful responses
- Management: Efficient, action-oriented

### Personality Adaptation
- New users: More explanatory
- Experienced users: Concise and direct
- Error states: Patient and helpful

## 🚀 Migration Strategy

### Phase 1: Core Infrastructure
1. Implement session management
2. Create flow router
3. Set up state storage

### Phase 2: Onboarding Flow
1. Build onboarding steps
2. Create onboarding tools
3. Test complete flow

### Phase 3: Knowledge & API
1. Implement knowledge base
2. Add API integration
3. Enhanced user data tools

### Phase 4: Polish & Extension
1. Advanced features
2. Performance optimization
3. Additional group types

## 📈 Extensibility Considerations

### Multiple Groups Support
- User can create unlimited groups
- Each group has independent coin management
- Cross-group analytics and insights

### Multiple Coins per Group
- Add coins to existing groups
- Coin-specific settings and management
- Group-wide coin performance tracking

### Future Enhancements
- Advanced fee splitting algorithms
- Group governance features
- Integration with external platforms
- Advanced analytics and reporting

This architecture provides a solid foundation for the requested features while maintaining extensibility for future enhancements. The modular design allows for incremental implementation and testing of each component. 
# Group Creation Refactor Summary

## Problem Solved
The original flow was confusing because it mixed group creation and coin creation in a single step, leading to routing ambiguity between OnboardingFlow and CoinLaunchFlow.

## New Two-Step Process

### Step 1: Group Creation (OnboardingFlow)
1. **User specifies fee receivers** (usernames, ENS, addresses, percentages)
2. **Deploy AddressFeeSplitManager** contract with the fee split configuration
3. **Store manager address** for use in coin launches

### Step 2: Coin Launch (OnboardingFlow → CoinLaunchFlow)
1. **User provides coin details** (name, ticker, image)
2. **Launch coin using existing manager** with empty initializeData/depositData
3. **Manager address is used** in treasuryManagerParams

## Key Changes Made

### 1. Updated OnboardingProgress Type
```typescript
export interface OnboardingProgress {
  step: 'group_creation' | 'coin_creation' | 'username_collection' | 'completed';
  // ... existing fields ...
  splitData?: {
    // ... existing fields ...
    managerAddress?: string; // NEW: Address of deployed AddressFeeSplitManager
  };
  groupData?: {  // NEW: Group creation tracking
    managerAddress?: string;
    txHash?: string;
  };
}
```

### 2. New OnboardingFlow Structure
- **startOnboarding()**: Now asks for fee receivers first (not coin details)
- **handleGroupCreation()**: NEW - Processes fee receiver input and deploys manager
- **handleCoinCreation()**: Updated to use pre-deployed manager address
- **treasuryManagerParams**: Now uses deployed manager with empty init/deposit data

### 3. Created Group Creation Utility
- **src/utils/groupCreation.ts**: Handles AddressFeeSplitManager deployment
- **createAddressFeeSplitManager()**: Mock implementation for testing
- **deployAddressFeeSplitManager()**: Full implementation with viem clients

### 4. Updated Welcome Message
- **Before**: "I'll help you launch your first token"
- **After**: "First create a Group by specifying fee receivers, then launch coins"

## Implementation Status

### ✅ Completed
- [x] Updated OnboardingProgress types
- [x] Refactored OnboardingFlow to start with group creation
- [x] Added handleGroupCreation() method
- [x] Updated coin launch to use pre-deployed manager
- [x] Created group creation utility structure
- [x] Fixed welcome message to be less cringe and more informative

### 🚧 TODO (Next Steps)
- [ ] Implement actual AddressFeeSplitManager deployment in groupCreation.ts
- [ ] Add proper address resolution for usernames/ENS
- [ ] Update CoinLaunchFlow to handle users with existing groups
- [ ] Add group creation transaction tracking
- [ ] Import actual ABI and addresses
- [ ] Test the full flow end-to-end

## New User Experience

### Before (Confusing)
```
User: "I want to launch a token"
Bot: "Give me name, ticker, image, AND fee receivers all at once"
```

### After (Clear)
```
User: "I want to launch a token"
Bot: "First, let's create a Group. Who should receive trading fees?"
User: "@alice 30%, @bob 70%"
Bot: "Great! Group created. Now what coin do you want to launch?"
User: "MyCoin (MCN) [image]"
Bot: "Perfect! Launching MyCoin into your group..."
```

## Technical Benefits

1. **Clear Separation**: Group creation vs coin creation are distinct steps
2. **Reusable Groups**: Once created, groups can have multiple coins launched into them
3. **Better Routing**: No ambiguity between onboarding and coin launch flows
4. **Efficient**: Manager is deployed once, used multiple times
5. **Scalable**: Supports the intended multi-coin-per-group architecture 
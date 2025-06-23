# Onboarding Flow Implementation Example

## 🎬 Complete User Journey

### Initial Contact - New User Detection
```
User: "hey"
Bot: "gmeow! looks like you're new here. to help you get started, i need to set up your first Group and launch a coin for it.

to get started we need to launch a coin for your Group. i need a name, ticker and image. you can add more coins later on and all trading fees will be shared with Group members.

what's the name of your coin?"

State: { status: 'onboarding', step: 'coin_creation', coinData: {} }
```

### Step 1: Coin Creation Flow
```
User: "FluffyCoin"
Bot: "nice! FluffyCoin it is. now i need a ticker symbol (like BTC or ETH) - what ticker do you want for FluffyCoin?"

State: { status: 'onboarding', step: 'coin_creation', coinData: { name: 'FluffyCoin' } }
```

```
User: "FLUFF"
Bot: "perfect! FLUFF is a solid ticker. now i need an image for your coin. you can either send me an image or provide a URL to one."

State: { status: 'onboarding', step: 'coin_creation', coinData: { name: 'FluffyCoin', ticker: 'FLUFF' } }
```

```
User: [sends image attachment]
Bot: "got your image! working on processing it...
uploading to ipfs now...

great! now i have everything for your FLUFF coin. moving to step 2...

now i need the usernames or addresses of the people you want to split trading fees with. you can provide:
- farcaster usernames (like @alice)
- ENS names (like alice.eth)  
- ethereum addresses (like 0x123...)

just list them separated by commas. if you want custom fee percentages, add them like: @alice 30%, @bob 70%
otherwise they'll be split equally among everyone."

State: { 
  status: 'onboarding', 
  step: 'username_collection', 
  coinData: { name: 'FluffyCoin', ticker: 'FLUFF', image: 'ipfs://...' } 
}
```

### Step 2: Username Collection
```
User: "@alice, @bob, charlie.eth"
Bot: "got it! i'll set up equal splits for:
- @alice
- @bob  
- charlie.eth
- you (as creator)

resolving addresses..."

[Resolves usernames to addresses]

Bot: "addresses resolved successfully:
- @alice -> 0x123...abc
- @bob -> 0x456...def
- charlie.eth -> 0x789...ghi

each person will get 25% of trading fees (equal split).

launching your FLUFF coin now with @flaunch/sdk..."

[Calls flaunchWrite.flaunchIPFSWithSplitManager]

Bot: "boom! your FLUFF coin is launching 🎉

coin details:
- name: FluffyCoin (FLUFF)
- fair launch: 30 minutes, 40% supply
- starting market cap: $1,000
- fee split: 25% each among 4 members
- creator fee allocation: 100%

your Group is ready! here's what you can do:
- add more coins to your group
- check your group's performance  
- ask me questions about managing your group

fair launch starts now - stay flaunchy!"

State: { 
  status: 'active', 
  onboardingProgress: { completed: true },
  groups: [{ id: 'group_123', type: 'username_split', receivers: [...] }],
  coins: [{ ticker: 'FLUFF', groupId: 'group_123', launched: true }]
}
```

### Alternative: Custom Percentages
```
User: "@alice 40%, @bob 30%, charlie.eth 20%"
Bot: "got it! custom fee splits:
- @alice: 40%
- @bob: 30%
- charlie.eth: 20%
- you (creator): 10% (remaining)

total: 100% ✓

resolving addresses and launching..."

[Same resolution and launch process]
```

## 🔄 State Management Implementation

### SessionManager Class
```typescript
export class SessionManager {
  private stateStore: StateStore;
  
  async getUserState(userId: string): Promise<UserState> {
    let state = await this.stateStore.get(userId);
    
    if (!state) {
      // New user - initialize onboarding
      state = {
        userId,
        status: 'new',
        onboardingProgress: {
          step: 'coin_creation',
          startedAt: new Date(),
          coinData: {}
        },
        coins: [],
        groups: [],
        preferences: {}
      };
      
      await this.stateStore.set(userId, state);
    }
    
    return state;
  }
  
  async updateUserState(userId: string, updates: Partial<UserState>): Promise<void> {
    const currentState = await this.getUserState(userId);
    const newState = { ...currentState, ...updates };
    await this.stateStore.set(userId, newState);
  }
}
```

### OnboardingFlow Class
```typescript
export class OnboardingFlow extends BaseFlow {
  async processMessage(context: FlowContext): Promise<void> {
    const { userState, message, sendResponse } = context;
    const progress = userState.onboardingProgress!;
    
    switch (progress.step) {
      case 'coin_creation':
        await this.handleCoinCreation(context);
        break;
      case 'username_collection':
        await this.handleUsernameCollection(context);
        break;
    }
  }
  
  private async handleCoinCreation(context: FlowContext): Promise<void> {
    const { userState, message, sendResponse, updateState } = context;
    const coinData = userState.onboardingProgress!.coinData!;
    
    if (!coinData.name) {
      // Collect coin name
      await updateState({
        onboardingProgress: {
          ...userState.onboardingProgress,
          coinData: { ...coinData, name: message.trim() }
        }
      });
      
      await sendResponse("nice! ${message.trim()} it is. now i need a ticker symbol (like BTC or ETH) - what ticker do you want for ${message.trim()}?");
      return;
    }
    
    if (!coinData.ticker) {
      // Validate and collect ticker
      const ticker = message.trim().toUpperCase();
      if (!/^[A-Z]{2,8}$/.test(ticker)) {
        await sendResponse("ticker should be 2-8 letters, try again");
        return;
      }
      
      await updateState({
        onboardingProgress: {
          ...userState.onboardingProgress,
          coinData: { ...coinData, ticker }
        }
      });
      
      await sendResponse("perfect! ${ticker} is a solid ticker. now i need an image for your coin. you can either send me an image or provide a URL to one.");
      return;
    }
    
    if (!coinData.image && context.hasAttachment) {
      // Process image attachment
      const imageUrl = await this.processImageAttachment(context.attachment);
      
      await updateState({
        onboardingProgress: {
          ...userState.onboardingProgress,
          step: 'username_collection',
          coinData: { ...coinData, image: imageUrl }
        }
      });
      
      await sendResponse(`got your image! working on processing it...
uploading to ipfs now...

great! now i have everything for your ${coinData.ticker} coin. moving to step 2...

now i need the usernames or addresses of the people you want to split trading fees with. you can provide:
- farcaster usernames (like @alice)
- ENS names (like alice.eth)  
- ethereum addresses (like 0x123...)

just list them separated by commas. if you want custom fee percentages, add them like: @alice 30%, @bob 70%
otherwise they'll be split equally among everyone.`);
      return;
    }
  }
  
  private async handleUsernameCollection(context: FlowContext): Promise<void> {
    const { userState, message, sendResponse, updateState } = context;
    const coinData = userState.onboardingProgress!.coinData!;
    
    // Parse usernames and percentages from message
    const splitData = this.parseUsernameInput(message);
    if (!splitData.valid) {
      await sendResponse(splitData.error || "please provide usernames/addresses separated by commas");
      return;
    }
    
    await sendResponse(`got it! ${splitData.equalSplit ? 'equal splits' : 'custom fee splits'} for:
${splitData.receivers.map(r => `- ${r.username}${r.percentage ? `: ${r.percentage}%` : ''}`).join('\n')}
- you (as creator)${splitData.creatorPercent ? `: ${splitData.creatorPercent}%` : ''}

resolving addresses...`);
    
    // Resolve usernames to addresses
    const resolvedReceivers = await this.resolveUsernames(splitData.receivers);
    
    if (resolvedReceivers.some(r => !r.resolvedAddress)) {
      const failed = resolvedReceivers.filter(r => !r.resolvedAddress).map(r => r.username);
      await sendResponse(`couldn't resolve these usernames: ${failed.join(', ')}. please check and try again.`);
      return;
    }
    
    await sendResponse(`addresses resolved successfully:
${resolvedReceivers.map(r => `- ${r.username} -> ${r.resolvedAddress?.slice(0, 6)}...${r.resolvedAddress?.slice(-4)}`).join('\n')}

${splitData.equalSplit ? 
  `each person will get ${Math.round(100 / (resolvedReceivers.length + 1))}% of trading fees (equal split).` :
  `total: 100% ✓`}

launching your ${coinData.ticker} coin now with @flaunch/sdk...`);
    
    // Launch coin with @flaunch/sdk
    try {
      const launchResult = await this.launchCoinWithSDK({
        coinData,
        splitReceivers: resolvedReceivers,
        creatorAddress: context.creatorAddress,
        creatorSplitPercent: splitData.creatorPercent || (splitData.equalSplit ? Math.round(100 / (resolvedReceivers.length + 1)) : 0)
      });
      
      await updateState({
        status: 'active',
        onboardingProgress: {
          ...userState.onboardingProgress,
          step: 'completed',
          splitData: {
            receivers: resolvedReceivers,
            equalSplit: splitData.equalSplit
          },
          completedAt: new Date()
        },
        groups: [{
          id: launchResult.groupId,
          type: 'username_split',
          receivers: resolvedReceivers,
          coins: [coinData.ticker!],
          createdAt: new Date()
        }],
        coins: [{
          ticker: coinData.ticker!,
          name: coinData.name!,
          image: coinData.image!,
          groupId: launchResult.groupId,
          contractAddress: launchResult.contractAddress,
          launched: true,
          createdAt: new Date()
        }]
      });
      
      await sendResponse(`boom! your ${coinData.ticker} coin is launching 🎉

coin details:
- name: ${coinData.name} (${coinData.ticker})
- fair launch: 30 minutes, 40% supply
- starting market cap: $1,000
- fee split: ${splitData.equalSplit ? 'equal among all members' : 'custom percentages'}
- creator fee allocation: 100%

your Group is ready! here's what you can do:
- add more coins to your group
- check your group's performance  
- ask me questions about managing your group

fair launch starts now - stay flaunchy!`);
      
    } catch (error) {
      console.error('Launch failed:', error);
      await sendResponse(`sorry, coin launch failed: ${error.message}. let's try again or you can start over.`);
    }
  }
  
  private async launchCoinWithSDK({
    coinData,
    splitReceivers,
    creatorAddress,
    creatorSplitPercent
  }: {
    coinData: any;
    splitReceivers: any[];
    creatorAddress: string;
    creatorSplitPercent: number;
  }) {
    // Calculate precise fee splits using the provided logic
    const totalShare = BigInt(100_00000); // 100% with 5 decimals
    
    const feeReceivers = splitReceivers.map(r => ({
      resolvedAddress: r.resolvedAddress,
      percentage: r.percentage || (100 / (splitReceivers.length + 1)) // Equal split if no percentage
    }));
    
    // Calculate shares for all recipients except the last one
    const recipientShares = feeReceivers.map((receiver, index) => {
      if (index === feeReceivers.length - 1) {
        return {
          recipient: receiver.resolvedAddress as `0x${string}`,
          share: BigInt(0), // Will be calculated below
        };
      } else {
        const share = BigInt(Math.round(receiver.percentage * 100000));
        return {
          recipient: receiver.resolvedAddress as `0x${string}`,
          share,
        };
      }
    });
    
    // Calculate remainder for last recipient
    const usedShares = recipientShares
      .slice(0, -1)
      .reduce((sum, item) => sum + item.share, BigInt(0));
    
    const remainderShare = totalShare - usedShares;
    recipientShares[recipientShares.length - 1].share = remainderShare;
    
    // Verify total equals exactly 100%
    const calculatedTotal = recipientShares.reduce(
      (sum, item) => sum + item.share,
      BigInt(0),
    );
    if (calculatedTotal !== totalShare) {
      throw new Error(
        `Share calculation error: total is ${calculatedTotal} but should be ${totalShare}`,
      );
    }
    
    // Launch with @flaunch/sdk
    const result = await flaunchWrite.flaunchIPFSWithSplitManager({
      name: coinData.name,
      symbol: coinData.ticker,
      metadata: {
        base64Image: coinData.image,
      },
      pinataConfig: {
        jwt: process.env.PINATA_JWT!,
      },
      fairLaunchPercent: 40,
      fairLaunchDuration: 30 * 60, // 30 mins
      initialMarketCapUSD: 1_000,
      creator: creatorAddress as `0x${string}`,
      creatorFeeAllocationPercent: 100,
      creatorSplitPercent,
      splitReceivers: recipientShares.map(r => ({
        address: r.recipient,
        percent: Number(r.share) / 100000, // Convert back to percentage
      })),
    });
    
    return {
      contractAddress: result.contractAddress,
      groupId: `group_${Date.now()}`,
      txHash: result.txHash
    };
  }
  
  private parseUsernameInput(message: string): {
    valid: boolean;
    error?: string;
    receivers: Array<{ username: string; percentage?: number }>;
    equalSplit: boolean;
    creatorPercent?: number;
  } {
    const input = message.trim();
    if (!input) {
      return { valid: false, error: "please provide usernames/addresses", receivers: [], equalSplit: true };
    }
    
    // Split by commas and parse each entry
    const entries = input.split(',').map(s => s.trim()).filter(s => s);
    const receivers: Array<{ username: string; percentage?: number }> = [];
    let totalPercent = 0;
    let hasPercentages = false;
    
    for (const entry of entries) {
      // Check if entry has percentage (e.g., "@alice 30%" or "alice.eth 25%")
      const percentMatch = entry.match(/^(.+?)\s+(\d+(?:\.\d+)?)%?$/);
      
      if (percentMatch) {
        const username = percentMatch[1].trim();
        const percent = parseFloat(percentMatch[2]);
        
        if (percent <= 0 || percent >= 100) {
          return { valid: false, error: `percentage must be between 0 and 100: ${percent}%`, receivers: [], equalSplit: true };
        }
        
        receivers.push({ username, percentage: percent });
        totalPercent += percent;
        hasPercentages = true;
      } else {
        // Just username without percentage
        receivers.push({ username: entry });
      }
    }
    
    if (hasPercentages) {
      // Validate total doesn't exceed 100%
      if (totalPercent > 100) {
        return { valid: false, error: `total percentages exceed 100%: ${totalPercent}%`, receivers: [], equalSplit: false };
      }
      
      // Calculate creator percentage (remaining)
      const creatorPercent = 100 - totalPercent;
      
      return {
        valid: true,
        receivers,
        equalSplit: false,
        creatorPercent
      };
    } else {
      // Equal split among all (including creator)
      return {
        valid: true,
        receivers,
        equalSplit: true
      };
    }
  }
  
  private async resolveUsernames(receivers: Array<{ username: string; percentage?: number }>): Promise<Array<{
    username: string;
    percentage?: number;
    resolvedAddress?: string;
  }>> {
    const resolved = [];
    
    for (const receiver of receivers) {
      let address: string | undefined;
      
      // Check if it's already an Ethereum address
      if (/^0x[a-fA-F0-9]{40}$/.test(receiver.username)) {
        address = receiver.username;
      } 
      // Try resolving ENS name
      else if (receiver.username.includes('.eth')) {
        try {
          address = await this.resolveENS(receiver.username);
        } catch (error) {
          console.log(`Failed to resolve ENS ${receiver.username}:`, error);
        }
      }
      // Try resolving Farcaster username
      else if (receiver.username.startsWith('@')) {
        try {
          address = await this.resolveFarcaster(receiver.username.slice(1));
        } catch (error) {
          console.log(`Failed to resolve Farcaster ${receiver.username}:`, error);
        }
      }
      
      resolved.push({
        ...receiver,
        resolvedAddress: address
      });
    }
    
    return resolved;
  }
  
  private async resolveENS(ensName: string): Promise<string | undefined> {
    // Implementation would use ENS resolver
    // For now, return mock address
    return "0x" + "1234567890abcdef".repeat(2.5);
  }
  
  private async resolveFarcaster(username: string): Promise<string | undefined> {
    // Implementation would use Farcaster API
    // For now, return mock address
    return "0x" + "abcdef1234567890".repeat(2.5);
  }
}
```

## 🧠 Knowledge Base Q&A Examples

### After Onboarding - Q&A Flow
```
User: "how do trading fees work?"
Bot: "trading fees are 1% on both buys and sells. since you set up a username split group, fees are distributed equally among all group members.

for your FLUFF coin specifically:
- 80% of fees go to your group members (split equally)
- 20% goes to automated buybacks for price support

want to know more about fee distribution or automated buybacks?"

Context: Uses knowledge base + user's specific group type
```

```
User: "can i add another coin to my group?"
Bot: "absolutely! you can add unlimited coins to your existing group. all trading fees from new coins will also be split among your group members.

want me to help you launch another coin right now?"

Context: References user's current group setup
```

```
User: "show me my coins"
Bot: [Calls API to fetch user's coins]
"here are your coins:

🪙 FluffyCoin (FLUFF)
- launched: 2 hours ago
- group: your username split group
- fair launch: active (28 minutes remaining)
- current price: $10,000 market cap
- your share of fees: equal split with 3 other members

want details on any specific coin or ready to launch another?"

Context: Live API data + user's specific situation
```

## 🔌 Integration Points

### State Persistence
```typescript
// SQLite/PostgreSQL schema
CREATE TABLE user_states (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  onboarding_progress JSON,
  coins JSON,
  groups JSON,
  preferences JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### API Integration
```typescript
interface UserDataApi {
  async getUserCoins(userId: string): Promise<{
    ticker: string;
    name: string;
    groupId: string;
    launchTime: Date;
    currentPrice: number;
    fairLaunchStatus: 'active' | 'completed';
    timeRemaining?: number;
  }[]>;
  
  async getUserGroups(userId: string): Promise<{
    id: string;
    type: 'username_split' | 'staking_split';
    memberCount: number;
    totalFees: number;
    coins: string[];
  }[]>;
}
```

This implementation provides a complete, conversation-driven onboarding experience that guides users through coin creation and group setup while maintaining state and enabling seamless transitions to ongoing management and Q&A functionality. 
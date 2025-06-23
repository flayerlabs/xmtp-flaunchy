# @flaunch/sdk Integration Summary

## 🎯 Key Changes for SDK Integration

### Package Dependencies
```json
{
  "dependencies": {
    "@flaunch/sdk": "^latest",
    // ... existing dependencies
  }
}
```

### Environment Variables
```env
PINATA_JWT=your_pinata_jwt_token
FLAUNCH_PRIVATE_KEY=your_private_key
FLAUNCH_RPC_URL=your_rpc_url
```

## 🔄 Updated Onboarding Flow

### Step 1: Coin Creation (Unchanged)
- Collect: name, ticker, image
- Process and upload image to IPFS
- Store in onboarding state

### Step 2: Username Collection & Launch
1. **Collect usernames/addresses** with optional percentages
2. **Parse and validate** input format
3. **Resolve addresses** (ENS, Farcaster, direct addresses)
4. **Calculate fee splits** with precise BigInt math
5. **Launch coin** using `flaunchWrite.flaunchIPFSWithSplitManager`

## 🧮 Fee Split Calculation Logic

### Equal Split Example
```typescript
// Input: "@alice, @bob, charlie.eth"
// Output: 25% each (including creator)

const receivers = 3; // alice, bob, charlie
const totalParticipants = receivers + 1; // +1 for creator
const percentEach = 100 / totalParticipants; // 25%
```

### Custom Split Example
```typescript
// Input: "@alice 40%, @bob 30%, charlie.eth 20%"
// Creator gets remaining: 100% - (40% + 30% + 20%) = 10%

const totalShare = BigInt(100_00000); // 100% with 5 decimals

// Calculate shares for each recipient
const recipientShares = [
  { recipient: "0x123...", share: BigInt(40 * 100000) }, // alice: 40%
  { recipient: "0x456...", share: BigInt(30 * 100000) }, // bob: 30%
  { recipient: "0x789...", share: BigInt(20 * 100000) }  // charlie: 20%
];

// Creator gets remainder: 10% = 1,000,000 (10 * 100000)
const creatorShare = totalShare - recipientShares.reduce((sum, r) => sum + r.share, 0n);
```

### Precise Rounding Logic
```typescript
// Ensure total always equals exactly 100%
const usedShares = recipientShares
  .slice(0, -1) // All except last
  .reduce((sum, item) => sum + item.share, BigInt(0));

const remainderShare = totalShare - usedShares;
recipientShares[recipientShares.length - 1].share = remainderShare;

// Verify total
const calculatedTotal = recipientShares.reduce(
  (sum, item) => sum + item.share,
  BigInt(0),
);

if (calculatedTotal !== totalShare) {
  throw new Error(`Share calculation error: ${calculatedTotal} ≠ ${totalShare}`);
}
```

## 🚀 SDK Launch Integration

### Complete Launch Function
```typescript
async function launchCoinWithSDK({
  coinData,
  splitReceivers,
  creatorAddress,
  creatorSplitPercent
}) {
  // Calculate precise fee splits
  const totalShare = BigInt(100_00000);
  
  const recipientShares = splitReceivers.map((receiver, index) => {
    if (index === splitReceivers.length - 1) {
      return {
        recipient: receiver.resolvedAddress as `0x${string}`,
        share: BigInt(0), // Will be calculated as remainder
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
  
  recipientShares[recipientShares.length - 1].share = totalShare - usedShares;

  // Launch with SDK
  const result = await flaunchWrite.flaunchIPFSWithSplitManager({
    name: coinData.name,
    symbol: coinData.ticker,
    metadata: {
      base64Image: coinData.image, // Base64 encoded image
    },
    pinataConfig: {
      jwt: process.env.PINATA_JWT!,
    },
    fairLaunchPercent: 40,
    fairLaunchDuration: 30 * 60, // 30 minutes
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
    txHash: result.txHash,
    groupId: `group_${Date.now()}`
  };
}
```

## 🎯 Input Parsing Examples

### Valid Input Formats

#### Equal Split
```
"@alice, @bob, charlie.eth"
"alice.eth, 0x123...abc, @bob"
```

#### Custom Percentages
```
"@alice 40%, @bob 30%, charlie.eth 20%"
"alice.eth 50%, 0x123...abc 25%, @bob 15%"
```

#### Mixed (Some with percentages, some without)
```
"@alice 50%, @bob, charlie.eth"
// Results in: alice 50%, bob 25%, charlie 25% (equal split of remaining)
```

### Input Validation Rules

1. **Percentage Validation**
   - Must be between 0 and 100
   - Total cannot exceed 100%
   - Creator gets remainder

2. **Address Resolution**
   - Ethereum addresses: Used directly
   - ENS names: Resolved via ENS resolver
   - Farcaster usernames: Resolved via Farcaster API
   - Validation fails if any address cannot be resolved

3. **Format Validation**
   - Comma-separated entries
   - Optional percentage with % symbol
   - Whitespace trimmed

## 🔧 Error Handling

### Common Error Scenarios

1. **Address Resolution Failures**
```typescript
// Handle individually
const resolvedReceivers = await Promise.allSettled(
  receivers.map(r => resolveAddress(r.username))
);

const failed = resolvedReceivers
  .filter(r => r.status === 'rejected')
  .map((r, i) => receivers[i].username);

if (failed.length > 0) {
  await sendResponse(`Couldn't resolve: ${failed.join(', ')}`);
  return;
}
```

2. **Percentage Validation**
```typescript
if (totalPercent > 100) {
  await sendResponse(`Total percentages exceed 100%: ${totalPercent.toFixed(1)}%`);
  return;
}
```

3. **SDK Launch Failures**
```typescript
try {
  const result = await flaunchWrite.flaunchIPFSWithSplitManager({...});
} catch (error) {
  console.error('Launch failed:', error);
  await sendResponse(`Launch failed: ${error.message}. Please try again.`);
  return;
}
```

## 📊 State Management Updates

### Enhanced User State
```typescript
interface UserState {
  userId: string;
  status: 'new' | 'onboarding' | 'active';
  onboardingProgress?: {
    step: 'coin_creation' | 'username_collection' | 'completed';
    coinData?: {
      name: string;
      ticker: string;
      image: string; // Base64 or IPFS URL
    };
    splitData?: {
      receivers: Array<{
        username: string;
        resolvedAddress: string;
        percentage?: number;
      }>;
      equalSplit: boolean;
      creatorPercent: number;
    };
    startedAt: Date;
    completedAt?: Date;
  };
  groups: UserGroup[];
  coins: UserCoin[];
}
```

### Launched Coin State
```typescript
interface UserCoin {
  ticker: string;
  name: string;
  image: string;
  groupId: string;
  contractAddress: string;
  txHash: string;
  launched: boolean;
  fairLaunchDuration: number;
  fairLaunchPercent: number;
  initialMarketCap: number;
  createdAt: Date;
}
```

This integration provides a complete onboarding flow that:
1. Guides users through coin creation
2. Collects fee split preferences
3. Resolves usernames to addresses
4. Launches coins with precise fee splitting
5. Maintains comprehensive state for future management

The architecture is extensible to support additional group types (staking splits) and multiple coins per group in the future. 
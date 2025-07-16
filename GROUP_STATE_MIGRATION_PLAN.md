# Group State Migration Plan

## Overview

Migration from `user-states.json` (user-centric) to `group-states.json` (group-centric) state management system.

## Current Architecture Issues

1. **Wrong Data Organization**: Groups are launched at group chat level but tracked per user
2. **Data Duplication**: Same group/coin data stored across multiple user states
3. **Inconsistency Risk**: User states can become out of sync for the same group
4. **Limited Group Context**: Cannot track group-level progress and interactions

## New Architecture Goals

1. **Group-Centric Storage**: Data keyed by group chat ID
2. **Per-User Interaction Tracking**: Within each group, track individual user progress
3. **Group-Level Entities**: Managers and coins stored at group level
4. **Consistent State**: Single source of truth per group

## Data Structure Comparison

### Current: user-states.json

```typescript
{
  "0x123...": {
    userId: string,
    status: string,
    coins: UserCoin[],           // Global user coins
    groups: UserGroup[],         // Global user groups
    groupStates: {              // Per-group progress
      "groupId1": {
        coinLaunchProgress: {...},
        pendingTransaction: {...}
      }
    }
  }
}
```

### New: group-states.json

```typescript
{
  "groupChatId1": {
    groupId: string,
    createdAt: Date,
    updatedAt: Date,
    metadata: {
      name?: string,
      description?: string
    },
    participants: {
      "0x123...": {
        address: string,
        joinedAt: Date,
        lastActiveAt: Date,
        status: "active" | "invited" | "inactive",
        preferences: UserPreferences,

        // Per-user progress within this group
        coinLaunchProgress?: CoinLaunchProgress,
        onboardingProgress?: OnboardingProgress,
        managementProgress?: ManagementProgress,
        pendingTransaction?: PendingTransaction
      }
    },
    managers: GroupManager[],    // Deployed managers for this group
    coins: GroupCoin[]           // Launched coins for this group
  }
}
```

## New Type Definitions

### GroupState Interface

```typescript
export interface GroupState {
  groupId: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    name?: string;
    description?: string;
  };
  participants: Record<string, GroupParticipant>; // keyed by user address
  managers: GroupManager[];
  coins: GroupCoin[];
}

export interface GroupParticipant {
  address: string;
  joinedAt: Date;
  lastActiveAt: Date;
  status: "active" | "invited" | "inactive";
  preferences: UserPreferences;

  // Flow progress states
  coinLaunchProgress?: CoinLaunchProgress;
  onboardingProgress?: OnboardingProgress;
  managementProgress?: ManagementProgress;
  pendingTransaction?: PendingTransaction;
}

export interface GroupManager {
  contractAddress: string;
  deployedAt: Date;
  txHash: string;
  deployedBy: string; // user address who deployed
  chainId: number;
  chainName: "base" | "baseSepolia";
  receivers: Array<{
    username: string;
    resolvedAddress: string;
    percentage: number;
  }>;
  // Live data from API
  liveData?: {
    recipients: Array<{
      recipient: string;
      recipientShare: string;
    }>;
    totalFeesUSDC: string;
    totalCoins: number;
    lastUpdated: Date;
  };
}

export interface GroupCoin {
  ticker: string;
  name: string;
  image: string;
  contractAddress: string;
  txHash: string;
  launchedAt: Date;
  launchedBy: string; // user address who launched
  chainId: number;
  chainName: "base" | "baseSepolia";

  // Launch parameters
  fairLaunchDuration: number;
  fairLaunchPercent: number;
  initialMarketCap: number;

  // Associated manager
  managerAddress: string;

  // Live data from API
  liveData?: {
    totalHolders: number;
    marketCapUSDC: string;
    priceChangePercentage: string;
    totalFeesUSDC: string;
    lastUpdated: Date;
  };
}
```

## Migration Tasks

### Phase 1: Create New Type System ✅ COMPLETED

- [x] **Task 1.1**: Create `src/core/types/GroupState.ts` with new interfaces
- [x] **Task 1.2**: Create `src/core/storage/GroupStateStorage.ts` interface and file implementation
- [x] **Task 1.3**: Update `src/core/types/FlowContext.ts` to use new group state structure
- [x] **Task 1.4**: Create migration utility `src/utils/migrationUtils.ts`

### Phase 2: Update Storage Layer ✅ COMPLETED

- [x] **Task 2.1**: Create `GroupStateManager` to replace user-centric SessionManager methods
- [x] **Task 2.2**: Update `StateStorage` to handle group states
- [x] **Task 2.3**: Create `FileGroupStateStorage` implementation
- [x] **Task 2.4**: Update `SessionManager` to work with both user prefs and group states

### Phase 3: Update Core Services ✅ COMPLETED

- [x] **Task 3.1**: Update `EnhancedMessageCoordinator` to use group state context
- [x] **Task 3.2**: Update `FlowRouter` to work with group-centric data
- [x] **Task 3.3**: Update `GroupStorageService` to use new group state structure
- [x] **Task 3.4**: Update `UserDataService` to aggregate data from group states
- [x] **Task 3.5**: Update all messaging classes (ThreadManager, etc.) to use group context

### Phase 4: Update Flow Classes ✅ COMPLETED

- [x] **Task 4.1**: Update `CoinLaunchFlow` to work with group-centric storage
- [x] **Task 4.2**: Update `ManagementFlow` to work with group-centric storage
- [x] **Task 4.3**: Update `QAFlow` to aggregate user data from group states
- [x] **Task 4.4**: Update flow context creation and state management

### Phase 5: Update Main Application ✅ COMPLETED

- [x] **Task 5.1**: Update `main.ts` to initialize new architecture
- [x] **Task 5.2**: Add migration logic to handle existing user-states.json
- [x] **Task 5.3**: Update all utility functions and helpers
- [x] **Task 5.4**: Comprehensive testing and validation

### Phase 6: Data Migration & Cleanup ⏳ NEXT

- [ ] **Task 6.1**: Create migration script to convert existing user-states.json
- [ ] **Task 6.2**: Backup existing data before migration
- [ ] **Task 6.3**: Validate migrated data integrity
- [ ] **Task 6.4**: Remove user-states.json dependencies

## Current Status: Phase 4 Completed ✅ - All TypeScript Errors Fixed

All flow classes have been successfully updated to work with the new group-centric architecture with full TypeScript compliance:

### **CoinLaunchFlow Updates:**

- ✅ Updated to use `participantState.pendingTransaction` and `participantState.coinLaunchProgress`
- ✅ Fixed all optional `userState` references with proper null checks
- ✅ Updated deprecated state management patterns

### **ManagementFlow Updates:**

- ✅ Updated to use `getUserAggregatedData()` with correct `allGroups`/`allCoins` properties
- ✅ Updated all `groupState` references to `participantState` for transaction/progress management
- ✅ Fixed AggregatedUserData property access patterns
- ✅ Added proper null checking for optional userState

### **QAFlow Updates:**

- ✅ Updated to use aggregated user data with correct property names (`allGroups`, `allCoins`)
- ✅ Fixed participant state access for progress tracking
- ✅ Updated status inquiry logic to use group-centric data
- ✅ Proper handling of optional userState references

### **Key Architectural Fixes:**

- ✅ All flows now properly distinguish between `groupState` (group-level) and `participantState` (user-level within group)
- ✅ Corrected AggregatedUserData interface usage (`allGroups`, `allCoins` instead of `groups`, `coins`)
- ✅ Added comprehensive null-safety for optional context properties
- ✅ Updated all state update calls to use appropriate methods (`updateParticipantState` vs `updateGroupState`)

**TypeScript Compliance:** All flow files now compile without errors and follow the new type-safe group-centric architecture.

## Phase 5 Completed ✅ - Main Application Updated

The main application has been successfully updated to use the new group-centric architecture:

### **Main Application Updates:**

- ✅ **Updated main.ts initialization**: Now properly initializes both user state storage and group state storage
- ✅ **Enhanced migration logic**: Automatic detection and migration from user-states.json to group-states.json
- ✅ **Hybrid architecture support**: SessionManager now supports both old and new architectures during transition
- ✅ **Migration mode detection**: Automatically enables migration mode when both storage types exist

### **Utility Function Updates:**

- ✅ **Updated GroupCreationUtils**: Fixed `formatGroupDisplay` and `formatGroupDisplayWithENS` functions to use aggregated data instead of userState
- ✅ **Maintained backward compatibility**: All existing utility functions continue to work while using new data structures

### **Key Architectural Improvements:**

- ✅ **Dual storage initialization**: Both FileStateStorage (user-states.json) and FileGroupStateStorage (group-states.json) are initialized
- ✅ **Smart migration detection**: Automatically detects when migration is needed and executes it
- ✅ **Hybrid operation mode**: SessionManager can operate with both old and new data during transition
- ✅ **Graceful fallback**: If migration fails, system continues with existing user-states.json

### **Migration Flow in main.ts:**

1. **Detect existing files**: Check for user-states.json and group-states.json
2. **Auto-migrate**: If only user-states.json exists, automatically migrate to group-states.json
3. **Initialize dual storage**: Set up both storage systems for hybrid operation
4. **Configure SessionManager**: Enable migration mode if needed for smooth transition
5. **Provide feedback**: Clear logging about which architecture mode is active

### **Testing and Validation:**

- ✅ **TypeScript compilation**: All files compile successfully with no errors
- ✅ **BaseFlow.ts fixes**: Updated to use new group-centric architecture (participantState vs userState)
- ✅ **Property access fixes**: Corrected access to onboardingProgress, pendingTransaction, and other participant-specific properties
- ✅ **Type safety verification**: All type definitions align with new architecture patterns

**Current Status:** Phase 5 fully completed ✅ - Ready for Phase 6 testing in production environment.

## Implementation Strategy

### Sequential Implementation

1. **Build new alongside old**: Create new system without breaking existing
2. **Gradual migration**: Update one flow at a time
3. **Maintain compatibility**: Keep both systems working during transition
4. **Validate thoroughly**: Test each component before proceeding

### Key Principles

- **Type Safety**: Strict TypeScript types, no `any` usage
- **No Breaking Changes**: Bot functionality must continue working
- **Data Integrity**: No loss of existing state data
- **Performance**: Efficient group state lookups and updates

## Critical Changes Required

### SessionManager Replacement

```typescript
// Old: SessionManager.getUserState(userId)
// New: GroupStateManager.getGroupState(groupId)
//      GroupStateManager.getParticipantState(groupId, userAddress)
```

### Flow Context Updates

```typescript
// Old: FlowContext.userState, FlowContext.groupState (derived from user)
// New: FlowContext.groupState, FlowContext.participantState
```

### Storage Pattern Changes

```typescript
// Old: Store in user.groupStates[groupId]
// New: Store in groups[groupId].participants[userAddress]
```

## File Modification List

### Core Type Files

- `src/core/types/GroupState.ts` (NEW)
- `src/core/types/FlowContext.ts` (UPDATE)
- `src/core/types/UserState.ts` (UPDATE - reduce scope)

### Storage Files

- `src/core/storage/GroupStateStorage.ts` (NEW)
- `src/core/storage/StateStorage.ts` (UPDATE)
- `src/core/session/SessionManager.ts` (MAJOR UPDATE)

### Service Files

- `src/services/GroupStorageService.ts` (MAJOR UPDATE)
- `src/services/UserDataService.ts` (MAJOR UPDATE)
- `src/services/ENSResolverService.ts` (MINOR UPDATE)
- `src/services/GraphQLService.ts` (MINOR UPDATE)

### Flow Files

- `src/flows/coin-launch/CoinLaunchFlow.ts` (MAJOR UPDATE)
- `src/flows/management/ManagementFlow.ts` (MAJOR UPDATE)
- `src/flows/qa/QAFlow.ts` (MAJOR UPDATE)

### Core Messaging Files

- `src/core/messaging/EnhancedMessageCoordinator.ts` (UPDATE)
- `src/core/messaging/ThreadManager.ts` (UPDATE)
- `src/core/messaging/GroupEnsurer.ts` (UPDATE)
- `src/core/messaging/TransactionReferenceHandler.ts` (UPDATE)

### Main Application

- `src/main.ts` (MINOR UPDATE)

### Utility Files

- `src/utils/migrationUtils.ts` (NEW)
- Various helper files (MINOR UPDATES)

## Migration Data Flow

```
user-states.json → migration script → group-states.json
                                  ↓
                               validation
                                  ↓
                              backup old
                                  ↓
                            update references
```

## Risk Mitigation

1. **Data Backup**: Full backup before migration
2. **Rollback Plan**: Keep old system functional during transition
3. **Incremental Testing**: Test each component individually
4. **State Validation**: Verify data integrity at each step
5. **Type Safety**: Comprehensive TypeScript validation

## Success Criteria

- [ ] All existing bot functionality works unchanged
- [ ] Group-centric data organization achieved
- [ ] Multiple managers per group supported
- [ ] Multiple coins per group supported
- [ ] Per-user interaction tracking within groups
- [ ] No data loss during migration
- [ ] Type-safe implementation
- [ ] Performance maintained or improved

## Next Steps

1. **Phase 1**: Start with creating new type definitions
2. **Get approval**: Review plan with team before implementation
3. **Sequential execution**: Follow phases in order
4. **Continuous testing**: Validate each step before proceeding

---

_This migration plan ensures zero downtime and maintains all existing functionality while transitioning to a more logical group-centric architecture._

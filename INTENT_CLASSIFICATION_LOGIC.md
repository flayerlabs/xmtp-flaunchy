# Intent Classification Logic - Group Creation

## ✅ **Corrected Logic**

### **Group Creation Intent Routing**

#### **First Group (Onboarding)**
- **Condition**: User mentions "group" AND has 0 existing groups
- **Route**: `onboarding` → OnboardingFlow
- **Examples**: 
  - `"ok let's launch a group for me and 0x908..."`
  - `"create a group"`
  - `"launch a group"`

#### **Additional Groups (Management)**
- **Condition**: User mentions "group" AND has 1+ existing groups  
- **Route**: `management` → ManagementFlow → `create_group` action
- **Examples**:
  - `"create another group"`
  - `"launch a new group"`
  - `"set up a different group"`

#### **Coin Launch**
- **Condition**: User mentions coin details (name/ticker) AND has existing groups
- **Route**: `coin_launch` → CoinLaunchFlow
- **Examples**:
  - `"launch MyCoin (MCN)"`
  - `"create DogeCoin token"`

## **Updated IntentClassifier Rules**

```
RULES:
- If user mentions "group" explicitly AND has NO existing groups → onboarding
- If user mentions "group" explicitly AND has existing groups → management (new group creation)
- If user has NO groups and mentions launching/creating anything → onboarding
- If user has groups and mentions launching/creating coins (with coin name/ticker) → coin_launch
```

## **Flow Capabilities**

### **OnboardingFlow**
- ✅ First group creation
- ✅ Fee receiver collection
- ✅ "Add everyone" functionality
- ✅ Group deployment (TODO: implement actual AddressFeeSplitManager)

### **ManagementFlow** 
- ✅ List existing groups/coins
- ✅ Add coins to existing groups
- ✅ **NEW**: Create additional groups (`create_group` action)
- 🚧 **TODO**: Implement actual group creation logic for existing users

### **CoinLaunchFlow**
- ✅ Launch coins into existing groups
- ✅ Group selection for multi-group users

## **User Experience Examples**

### **New User (First Group)**
```
User: "ok let's launch a group for me and 0x908..."
→ Intent: onboarding (0 groups)
→ Flow: OnboardingFlow
→ Action: Group creation with fee receivers
```

### **Existing User (Additional Group)**
```
User: "create another group with different people"  
→ Intent: management (has existing groups)
→ Flow: ManagementFlow
→ Action: create_group
→ Response: Ask for new group's fee receivers
```

### **Existing User (Coin Launch)**
```
User: "launch MyCoin (MCN)"
→ Intent: coin_launch (has groups + coin pattern)
→ Flow: CoinLaunchFlow  
→ Action: Launch coin into existing group
```

## **Key Benefits**

1. **Context-Aware**: Group creation behavior depends on user's current state
2. **Scalable**: Supports unlimited groups per user
3. **Clear Separation**: First group vs additional groups use appropriate flows
4. **Consistent**: Same fee receiver patterns work for all group creation 
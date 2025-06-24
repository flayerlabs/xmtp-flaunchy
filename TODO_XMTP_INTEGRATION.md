# XMTP Group Chat Integration TODO

## "Add Everyone" Functionality Implementation

### Current Status
✅ **Completed:**
- Added "add everyone" command detection in OnboardingFlow
- Updated Flaunchy's character knowledge about group chat integration
- Added message examples for group chat tagging
- Created mock implementation for testing

### 🚧 **TODO: Implement Actual XMTP Conversation Member Extraction**

#### Location: `src/flows/onboarding/OnboardingFlow.ts` - `handleAddEveryone()` method

#### Current Mock Implementation:
```typescript
// TODO: Get all participants from the XMTP conversation
// For now, create a mock implementation
const allParticipants = [
  // Mock participants - replace with actual XMTP conversation member extraction
  { username: 'member1', resolvedAddress: '0x1234567890123456789012345678901234567890' },
  { username: 'member2', resolvedAddress: '0x2345678901234567890123456789012345678901' },
  { username: 'member3', resolvedAddress: '0x3456789012345678901234567890123456789012' }
];
```

#### Need to Implement:
1. **Extract conversation members** from XMTP conversation object
2. **Get member addresses** from XMTP participant data
3. **Resolve usernames** if available (Farcaster, ENS)
4. **Handle edge cases:**
   - Single-person "group" (1v1 chat)
   - Bot should exclude itself from fee receivers
   - Empty conversations
   - Permission errors

#### Suggested Implementation:
```typescript
private async getAllConversationMembers(context: FlowContext): Promise<Array<{username: string, resolvedAddress: string}>> {
  if (!context.conversation) {
    throw new Error('No conversation context available');
  }

  // Get conversation participants from XMTP
  const participants = await context.conversation.getParticipants();
  
  // Filter out the bot's own address
  const botAddress = await context.client.getAddress();
  const memberAddresses = participants.filter(addr => addr.toLowerCase() !== botAddress.toLowerCase());
  
  // Resolve usernames for each address
  const members = await Promise.all(
    memberAddresses.map(async (address) => {
      const username = await this.resolveAddressToUsername(address); // TODO: Implement
      return {
        username: username || `${address.slice(0, 6)}...${address.slice(-4)}`,
        resolvedAddress: address
      };
    })
  );
  
  return members;
}
```

### Additional Features to Consider:
- **Group chat detection**: Warn if used in 1v1 chat
- **Member count validation**: Ensure reasonable number of participants
- **Permission handling**: Graceful fallback if can't access member list
- **Real-time updates**: Handle members joining/leaving during setup

### Testing Scenarios:
- [ ] 1v1 chat (should warn user)
- [ ] Small group chat (2-5 members)
- [ ] Large group chat (10+ members)
- [ ] Group chat with bot as only member
- [ ] Permission denied scenarios 
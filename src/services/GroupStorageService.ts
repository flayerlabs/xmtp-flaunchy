import { SessionManager } from '../core/session/SessionManager';
import { UserGroup, UserState } from '../core/types/UserState';
import { GroupCreationUtils, FeeReceiver } from '../flows/utils/GroupCreationUtils';

/**
 * Service to handle storing groups for all receivers
 * When a group is created, all receivers should have access to it
 */
export class GroupStorageService {
  constructor(private sessionManager: SessionManager) {}

  /**
   * Store a group for all receivers
   * This ensures all group members can see the group when they ask "what groups do I have"
   */
  async storeGroupForAllReceivers(
    creatorUserId: string,
    contractAddress: string,
    receivers: FeeReceiver[],
    chainId: number,
    chainName: 'base' | 'baseSepolia',
    txHash: string
  ): Promise<string> {
    // Generate a fun group name
    const groupName = GroupCreationUtils.generateGroupName(receivers);
    
    console.log('🏪 Storing group for all receivers:', {
      creatorUserId,
      contractAddress,
      groupName,
      receiverCount: receivers.length,
      chainName
    });

    // Create the group object
    const newGroup: UserGroup = {
      id: contractAddress,
      name: groupName,
      createdBy: creatorUserId,
      type: 'username_split',
      receivers: receivers.map(r => ({
        username: r.username,
        resolvedAddress: r.resolvedAddress!,
        percentage: r.percentage || 0
      })),
      coins: [],
      chainId,
      chainName,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Get all unique receiver addresses (including creator)
    const allReceiverAddresses = new Set<string>();
    allReceiverAddresses.add(creatorUserId); // Creator always gets the group
    
    for (const receiver of receivers) {
      if (receiver.resolvedAddress) {
        allReceiverAddresses.add(receiver.resolvedAddress.toLowerCase());
      }
    }

    console.log('📝 Adding group to user states:', {
      groupName,
      contractAddress,
      totalUsers: allReceiverAddresses.size,
      addresses: Array.from(allReceiverAddresses)
    });

    // Store the group for each receiver
    const promises = Array.from(allReceiverAddresses).map(async (address) => {
      try {
        // Get the user's current state
        const userState = await this.sessionManager.getUserState(address);
        
        // Check if they already have this group (avoid duplicates)
        const existingGroup = userState.groups.find(g => g.id === contractAddress);
        if (existingGroup) {
          console.log(`⚠️ Group ${contractAddress} already exists for user ${address}`);
          return;
        }

        // Add the group to their groups array
        await this.sessionManager.updateUserState(address, {
          groups: [
            ...userState.groups,
            newGroup
          ]
        });

        console.log(`✅ Added group "${groupName}" to user ${address}`);
      } catch (error) {
        console.error(`❌ Failed to add group to user ${address}:`, error);
        // Continue with other users even if one fails
      }
    });

    // Wait for all promises to complete
    await Promise.allSettled(promises);
    
    console.log(`Group "${groupName}" stored for all ${allReceiverAddresses.size} receivers`);
    
    return groupName;
  }



  /**
   * Remove a group from all receivers (if needed for cleanup)
   */
  async removeGroupFromAllReceivers(contractAddress: string): Promise<void> {
    // This would be used for cleanup if needed
    // For now, we'll keep it simple and not implement removal
    console.log(`🗑️ Group removal not implemented for ${contractAddress}`);
  }
} 
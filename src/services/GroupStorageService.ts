import { SessionManager } from '../core/session/SessionManager';
import { UserGroup, UserState, UserCoin } from '../core/types/UserState';
import { GroupCreationUtils, FeeReceiver } from '../flows/utils/GroupCreationUtils';

/**
 * Service to handle storing groups for all receivers
 * When a group is created, all receivers should have access to it
 * Groups are stored by Ethereum addresses since that's the on-chain identity that matters
 */
export class GroupStorageService {
  constructor(private sessionManager: SessionManager) {}

  /**
   * Store a group for all receivers by their Ethereum addresses
   * This ensures all group members can see the group when they ask "what groups do I have"
   * Uses Ethereum addresses since that's the actual on-chain identity for fee distribution
   */
  async storeGroupForAllReceivers(
    creatorInboxId: string,
    creatorAddress: string,
    contractAddress: string,
    receivers: FeeReceiver[],
    chainId: number,
    chainName: 'base' | 'baseSepolia',
    txHash: string
  ): Promise<string> {
    // Generate a fun group name
    const groupName = GroupCreationUtils.generateGroupName(receivers);
    
    // Create the group object
    const newGroup: UserGroup = {
      id: contractAddress,
      name: groupName,
      createdBy: creatorInboxId, // Keep for reference, but storage is by address
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

    // Collect all Ethereum addresses (including creator's address)
    const allAddresses = new Set<string>();
    
    // Add creator's address
    if (creatorAddress && creatorAddress.startsWith('0x') && creatorAddress.length === 42) {
      allAddresses.add(creatorAddress.toLowerCase());
    } else {
      console.warn(`⚠️ Invalid creator address: ${creatorAddress}`);
    }
    
    // Add all fee receiver addresses
    for (const receiver of receivers) {
      if (receiver.resolvedAddress && receiver.resolvedAddress.startsWith('0x') && receiver.resolvedAddress.length === 42) {
        allAddresses.add(receiver.resolvedAddress.toLowerCase());
      } else {
        console.warn(`⚠️ Invalid receiver address for ${receiver.username}: ${receiver.resolvedAddress}`);
      }
    }

    // Store the group for each address
    const promises = Array.from(allAddresses).map(async (address) => {
      try {
        // Check if user state exists in storage before getting it
        const userExists = await this.sessionManager.userExists(address);
        
        // Get user state by address (this creates new state if none exists)
        let userState = await this.sessionManager.getUserState(address);
        
        // If user didn't exist before (truly new), mark them as invited
        // This will trigger a welcome message when they first interact
        if (!userExists) {
          userState = await this.sessionManager.updateUserState(address, {
            status: 'invited'
          });
        }
        
        // Check if they already have this group (avoid duplicates)
        const existingGroup = userState.groups.find(g => g.id === contractAddress);
        if (existingGroup) {
          return;
        }

        // Add the group to their groups array
        await this.sessionManager.updateUserState(address, {
          groups: [
            ...userState.groups,
            newGroup
          ]
        });

      } catch (error) {
        console.error(`❌ Failed to add group to address ${address}:`, error);
        // Continue with other addresses even if one fails
      }
    });

    // Wait for all promises to complete
    await Promise.allSettled(promises);
    
    console.log(`[GroupStorageService] Stored "${groupName}" for ${allAddresses.size} addresses`);
    
    return groupName;
  }

  /**
   * Remove a group from all receivers (if needed for cleanup)
   */
  async removeGroupFromAllReceivers(contractAddress: string): Promise<void> {
    // This would be used for cleanup if needed
    // For now, we'll keep it simple and not implement removal
    console.log(`[GroupStorageService] Group removal not implemented for ${contractAddress}`);
  }

  /**
   * Add a coin to all members of a group
   * This ensures all group members see the coin when they ask "what groups do I have"
   */
  async addCoinToAllGroupMembers(
    groupId: string,
    coin: UserCoin,
    creatorAddress: string
  ): Promise<void> {
    try {
      // Get the creator's user state to find the group and its members
      const creatorState = await this.sessionManager.getUserState(creatorAddress);
      
      // Find the target group in the creator's groups
      const targetGroup = creatorState.groups.find(g => g.id.toLowerCase() === groupId.toLowerCase());
      
      if (!targetGroup) {
        console.error(`❌ Group ${groupId} not found in creator's state`);
        return;
      }

      // Collect all member addresses (receivers + creator)
      const allAddresses = new Set<string>();
      
      // Add creator's address
      allAddresses.add(creatorAddress.toLowerCase());
      
      // Add all receiver addresses
      for (const receiver of targetGroup.receivers) {
        if (receiver.resolvedAddress && receiver.resolvedAddress.startsWith('0x') && receiver.resolvedAddress.length === 42) {
          allAddresses.add(receiver.resolvedAddress.toLowerCase());
        }
      }

      // Add the coin to each member's state
      const promises = Array.from(allAddresses).map(async (address) => {
        try {
          const userState = await this.sessionManager.getUserState(address);
          
          // Check if they already have this coin (avoid duplicates)
          const existingCoin = userState.coins.find(c => 
            c.ticker === coin.ticker && c.groupId.toLowerCase() === groupId.toLowerCase()
          );
          if (existingCoin) {
            return;
          }

          // Add the coin to their coins array and update the group's coins list
          await this.sessionManager.updateUserState(address, {
            coins: [
              ...userState.coins,
              coin
            ],
            groups: userState.groups.map(group => 
              group.id.toLowerCase() === groupId.toLowerCase()
                ? { ...group, coins: [...group.coins, coin.ticker], updatedAt: new Date() }
                : group
            )
          });

        } catch (error) {
          console.error(`❌ Failed to add coin to address ${address}:`, error);
          // Continue with other addresses even if one fails
        }
      });

      // Wait for all promises to complete
      await Promise.allSettled(promises);
      
      console.log(`[GroupStorageService] Added "${coin.ticker}" to ${allAddresses.size} group members`);
      
    } catch (error) {
      console.error(`❌ Failed to add coin to all group members for group ${groupId}:`, error);
      throw error;
    }
  }

  /**
   * Get all member addresses for a group by finding the group in any user's state
   * This is a workaround for the current architecture limitation
   */
  private async getGroupMemberAddresses(groupId: string): Promise<{ addresses: string[], group: UserGroup | null }> {
    // This is a placeholder - we need a better way to track group membership
    // For now, we'll return empty to avoid breaking the system
    return { addresses: [], group: null };
  }
} 
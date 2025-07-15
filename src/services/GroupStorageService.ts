import { SessionManager } from "../core/session/SessionManager";
import { UserGroup, UserState, UserCoin } from "../core/types/UserState";
import {
  GroupCreationUtils,
  FeeReceiver,
} from "../flows/utils/GroupCreationUtils";

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
    chainName: "base" | "baseSepolia",
    txHash: string
  ): Promise<string> {
    // Generate a fun group name
    const groupName = GroupCreationUtils.generateGroupName(receivers);

    // Create the group object
    const newGroup: UserGroup = {
      id: contractAddress,
      name: groupName,
      createdBy: creatorInboxId, // Keep for reference, but storage is by address
      type: "username_split",
      receivers: receivers.map((r) => ({
        username: r.username,
        resolvedAddress: r.resolvedAddress!,
        percentage: r.percentage || 0,
      })),
      coins: [],
      chainId,
      chainName,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Collect all Ethereum addresses (including creator's address)
    const allAddresses = new Set<string>();

    console.log(
      `[GroupStorageService] Collecting addresses for group ${contractAddress}`
    );

    // Add creator's address
    if (
      creatorAddress &&
      creatorAddress.startsWith("0x") &&
      creatorAddress.length === 42
    ) {
      allAddresses.add(creatorAddress.toLowerCase());
      console.log(
        `[GroupStorageService] ✅ Added creator address: ${creatorAddress}`
      );
    } else {
      console.warn(`⚠️ Invalid creator address: ${creatorAddress}`);
    }

    // Add all fee receiver addresses
    for (const receiver of receivers) {
      if (
        receiver.resolvedAddress &&
        receiver.resolvedAddress.startsWith("0x") &&
        receiver.resolvedAddress.length === 42
      ) {
        allAddresses.add(receiver.resolvedAddress.toLowerCase());
        console.log(
          `[GroupStorageService] ✅ Added receiver address: ${receiver.resolvedAddress} (${receiver.username})`
        );
      } else {
        console.warn(
          `⚠️ Invalid receiver address for ${receiver.username}: ${receiver.resolvedAddress}`
        );
      }
    }

    console.log(
      `[GroupStorageService] Total addresses to update: ${allAddresses.size}`
    );
    console.log(
      `[GroupStorageService] Addresses: ${Array.from(allAddresses).join(", ")}`
    );

    // Store the group for each address
    const promises = Array.from(allAddresses).map(async (address) => {
      try {
        console.log(`[GroupStorageService] Processing address: ${address}`);

        // Check if user state exists in storage before getting it
        const userExists = await this.sessionManager.userExists(address);
        console.log(
          `[GroupStorageService] User ${address} exists: ${userExists}`
        );

        // Get user state by address (this creates new state if none exists)
        let userState = await this.sessionManager.getUserState(address);
        console.log(
          `[GroupStorageService] User ${address} current groups: ${userState.groups.length}`
        );

        // If user didn't exist before (truly new), mark them as invited
        // This will trigger a welcome message when they first interact
        if (!userExists) {
          userState = await this.sessionManager.updateUserState(address, {
            status: "invited",
          });
          console.log(
            `[GroupStorageService] Marked new user ${address} as invited`
          );
        }

        // Check if they already have this group (avoid duplicates)
        const existingGroup = userState.groups.find(
          (g) => g.id === contractAddress
        );
        if (existingGroup) {
          console.log(
            `[GroupStorageService] User ${address} already has group ${contractAddress} - skipping`
          );
          return;
        }

        // Add the group to their groups array
        await this.sessionManager.updateUserState(address, {
          groups: [...userState.groups, newGroup],
        });

        console.log(
          `[GroupStorageService] ✅ Added group ${contractAddress} to user ${address}`
        );
      } catch (error) {
        console.error(`❌ Failed to add group to address ${address}:`, error);
        // Continue with other addresses even if one fails
      }
    });

    // Wait for all promises to complete
    await Promise.allSettled(promises);

    console.log(
      `[GroupStorageService] Stored "${groupName}" for ${allAddresses.size} addresses`
    );

    return groupName;
  }

  /**
   * Remove a group from all receivers (if needed for cleanup)
   */
  async removeGroupFromAllReceivers(contractAddress: string): Promise<void> {
    // This would be used for cleanup if needed
    // For now, we'll keep it simple and not implement removal
    console.log(
      `[GroupStorageService] Group removal not implemented for ${contractAddress}`
    );
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
      console.log(
        `[CoinAddition] Adding coin "${coin.ticker}" to all members of group ${groupId}`
      );

      // Get the creator's user state to find the group and its members
      const creatorState = await this.sessionManager.getUserState(
        creatorAddress
      );

      console.log(
        `[CoinAddition] Creator ${creatorAddress} has ${creatorState.groups.length} groups`
      );
      console.log(
        `[CoinAddition] Creator's groups: ${creatorState.groups
          .map((g) => g.id)
          .join(", ")}`
      );

      // Find the target group in the creator's groups
      const targetGroup = creatorState.groups.find(
        (g) => g.id.toLowerCase() === groupId.toLowerCase()
      );

      if (!targetGroup) {
        console.error(`❌ Group ${groupId} not found in creator's state`);
        console.error(
          `❌ Available groups: ${creatorState.groups
            .map((g) => g.id)
            .join(", ")}`
        );
        return;
      }

      console.log(
        `[CoinAddition] ✅ Found target group: ${targetGroup.name} (${targetGroup.id})`
      );
      console.log(
        `[CoinAddition] Target group has ${targetGroup.receivers.length} receivers`
      );

      // Collect all member addresses (receivers + creator)
      const allAddresses = new Set<string>();

      // Add creator's address
      allAddresses.add(creatorAddress.toLowerCase());

      // Add all receiver addresses
      for (const receiver of targetGroup.receivers) {
        if (
          receiver.resolvedAddress &&
          receiver.resolvedAddress.startsWith("0x") &&
          receiver.resolvedAddress.length === 42
        ) {
          allAddresses.add(receiver.resolvedAddress.toLowerCase());
        }
      }

      // Add the coin to each member's state
      const promises = Array.from(allAddresses).map(async (address) => {
        try {
          console.log(
            `[CoinAddition] Processing coin addition for address: ${address}`
          );

          let userState = await this.sessionManager.getUserState(address);

          console.log(
            `[CoinAddition] User ${address} has ${userState.coins.length} coins and ${userState.groups.length} groups`
          );

          // Check if they already have this coin (avoid duplicates)
          const existingCoin = userState.coins.find(
            (c) =>
              c.ticker === coin.ticker &&
              c.groupId.toLowerCase() === groupId.toLowerCase()
          );
          if (existingCoin) {
            console.log(
              `[CoinAddition] User ${address} already has coin ${coin.ticker} - skipping`
            );
            return;
          }

          // Check if they have the group - if not, add it
          let userGroup = userState.groups.find(
            (g) => g.id.toLowerCase() === groupId.toLowerCase()
          );
          if (!userGroup) {
            console.warn(
              `[CoinAddition] ⚠️ User ${address} doesn't have group ${groupId} - adding it first`
            );

            // Create a basic group object for this user
            const basicGroup = {
              id: groupId,
              name: targetGroup.name,
              createdBy: targetGroup.createdBy,
              type: targetGroup.type,
              receivers: targetGroup.receivers,
              coins: [],
              chainId: targetGroup.chainId,
              chainName: targetGroup.chainName,
              createdAt: new Date(),
              updatedAt: new Date(),
            };

            // Add the group to the user
            await this.sessionManager.updateUserState(address, {
              groups: [...userState.groups, basicGroup],
            });

            console.log(
              `[CoinAddition] ✅ Added group ${groupId} to user ${address}`
            );

            // Update userState to include the new group
            userState = await this.sessionManager.getUserState(address);
            userGroup = userState.groups.find(
              (g) => g.id.toLowerCase() === groupId.toLowerCase()
            );
          }

          // Add the coin to their coins array and update the group's coins list
          await this.sessionManager.updateUserState(address, {
            coins: [...userState.coins, coin],
            groups: userState.groups.map((group) =>
              group.id.toLowerCase() === groupId.toLowerCase()
                ? {
                    ...group,
                    coins: [...group.coins, coin.ticker],
                    updatedAt: new Date(),
                  }
                : group
            ),
          });

          console.log(
            `[CoinAddition] ✅ Added coin ${coin.ticker} to user ${address}`
          );
        } catch (error) {
          console.error(`❌ Failed to add coin to address ${address}:`, error);
          // Continue with other addresses even if one fails
        }
      });

      // Wait for all promises to complete
      await Promise.allSettled(promises);

      console.log(
        `[GroupStorageService] Added "${coin.ticker}" to ${allAddresses.size} group members`
      );
    } catch (error) {
      console.error(
        `❌ Failed to add coin to all group members for group ${groupId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get all member addresses for a group by finding the group in any user's state
   * This is a workaround for the current architecture limitation
   */
  private async getGroupMemberAddresses(
    groupId: string
  ): Promise<{ addresses: string[]; group: UserGroup | null }> {
    // This is a placeholder - we need a better way to track group membership
    // For now, we'll return empty to avoid breaking the system
    return { addresses: [], group: null };
  }
}

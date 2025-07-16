import type { Client, Conversation } from "@xmtp/node-sdk";
import { SessionManager } from "../session/SessionManager";
import { GroupStorageService } from "../../services/GroupStorageService";
import { ENSResolverService } from "../../services/ENSResolverService";

/**
 * Service for ensuring groups exist for chat rooms and managing group creation
 * Handles creating groups when they don't exist and managing group membership
 */
export class GroupEnsurer {
  constructor(
    private client: Client<any>,
    private sessionManager: SessionManager,
    private groupStorageService: GroupStorageService,
    private ensResolverService: ENSResolverService
  ) {}

  /**
   * Ensure that a group exists in the user state for all chat room members
   * This creates the group if it doesn't exist
   */
  async ensureGroupExistsForChatRoom(
    conversation: Conversation<any>,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia"
  ): Promise<void> {
    try {
      // Get all chat room members
      const members = await conversation.members();

      // Generate a fun group name
      const groupName = `Chat Room ${groupAddress.slice(
        0,
        6
      )}...${groupAddress.slice(-4)}`;

      // Get all member addresses and create receivers array
      const receivers = [];
      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            receivers.push({
              username: `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1), // Equal split excluding bot
            });
          }
        }
      }

      // Create the group object
      const newGroup = {
        id: groupAddress,
        name: groupName,
        createdBy: "unknown", // Conversation creator info not available
        type: "username_split" as const,
        receivers,
        coins: [],
        chainId,
        chainName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Add the group to all members who don't have it
      const promises = receivers.map(async (receiver) => {
        const userState = await this.sessionManager.getUserState(
          receiver.resolvedAddress
        );

        // Check if they already have this group
        const existingGroup = userState.groups.find(
          (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
        );

        if (!existingGroup) {
          await this.sessionManager.addGroup(
            receiver.resolvedAddress,
            newGroup
          );
        }
      });

      await Promise.all(promises);

      console.log(
        `[GroupCreation] Created group ${groupAddress} for ${receivers.length} members`
      );
    } catch (error) {
      console.error(`Failed to ensure group exists for chat room:`, error);
    }
  }

  /**
   * Ensure that a group exists properly for chat room coin launches
   * This uses GroupStorageService to create the group with proper structure
   */
  async ensureGroupExistsForChatRoomLaunch(
    conversation: Conversation<any>,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia",
    creatorAddress: string
  ): Promise<void> {
    try {
      console.log(
        `[GroupCreation] Ensuring group ${groupAddress} exists for chat room launch`
      );

      // Check if the creator already has this group
      const creatorState = await this.sessionManager.getUserState(
        creatorAddress
      );
      const existingGroup = creatorState.groups.find(
        (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
      );

      if (existingGroup) {
        console.log(
          `[GroupCreation] Group ${groupAddress} already exists for creator - skipping creation`
        );
        return;
      }

      // Get all chat room members
      const members = await conversation.members();
      console.log(
        `[GroupCreation] Found ${members.length} total members (including bot)`
      );

      // Get all member addresses and create receivers array
      const receivers = [];
      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await this.ensResolverService.resolveSingleAddress(
                  memberAddress
                );
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              // If resolution fails, use shortened address as fallback
              username = `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`;
            }

            receivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1), // Equal split excluding bot
            });

            console.log(
              `[GroupCreation] Added receiver: ${username} (${memberAddress})`
            );
          }
        }
      }

      if (receivers.length === 0) {
        console.error(
          "❌ No valid receivers found for chat room group creation"
        );
        return;
      }

      console.log(
        `[GroupCreation] Created ${receivers.length} receivers for group ${groupAddress}`
      );
      console.log(`[GroupCreation] Creator address: ${creatorAddress}`);

      // Use GroupStorageService to create the group properly
      const groupName =
        await this.groupStorageService.storeGroupForAllReceivers(
          "unknown", // Conversation creator info not available
          creatorAddress,
          groupAddress,
          receivers,
          chainId,
          chainName,
          "chat-room-launch" // Use a placeholder tx hash for chat room launches
        );

      console.log(
        `[GroupCreation] ✅ Created group "${groupName}" (${groupAddress}) for ${receivers.length} chat room members`
      );

      // Verify the group was created for the creator
      const updatedCreatorState = await this.sessionManager.getUserState(
        creatorAddress
      );
      const creatorGroup = updatedCreatorState.groups.find(
        (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
      );

      if (creatorGroup) {
        console.log(
          `[GroupCreation] ✅ Verified group exists in creator's state`
        );
      } else {
        console.error(
          `[GroupCreation] ❌ CRITICAL: Group NOT found in creator's state after creation`
        );
        console.error(
          `[GroupCreation] Creator's groups: ${updatedCreatorState.groups
            .map((g) => g.id)
            .join(", ")}`
        );
      }
    } catch (error) {
      console.error(
        `Failed to ensure group exists for chat room launch:`,
        error
      );
    }
  }

  /**
   * Forcefully ensure a group exists for the creator and all chat room members
   * This is a fallback method that doesn't check if the group exists first
   */
  async forcefullyEnsureGroupForChatRoom(
    conversation: Conversation<any>,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia",
    creatorAddress: string
  ): Promise<void> {
    try {
      console.log(
        `[ForcefulGroupCreation] Forcefully ensuring group ${groupAddress} exists for all chat room members`
      );

      // Get all chat room members
      const members = await conversation.members();

      // Get all member addresses and create receivers array
      const receivers = [];
      const allAddresses = new Set<string>();

      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            allAddresses.add(memberAddress.toLowerCase());

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await this.ensResolverService.resolveSingleAddress(
                  memberAddress
                );
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              username = `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`;
            }

            receivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1),
            });
          }
        }
      }

      // Generate a group name
      const groupName = `Chat Room ${groupAddress.slice(
        0,
        6
      )}...${groupAddress.slice(-4)}`;

      // Create the group object
      const newGroup = {
        id: groupAddress,
        name: groupName,
        createdBy: "unknown", // Conversation creator info not available
        type: "username_split" as const,
        receivers,
        coins: [],
        chainId,
        chainName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Forcefully add the group to all addresses
      for (const address of allAddresses) {
        try {
          const userState = await this.sessionManager.getUserState(address);

          // Check if they already have this group
          const existingGroup = userState.groups.find(
            (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
          );

          if (!existingGroup) {
            await this.sessionManager.updateUserState(address, {
              groups: [...userState.groups, newGroup],
            });
            console.log(
              `[ForcefulGroupCreation] ✅ Added group ${groupAddress} to user ${address}`
            );
          } else {
            console.log(
              `[ForcefulGroupCreation] User ${address} already has group ${groupAddress}`
            );
          }
        } catch (error) {
          console.error(
            `[ForcefulGroupCreation] ❌ Failed to add group to ${address}:`,
            error
          );
        }
      }

      console.log(
        `[ForcefulGroupCreation] ✅ Forcefully ensured group ${groupAddress} exists for all chat room members`
      );
    } catch (error) {
      console.error(
        `[ForcefulGroupCreation] ❌ Failed to forcefully ensure group exists:`,
        error
      );
    }
  }

  /**
   * Check if a group exists for a user
   */
  async groupExistsForUser(
    userAddress: string,
    groupAddress: string
  ): Promise<boolean> {
    try {
      const userState = await this.sessionManager.getUserState(userAddress);
      const existingGroup = userState.groups.find(
        (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
      );
      return !!existingGroup;
    } catch (error) {
      console.error("Error checking if group exists for user:", error);
      return false;
    }
  }

  /**
   * Get all group members for a specific group
   */
  async getGroupMembers(groupAddress: string): Promise<string[]> {
    try {
      // This would require scanning all user states to find group members
      // For now, return empty array - full implementation would need more context
      console.log(`Getting members for group ${groupAddress}`);
      return [];
    } catch (error) {
      console.error("Error getting group members:", error);
      return [];
    }
  }

  /**
   * Validate group data before creation
   */
  validateGroupData(
    groupAddress: string,
    receivers: Array<{
      username: string;
      resolvedAddress: string;
      percentage: number;
    }>
  ): { isValid: boolean; error?: string } {
    if (!groupAddress || !groupAddress.startsWith("0x")) {
      return { isValid: false, error: "Invalid group address" };
    }

    if (!receivers || receivers.length === 0) {
      return { isValid: false, error: "No receivers provided" };
    }

    // Check if percentages add up to ~100%
    const totalPercentage = receivers.reduce((sum, r) => sum + r.percentage, 0);
    if (Math.abs(totalPercentage - 100) > 1) {
      return {
        isValid: false,
        error: `Percentages must add up to 100%, got ${totalPercentage}%`,
      };
    }

    // Check for valid addresses
    for (const receiver of receivers) {
      if (
        !receiver.resolvedAddress ||
        !receiver.resolvedAddress.startsWith("0x")
      ) {
        return {
          isValid: false,
          error: `Invalid address for ${receiver.username}: ${receiver.resolvedAddress}`,
        };
      }
    }

    return { isValid: true };
  }
}

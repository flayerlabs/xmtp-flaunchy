import * as fs from "fs/promises";
import * as path from "path";
import { UserState, UserGroup, UserCoin } from "../core/types/UserState";
import {
  GroupChatState,
  GroupStatesStorage,
  GroupParticipant,
  GroupManager,
  GroupCoin,
} from "../core/types/GroupState";

/**
 * Migration utility to convert from user-states.json to group-states.json
 */
export class MigrationUtils {
  /**
   * Main migration function - converts user-states.json to group-states.json
   */
  static async migrateUserStatesToGroupStates(
    userStatesPath: string = ".data/user-states.json",
    groupStatesPath: string = ".data/group-states.json",
    backupPath?: string
  ): Promise<{
    success: boolean;
    groupsCreated: number;
    participantsAdded: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let groupsCreated = 0;
    let participantsAdded = 0;

    try {
      // Step 1: Backup existing user-states.json
      if (backupPath) {
        await this.backupUserStates(userStatesPath, backupPath);
        console.log(`✅ Created backup at ${backupPath}`);
      }

      // Step 2: Load existing user states
      const userStates = await this.loadUserStates(userStatesPath);
      console.log(`📂 Loaded ${userStates.size} user states`);

      if (userStates.size === 0) {
        return {
          success: true,
          groupsCreated: 0,
          participantsAdded: 0,
          errors: [],
        };
      }

      // Step 3: Convert to group-centric structure
      const groupStates = await this.convertToGroupStates(userStates);
      groupsCreated = Object.keys(groupStates).length;

      // Count total participants
      for (const groupState of Object.values(groupStates)) {
        participantsAdded += Object.keys(groupState.participants).length;
      }

      console.log(
        `🔄 Converted to ${groupsCreated} group states with ${participantsAdded} total participants`
      );

      // Step 4: Save new group states
      await this.saveGroupStates(groupStates, groupStatesPath);
      console.log(`💾 Saved group states to ${groupStatesPath}`);

      return { success: true, groupsCreated, participantsAdded, errors };
    } catch (error) {
      errors.push(`Migration failed: ${error}`);
      console.error("❌ Migration failed:", error);
      return { success: false, groupsCreated, participantsAdded, errors };
    }
  }

  /**
   * Create backup of existing user-states.json
   */
  static async backupUserStates(
    sourcePath: string,
    backupPath: string
  ): Promise<void> {
    try {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(sourcePath, backupPath);
    } catch (error) {
      if ((error as any).code !== "ENOENT") {
        throw error;
      }
      // Source file doesn't exist, no backup needed
    }
  }

  /**
   * Load and parse user states from user-states.json
   */
  static async loadUserStates(
    filePath: string
  ): Promise<Map<string, UserState>> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);

      const states = new Map<string, UserState>();
      for (const [userId, state] of Object.entries(parsed)) {
        const userState = state as any;

        // Convert dates back to Date objects (similar to current FileStateStorage)
        states.set(userId, {
          ...userState,
          createdAt: new Date(userState.createdAt),
          updatedAt: new Date(userState.updatedAt),
          coins:
            userState.coins?.map((coin: any) => ({
              ...coin,
              createdAt: new Date(coin.createdAt),
            })) || [],
          groups:
            userState.groups?.map((group: any) => ({
              ...group,
              createdAt: new Date(group.createdAt),
              updatedAt: new Date(group.updatedAt),
            })) || [],
        });
      }

      return states;
    } catch (error) {
      if ((error as any).code === "ENOENT") {
        // File doesn't exist, return empty map
        return new Map();
      }
      throw error;
    }
  }

  /**
   * Convert user-centric states to group-centric states
   */
  static async convertToGroupStates(
    userStates: Map<string, UserState>
  ): Promise<GroupStatesStorage> {
    const groupStates: GroupStatesStorage = {};

    // Track groups we've already processed to avoid duplicates
    const processedGroups = new Set<string>();

    // Map to track which group chat ID corresponds to which manager/group
    const groupIdToGroupChatId = new Map<string, string>();

    // First pass: Create group chat states and collect group-to-groupChatId mappings
    for (const [userAddress, userState] of userStates.entries()) {
      // Process chatRoomManagers to create group chat mappings
      if (userState.chatRoomManagers) {
        for (const [chatRoomId, managerAddress] of Object.entries(
          userState.chatRoomManagers
        )) {
          if (!groupStates[chatRoomId]) {
            groupStates[chatRoomId] = {
              groupId: chatRoomId,
              metadata: {},
              participants: {},
              managers: [],
              coins: [],
            };
          }

          // Map manager address to this group chat
          groupIdToGroupChatId.set(managerAddress, chatRoomId);
        }
      }

      // Process user's groups to infer group chat IDs
      for (const userGroup of userState.groups) {
        // Try to find which group chat this group belongs to
        let groupChatId = groupIdToGroupChatId.get(userGroup.id);

        if (!groupChatId) {
          // If we can't find a mapping, use the group ID as the group chat ID
          // This is a fallback for cases where chatRoomManagers mapping is incomplete
          groupChatId = userGroup.id;
          groupIdToGroupChatId.set(userGroup.id, groupChatId);
        }

        if (!groupStates[groupChatId]) {
          groupStates[groupChatId] = {
            groupId: groupChatId,
            metadata: {
              name: userGroup.name,
            },
            participants: {},
            managers: [],
            coins: [],
          };
        }

        // Add this group as a manager if not already added
        if (
          !groupStates[groupChatId].managers.find(
            (m) => m.contractAddress === userGroup.id
          )
        ) {
          const groupManager: GroupManager = {
            contractAddress: userGroup.id,
            deployedAt: userGroup.createdAt,
            txHash: "", // We don't have this from UserGroup
            deployedBy: userGroup.createdBy,
            chainId: userGroup.chainId,
            receivers: userGroup.receivers,
            liveData: userGroup.liveData,
          };

          groupStates[groupChatId].managers.push(groupManager);
        }
      }
    }

    // Second pass: Add participants and their states to group chats
    for (const [userAddress, userState] of userStates.entries()) {
      // Add this user as a participant to all groups they belong to
      for (const userGroup of userState.groups) {
        const groupChatId =
          groupIdToGroupChatId.get(userGroup.id) || userGroup.id;

        if (
          groupStates[groupChatId] &&
          !groupStates[groupChatId].participants[userAddress]
        ) {
          const participant: GroupParticipant = {
            address: userAddress,
            joinedAt: userState.createdAt,
            lastActiveAt: userState.updatedAt,
            status:
              userState.status === "new"
                ? "inactive"
                : userState.status === "invited"
                ? "invited"
                : "active",
            preferences: userState.preferences,
          };

          // Add group-specific progress states if they exist
          if (userState.groupStates?.[groupChatId]) {
            const groupState = userState.groupStates[groupChatId];
            participant.coinLaunchProgress = groupState.coinLaunchProgress;
            participant.pendingTransaction = groupState.pendingTransaction;
          }

          groupStates[groupChatId].participants[userAddress] = participant;
        }
      }

      // Also add participants based on chatRoomManagers
      if (userState.chatRoomManagers) {
        for (const [chatRoomId] of Object.entries(userState.chatRoomManagers)) {
          if (
            groupStates[chatRoomId] &&
            !groupStates[chatRoomId].participants[userAddress]
          ) {
            const participant: GroupParticipant = {
              address: userAddress,
              joinedAt: userState.createdAt,
              lastActiveAt: userState.updatedAt,
              status:
                userState.status === "new"
                  ? "inactive"
                  : userState.status === "invited"
                  ? "invited"
                  : "active",
              preferences: userState.preferences,
            };

            // Add group-specific progress states if they exist
            if (userState.groupStates?.[chatRoomId]) {
              const groupState = userState.groupStates[chatRoomId];
              participant.coinLaunchProgress = groupState.coinLaunchProgress;
              participant.pendingTransaction = groupState.pendingTransaction;
            }

            groupStates[chatRoomId].participants[userAddress] = participant;
          }
        }
      }
    }

    // Third pass: Add coins to appropriate group chats
    for (const [userAddress, userState] of userStates.entries()) {
      for (const userCoin of userState.coins) {
        // Find which group chat this coin belongs to
        const groupChatId =
          groupIdToGroupChatId.get(userCoin.groupId) || userCoin.groupId;

        if (groupStates[groupChatId]) {
          // Check if coin already exists in this group
          const existingCoin = groupStates[groupChatId].coins.find(
            (c) => c.ticker === userCoin.ticker
          );

          if (!existingCoin) {
            const groupCoin: GroupCoin = {
              ticker: userCoin.ticker,
              name: userCoin.name,
              image: userCoin.image,
              contractAddress: userCoin.contractAddress || "",
              txHash: userCoin.txHash || "",
              launchedAt: userCoin.createdAt,
              launchedBy: userAddress, // Assume this user launched it
              chainId: userCoin.chainId,
              fairLaunchDuration: userCoin.fairLaunchDuration,
              fairLaunchPercent: userCoin.fairLaunchPercent,
              initialMarketCap: userCoin.initialMarketCap,
              managerAddress: userCoin.groupId, // The group this coin is associated with
              liveData: userCoin.liveData,
            };

            groupStates[groupChatId].coins.push(groupCoin);
          }
        }
      }
    }

    return groupStates;
  }

  /**
   * Save group states to group-states.json
   */
  static async saveGroupStates(
    groupStates: GroupStatesStorage,
    filePath: string
  ): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(groupStates, null, 2));
    } catch (error) {
      console.error("Failed to save group states:", error);
      throw error;
    }
  }

  /**
   * Validate the migrated data
   */
  static async validateMigration(
    originalUserStatesPath: string,
    newGroupStatesPath: string
  ): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      // Load both data sets
      const userStates = await this.loadUserStates(originalUserStatesPath);
      const groupStatesData = await fs.readFile(newGroupStatesPath, "utf-8");
      const groupStates: GroupStatesStorage = JSON.parse(groupStatesData);

      // Count totals from original data
      let originalUsers = userStates.size;
      let originalGroups = 0;
      let originalCoins = 0;

      for (const userState of userStates.values()) {
        originalGroups += userState.groups.length;
        originalCoins += userState.coins.length;
      }

      // Count totals from migrated data
      const migratedGroupChats = Object.keys(groupStates).length;
      let migratedParticipants = 0;
      let migratedManagers = 0;
      let migratedCoins = 0;

      for (const groupState of Object.values(groupStates)) {
        migratedParticipants += Object.keys(groupState.participants).length;
        migratedManagers += groupState.managers.length;
        migratedCoins += groupState.coins.length;
      }

      console.log(`📊 Migration validation:`);
      console.log(
        `   Original: ${originalUsers} users, ${originalGroups} groups, ${originalCoins} coins`
      );
      console.log(
        `   Migrated: ${migratedGroupChats} group chats, ${migratedParticipants} participants, ${migratedManagers} managers, ${migratedCoins} coins`
      );

      // Basic validation checks
      if (migratedParticipants === 0 && originalUsers > 0) {
        issues.push("No participants found in migrated data");
      }

      if (migratedManagers === 0 && originalGroups > 0) {
        issues.push("No managers found in migrated data");
      }

      return { valid: issues.length === 0, issues };
    } catch (error) {
      issues.push(`Validation failed: ${error}`);
      return { valid: false, issues };
    }
  }

  /**
   * Cleanup old user-states.json after successful migration
   */
  static async cleanupOldUserStates(userStatesPath: string): Promise<void> {
    try {
      await fs.unlink(userStatesPath);
      console.log(`🗑️ Cleaned up old user states file: ${userStatesPath}`);
    } catch (error) {
      console.warn(`⚠️ Could not cleanup old user states file: ${error}`);
    }
  }
}

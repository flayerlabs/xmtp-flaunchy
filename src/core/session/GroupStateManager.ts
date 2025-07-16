import {
  GroupChatState,
  GroupParticipant,
  GroupManager,
  GroupCoin,
  AggregatedUserData,
  GroupStateUpdate,
  ParticipantStateUpdate,
} from "../types/GroupState";
import { UserPreferences } from "../types/UserState";
import { GroupStateStorage } from "../storage/GroupStateStorage";

/**
 * GroupStateManager handles all group-centric state operations
 * Replaces user-centric methods from SessionManager for the new architecture
 */
export class GroupStateManager {
  constructor(private groupStateStorage: GroupStateStorage) {}

  /**
   * Get full group state for a group chat
   */
  async getGroupState(groupId: string): Promise<GroupChatState | null> {
    return await this.groupStateStorage.getGroupState(groupId);
  }

  /**
   * Create or update group state
   */
  async setGroupState(groupId: string, state: GroupChatState): Promise<void> {
    await this.groupStateStorage.setGroupState(groupId, state);
  }

  /**
   * Get participant state within a specific group
   */
  async getParticipantState(
    groupId: string,
    participantAddress: string
  ): Promise<GroupParticipant | null> {
    return await this.groupStateStorage.getParticipant(
      groupId,
      participantAddress
    );
  }

  /**
   * Create or update participant state within a group
   */
  async setParticipantState(
    groupId: string,
    participantAddress: string,
    participant: GroupParticipant
  ): Promise<void> {
    await this.groupStateStorage.setParticipant(
      groupId,
      participantAddress,
      participant
    );
  }

  /**
   * Initialize a new group with a participant
   */
  async initializeGroup(
    groupId: string,
    participantAddress: string,
    metadata: { name?: string; description?: string } = {}
  ): Promise<GroupChatState> {
    const now = new Date();

    // Create new group state
    const groupState: GroupChatState = {
      groupId,
      createdAt: now,
      updatedAt: now,
      metadata,
      participants: {},
      managers: [],
      coins: [],
    };

    // Create initial participant
    const participant: GroupParticipant = {
      address: participantAddress,
      joinedAt: now,
      lastActiveAt: now,
      status: "active",
      preferences: {
        defaultMarketCap: 1000,
        defaultFairLaunchPercent: 10,
        defaultFairLaunchDuration: 30 * 60, // 30 minutes
        notificationSettings: {
          launchUpdates: true,
          priceAlerts: true,
        },
      },
    };

    groupState.participants[participantAddress] = participant;

    await this.setGroupState(groupId, groupState);
    return groupState;
  }

  /**
   * Add a participant to an existing group
   */
  async addParticipant(
    groupId: string,
    participantAddress: string,
    status: GroupParticipant["status"] = "active",
    preferences?: UserPreferences
  ): Promise<void> {
    let groupState = await this.getGroupState(groupId);

    if (!groupState) {
      // Create new group if it doesn't exist
      groupState = await this.initializeGroup(groupId, participantAddress);
      return;
    }

    // Don't overwrite existing participant
    if (groupState.participants[participantAddress]) {
      // Just update last active time
      groupState.participants[participantAddress].lastActiveAt = new Date();
      await this.setGroupState(groupId, groupState);
      return;
    }

    const now = new Date();
    const participant: GroupParticipant = {
      address: participantAddress,
      joinedAt: now,
      lastActiveAt: now,
      status,
      preferences: preferences || {
        defaultMarketCap: 1000,
        defaultFairLaunchPercent: 10,
        defaultFairLaunchDuration: 30 * 60,
        notificationSettings: {
          launchUpdates: true,
          priceAlerts: true,
        },
      },
    };

    groupState.participants[participantAddress] = participant;
    groupState.updatedAt = now;

    await this.setGroupState(groupId, groupState);
  }

  /**
   * Update participant state (progress, preferences, etc.)
   */
  async updateParticipantState(
    groupId: string,
    participantAddress: string,
    updates: Partial<Omit<GroupParticipant, "address" | "joinedAt">>
  ): Promise<GroupParticipant | null> {
    const currentParticipant = await this.getParticipantState(
      groupId,
      participantAddress
    );

    if (!currentParticipant) {
      // Create participant if they don't exist
      await this.addParticipant(groupId, participantAddress);
      return await this.getParticipantState(groupId, participantAddress);
    }

    const updatedParticipant: GroupParticipant = {
      ...currentParticipant,
      ...updates,
      lastActiveAt: new Date(),
    };

    await this.setParticipantState(
      groupId,
      participantAddress,
      updatedParticipant
    );
    return updatedParticipant;
  }

  /**
   * Clear participant progress states (coin launch, onboarding, etc.)
   */
  async clearParticipantProgress(
    groupId: string,
    participantAddress: string
  ): Promise<void> {
    await this.updateParticipantState(groupId, participantAddress, {
      coinLaunchProgress: undefined,
      onboardingProgress: undefined,
      managementProgress: undefined,
      pendingTransaction: undefined,
    });
  }

  /**
   * Add a manager to a group
   */
  async addManager(groupId: string, manager: GroupManager): Promise<void> {
    await this.groupStateStorage.addManager(groupId, manager);
  }

  /**
   * Get all managers for a group
   */
  async getManagers(groupId: string): Promise<GroupManager[]> {
    return await this.groupStateStorage.getManagers(groupId);
  }

  /**
   * Add a coin to a group
   */
  async addCoin(groupId: string, coin: GroupCoin): Promise<void> {
    await this.groupStateStorage.addCoin(groupId, coin);
  }

  /**
   * Get all coins for a group
   */
  async getCoins(groupId: string): Promise<GroupCoin[]> {
    return await this.groupStateStorage.getCoins(groupId);
  }

  /**
   * Get aggregated user data from all groups they participate in
   * Used for backwards compatibility and user-specific queries
   */
  async getAggregatedUserData(
    participantAddress: string
  ): Promise<AggregatedUserData> {
    const groupsForUser = await this.groupStateStorage.getGroupsForParticipant(
      participantAddress
    );

    // Determine overall user status
    let overallStatus: AggregatedUserData["status"] = "new";
    let globalPreferences: UserPreferences = {
      defaultMarketCap: 1000,
      defaultFairLaunchPercent: 10,
      defaultFairLaunchDuration: 30 * 60,
      notificationSettings: {
        launchUpdates: true,
        priceAlerts: true,
      },
    };

    const allGroups: AggregatedUserData["allGroups"] = [];
    const allCoins: AggregatedUserData["allCoins"] = [];
    const activeProgressStates: AggregatedUserData["activeProgressStates"] = [];

    for (const { groupId, state } of groupsForUser) {
      const participant = state.participants[participantAddress];

      if (participant) {
        // Update overall status (priority: active > onboarding > invited > new)
        if (
          participant.status === "active" ||
          (participant.status === "onboarding" && overallStatus !== "active") ||
          (participant.status === "invited" &&
            !["active", "onboarding"].includes(overallStatus))
        ) {
          overallStatus = participant.status;
        }

        // Use latest preferences
        if (participant.preferences) {
          globalPreferences = {
            ...globalPreferences,
            ...participant.preferences,
          };
        }

        // Add group info
        allGroups.push({
          groupId,
          groupName: state.metadata.name,
          managers: state.managers,
          participantStatus: participant.status,
          joinedAt: participant.joinedAt,
        });

        // Add coins from this group
        for (const coin of state.coins) {
          allCoins.push({
            coin,
            groupId,
            groupName: state.metadata.name,
          });
        }

        // Add active progress states
        if (participant.coinLaunchProgress) {
          activeProgressStates.push({
            groupId,
            type: "coinLaunch",
            state: participant.coinLaunchProgress,
          });
        }
        if (participant.onboardingProgress) {
          activeProgressStates.push({
            groupId,
            type: "onboarding",
            state: participant.onboardingProgress,
          });
        }
        if (participant.managementProgress) {
          activeProgressStates.push({
            groupId,
            type: "management",
            state: participant.managementProgress,
          });
        }
        if (participant.pendingTransaction) {
          activeProgressStates.push({
            groupId,
            type: "pendingTransaction",
            state: participant.pendingTransaction,
          });
        }
      }
    }

    return {
      userId: participantAddress,
      status: overallStatus,
      globalPreferences,
      allGroups,
      allCoins,
      activeProgressStates,
    };
  }

  /**
   * Check if a participant exists in any group
   */
  async participantExistsInAnyGroup(
    participantAddress: string
  ): Promise<boolean> {
    const groups = await this.groupStateStorage.getGroupsForParticipant(
      participantAddress
    );
    return groups.length > 0;
  }

  /**
   * Get all groups a participant belongs to
   */
  async getGroupsForParticipant(
    participantAddress: string
  ): Promise<Array<{ groupId: string; state: GroupChatState }>> {
    return await this.groupStateStorage.getGroupsForParticipant(
      participantAddress
    );
  }

  /**
   * Update group metadata
   */
  async updateGroupMetadata(
    groupId: string,
    metadata: { name?: string; description?: string }
  ): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState) {
      groupState.metadata = { ...groupState.metadata, ...metadata };
      groupState.updatedAt = new Date();
      await this.setGroupState(groupId, groupState);
    }
  }

  /**
   * Remove a participant from a group
   */
  async removeParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<void> {
    await this.groupStateStorage.deleteParticipant(groupId, participantAddress);
  }

  /**
   * Delete entire group state
   */
  async deleteGroup(groupId: string): Promise<void> {
    await this.groupStateStorage.deleteGroupState(groupId);
  }

  /**
   * Get all group states (for admin/debugging purposes)
   */
  async getAllGroupStates(): Promise<Record<string, GroupChatState>> {
    return await this.groupStateStorage.getAllGroupStates();
  }

  /**
   * Batch update operations for efficiency
   */
  async batchUpdateParticipants(
    updates: ParticipantStateUpdate[]
  ): Promise<void> {
    const promises = updates.map((update) =>
      this.updateParticipantState(
        update.groupId,
        update.participantAddress,
        update.updates
      )
    );

    await Promise.all(promises);
  }

  /**
   * Health check - verify storage is accessible
   */
  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      await this.groupStateStorage.getAllGroupStates();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, error: `Storage error: ${error}` };
    }
  }
}

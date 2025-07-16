import {
  GroupChatState,
  GroupParticipant,
  AggregatedUserData,
} from "../types/GroupState";
import {
  GroupStateStorage,
  FileGroupStateStorage,
} from "../storage/GroupStateStorage";
import { GroupStateManager } from "./GroupStateManager";
import {
  PerUserState,
  UserCoinLaunch,
  UserGroupParticipation,
} from "../types/PerUserState";
import {
  PerUserStateStorage,
  FilePerUserStateStorage,
} from "../storage/PerUserStateStorage";

export class SessionManager {
  private groupStateManager: GroupStateManager;
  private perUserStateStorage: PerUserStateStorage;

  constructor(
    groupStateStorage: GroupStateStorage,
    perUserStateStorage?: PerUserStateStorage
  ) {
    this.groupStateManager = new GroupStateManager(groupStateStorage);
    this.perUserStateStorage =
      perUserStateStorage || new FilePerUserStateStorage();
  }

  // ================================
  // GROUP-CENTRIC METHODS
  // ================================

  /**
   * Get group state for new architecture
   */
  async getGroupChatState(groupId: string): Promise<GroupChatState | null> {
    return await this.groupStateManager.getGroupState(groupId);
  }

  /**
   * Get participant state within a group for new architecture
   */
  async getParticipantState(
    groupId: string,
    participantAddress: string
  ): Promise<GroupParticipant | null> {
    return await this.groupStateManager.getParticipantState(
      groupId,
      participantAddress
    );
  }

  /**
   * Update participant state in new architecture
   */
  async updateParticipantState(
    groupId: string,
    participantAddress: string,
    updates: Partial<Omit<GroupParticipant, "address" | "joinedAt">>
  ): Promise<GroupParticipant | null> {
    return await this.groupStateManager.updateParticipantState(
      groupId,
      participantAddress,
      updates
    );
  }

  /**
   * Clear participant progress states in new architecture
   */
  async clearParticipantProgress(
    groupId: string,
    participantAddress: string
  ): Promise<void> {
    await this.groupStateManager.clearParticipantProgress(
      groupId,
      participantAddress
    );
  }

  /**
   * Add participant to group in new architecture
   */
  async addParticipantToGroup(
    groupId: string,
    participantAddress: string,
    status: GroupParticipant["status"] = "active"
  ): Promise<void> {
    await this.groupStateManager.addParticipant(
      groupId,
      participantAddress,
      status
    );
  }

  /**
   * Get aggregated user data from all groups (backwards compatibility)
   */
  async getAggregatedUserData(
    participantAddress: string
  ): Promise<AggregatedUserData> {
    return await this.groupStateManager.getAggregatedUserData(
      participantAddress
    );
  }

  /**
   * Check if participant exists in any group
   */
  async participantExistsInAnyGroup(
    participantAddress: string
  ): Promise<boolean> {
    return await this.groupStateManager.participantExistsInAnyGroup(
      participantAddress
    );
  }

  /**
   * Get group states where participant is involved
   */
  async getGroupsForParticipant(participantAddress: string): Promise<
    Array<{
      groupId: string;
      state: GroupChatState;
    }>
  > {
    return await this.groupStateManager.getGroupsForParticipant(
      participantAddress
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
    return await this.groupStateManager.initializeGroup(
      groupId,
      participantAddress,
      metadata
    );
  }

  /**
   * Update group state
   */
  async updateGroupState(
    groupId: string,
    updates: Partial<GroupChatState>
  ): Promise<void> {
    const currentState = await this.getGroupChatState(groupId);
    if (currentState) {
      await this.groupStateManager.setGroupState(groupId, {
        ...currentState,
        ...updates,
        updatedAt: new Date(),
      });
    }
  }

  /**
   * Add manager to group
   */
  async addManagerToGroup(
    groupId: string,
    manager: GroupChatState["managers"][0]
  ): Promise<void> {
    await this.groupStateManager.addManager(groupId, manager);
  }

  /**
   * Add coin to group
   */
  async addCoinToGroup(
    groupId: string,
    coin: GroupChatState["coins"][0]
  ): Promise<void> {
    await this.groupStateManager.addCoin(groupId, coin);
  }

  /**
   * Provide access to group state manager for advanced operations
   */
  getGroupStateManager(): GroupStateManager {
    return this.groupStateManager;
  }

  // ================================
  // BACKWARDS COMPATIBILITY HELPERS
  // ================================

  /**
   * Check if user is new (backwards compatibility)
   */
  async isNewUser(userId: string): Promise<boolean> {
    const aggregatedData = await this.getAggregatedUserData(userId);
    return aggregatedData.status === "new";
  }

  /**
   * Check if user exists (backwards compatibility)
   */
  async userExists(userId: string): Promise<boolean> {
    return await this.participantExistsInAnyGroup(userId);
  }

  /**
   * Check if user is onboarding (backwards compatibility)
   */
  async isOnboarding(userId: string): Promise<boolean> {
    const aggregatedData = await this.getAggregatedUserData(userId);
    return aggregatedData.status === "onboarding";
  }

  // ================================
  // PER-USER STATE METHODS
  // ================================

  /**
   * Get per-user state for cross-group tracking
   */
  async getPerUserState(userAddress: string): Promise<PerUserState | null> {
    return await this.perUserStateStorage.getUserState(userAddress);
  }

  /**
   * Ensure a user exists in per-user state system
   */
  async ensureUserExists(
    userAddress: string,
    groupId?: string
  ): Promise<PerUserState> {
    let userState = await this.perUserStateStorage.getUserState(userAddress);

    if (!userState) {
      // Create new per-user state
      userState = {
        userAddress,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "new",
        preferences: {
          defaultMarketCap: 1000,
          defaultFairLaunchPercent: 10,
          defaultFairLaunchDuration: 30 * 60,
          notificationSettings: {
            launchUpdates: true,
            priceAlerts: true,
          },
        },
        coinsLaunchedHistory: [],
        groupParticipations: [],
      };

      await this.perUserStateStorage.setUserState(userAddress, userState);
    }

    // If groupId is provided, ensure user participation is tracked
    if (groupId) {
      await this.ensureGroupParticipationTracked(userAddress, groupId);
    }

    return userState;
  }

  /**
   * Ensure group participation is tracked in per-user state
   */
  async ensureGroupParticipationTracked(
    userAddress: string,
    groupId: string
  ): Promise<void> {
    const userState = await this.ensureUserExists(userAddress);

    // Check if participation already exists
    const existingParticipation = userState.groupParticipations.find(
      (p) => p.groupId === groupId
    );

    if (!existingParticipation) {
      const participation: UserGroupParticipation = {
        groupId,
        joinedAt: new Date(),
        status: "active",
        coinsLaunchedInGroup: 0,
        lastActiveAt: new Date(),
      };

      await this.perUserStateStorage.addGroupParticipation(
        userAddress,
        participation
      );
    }
  }

  /**
   * Record a successful coin launch in per-user history
   */
  async recordCoinLaunch(
    userAddress: string,
    coinData: {
      coinAddress: string;
      ticker: string;
      name: string;
      groupId: string;
      chainId: number;
      chainName: "base" | "baseSepolia";
      txHash?: string;
      initialMarketCap?: number;
    }
  ): Promise<void> {
    // Ensure user exists
    await this.ensureUserExists(userAddress, coinData.groupId);

    // Create coin launch record
    const coinLaunch: UserCoinLaunch = {
      ...coinData,
      launchedAt: new Date(),
    };

    // Add to user's coin launch history
    await this.perUserStateStorage.addCoinLaunch(userAddress, coinLaunch);

    // Update group participation to increment coins launched in this group
    const userState = await this.perUserStateStorage.getUserState(userAddress);
    if (userState) {
      const participation = userState.groupParticipations.find(
        (p) => p.groupId === coinData.groupId
      );
      if (participation) {
        await this.perUserStateStorage.updateGroupParticipation(
          userAddress,
          coinData.groupId,
          {
            coinsLaunchedInGroup: participation.coinsLaunchedInGroup + 1,
            lastActiveAt: new Date(),
          }
        );
      }
    }
  }

  /**
   * Update per-user state status
   */
  async updatePerUserStatus(
    userAddress: string,
    status: PerUserState["status"]
  ): Promise<void> {
    const userState = await this.ensureUserExists(userAddress);
    userState.status = status;
    userState.updatedAt = new Date();
    await this.perUserStateStorage.setUserState(userAddress, userState);
  }

  /**
   * Get user's coin launch history across all groups
   */
  async getUserCoinHistory(userAddress: string): Promise<UserCoinLaunch[]> {
    return await this.perUserStateStorage.getCoinLaunches(userAddress);
  }

  /**
   * Get user's group participation history
   */
  async getUserGroupHistory(
    userAddress: string
  ): Promise<UserGroupParticipation[]> {
    return await this.perUserStateStorage.getGroupParticipations(userAddress);
  }
}

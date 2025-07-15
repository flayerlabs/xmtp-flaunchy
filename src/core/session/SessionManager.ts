import { UserState, GroupState } from "../types/UserState";
import { StateStorage } from "../storage/StateStorage";
import { UserDataService } from "../../services/UserDataService";

export class SessionManager {
  private userDataService: UserDataService;

  constructor(private stateStore: StateStorage) {
    this.userDataService = new UserDataService();
  }

  async getUserState(userId: string): Promise<UserState> {
    let state = await this.stateStore.get(userId);

    if (!state) {
      // New user - initialize with onboarding state
      state = this.createNewUserState(userId);
      await this.stateStore.set(userId, state);
    }

    return state;
  }

  /**
   * Get group-specific state for a user in a specific group
   */
  async getGroupState(userId: string, groupId: string): Promise<GroupState> {
    const userState = await this.getUserState(userId);
    return userState.groupStates?.[groupId] || {};
  }

  /**
   * Update group-specific state for a user in a specific group
   */
  async updateGroupState(
    userId: string,
    groupId: string,
    updates: Partial<GroupState>
  ): Promise<UserState> {
    const userState = await this.getUserState(userId);

    // Initialize groupStates if it doesn't exist
    if (!userState.groupStates) {
      userState.groupStates = {};
    }

    // Initialize this group's state if it doesn't exist
    if (!userState.groupStates[groupId]) {
      userState.groupStates[groupId] = {};
    }

    // Update the group-specific state
    userState.groupStates[groupId] = {
      ...userState.groupStates[groupId],
      ...updates,
    };

    // Update the overall user state
    const newState = {
      ...userState,
      updatedAt: new Date(),
    };

    await this.stateStore.set(userId, newState);
    return newState;
  }

  /**
   * Clear group-specific state for a user in a specific group
   */
  async clearGroupState(userId: string, groupId: string): Promise<UserState> {
    const userState = await this.getUserState(userId);

    if (userState.groupStates?.[groupId]) {
      delete userState.groupStates[groupId];
    }

    const newState = {
      ...userState,
      updatedAt: new Date(),
    };

    await this.stateStore.set(userId, newState);
    return newState;
  }

  /**
   * Get user state with live data injected from API
   */
  async getUserStateWithLiveData(userId: string): Promise<UserState> {
    const state = await this.getUserState(userId);

    // Inject live data for users who have groups/coins, regardless of status
    // This ensures that users who have launched coins but are still "new" get live data
    if (state.groups.length > 0 || state.coins.length > 0) {
      try {
        console.log("💉 INJECTING LIVE DATA", {
          userId,
          status: state.status,
          groupCount: state.groups.length,
          coinCount: state.coins.length,
        });

        const enrichedState = await this.userDataService.injectGroupData(state);

        // Save the enriched state back to storage
        await this.stateStore.set(userId, enrichedState);

        return enrichedState;
      } catch (error) {
        console.error(
          "Failed to inject live data, returning cached state:",
          error
        );
        return state;
      }
    }

    return state;
  }

  async updateUserState(
    userId: string,
    updates: Partial<UserState>
  ): Promise<UserState> {
    const currentState = await this.getUserState(userId);
    const newState = {
      ...currentState,
      ...updates,
      updatedAt: new Date(),
    };

    await this.stateStore.set(userId, newState);
    return newState;
  }

  async isNewUser(userId: string): Promise<boolean> {
    const state = await this.stateStore.get(userId);
    return !state || state.status === "new";
  }

  async userExists(userId: string): Promise<boolean> {
    const state = await this.stateStore.get(userId);
    return !!state;
  }

  async isOnboarding(userId: string): Promise<boolean> {
    const state = await this.stateStore.get(userId);
    return state?.status === "onboarding";
  }

  async completeOnboarding(userId: string): Promise<UserState> {
    return this.updateUserState(userId, {
      status: "active",
    });
  }

  async resetUserState(userId: string): Promise<void> {
    await this.stateStore.delete(userId);
  }

  private createNewUserState(userId: string): UserState {
    const now = new Date();

    return {
      userId,
      status: "new",
      coins: [],
      groups: [],
      groupStates: {},
      preferences: {
        defaultMarketCap: 1000,
        defaultFairLaunchPercent: 10,
        defaultFairLaunchDuration: 30 * 60, // 30 minutes
        notificationSettings: {
          launchUpdates: true,
          priceAlerts: true,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  // Helper methods for onboarding flow
  async updateOnboardingStep(
    userId: string,
    step: "coin_creation" | "username_collection" | "completed"
  ): Promise<UserState> {
    const isCompleted = step === "completed";

    return this.updateUserState(userId, {
      status: isCompleted ? "active" : "onboarding",
    });
  }

  async updateCoinData(
    userId: string,
    coinData: Partial<{ name: string; ticker: string; image: string }>
  ): Promise<UserState> {
    // This method is deprecated - coin data should be updated per-group using updateGroupState
    console.warn("updateCoinData is deprecated - use updateGroupState instead");
    return this.getUserState(userId);
  }

  async updateSplitData(
    userId: string,
    splitData: {
      receivers: Array<{
        username: string;
        resolvedAddress?: string;
        percentage?: number;
      }>;
      equalSplit: boolean;
      creatorPercent?: number;
    }
  ): Promise<UserState> {
    // This method is deprecated - split data should be updated per-group using updateGroupState
    console.warn(
      "updateSplitData is deprecated - use updateGroupState instead"
    );
    return this.getUserState(userId);
  }

  async addCoin(
    userId: string,
    coin: Omit<UserState["coins"][0], "createdAt">
  ): Promise<UserState> {
    const state = await this.getUserState(userId);

    return this.updateUserState(userId, {
      coins: [
        ...state.coins,
        {
          ...coin,
          createdAt: new Date(),
        },
      ],
    });
  }

  async addGroup(
    userId: string,
    group: Omit<UserState["groups"][0], "createdAt" | "updatedAt">
  ): Promise<UserState> {
    const state = await this.getUserState(userId);
    const now = new Date();

    return this.updateUserState(userId, {
      groups: [
        ...state.groups,
        {
          ...group,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  }
}

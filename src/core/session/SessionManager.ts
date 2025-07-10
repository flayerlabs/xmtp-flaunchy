import { UserState } from "../types/UserState";
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
   * Get user state with live data injected from API
   */
  async getUserStateWithLiveData(userId: string): Promise<UserState> {
    const state = await this.getUserState(userId);

    // Only inject live data for active users with groups/coins
    if (
      state.status === "active" &&
      (state.groups.length > 0 || state.coins.length > 0)
    ) {
      try {
        console.log("💉 INJECTING LIVE DATA", {
          userId,
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
      onboardingProgress: undefined, // Clear onboarding progress completely when done
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
      onboardingProgress: {
        step: "coin_creation",
        startedAt: now,
        coinData: {},
      },
      coins: [],
      groups: [],
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
    const state = await this.getUserState(userId);
    const isCompleted = step === "completed";

    return this.updateUserState(userId, {
      status: isCompleted ? "active" : "onboarding",
      onboardingProgress: isCompleted
        ? undefined
        : {
            ...state.onboardingProgress!,
            step,
            completedAt: undefined,
          },
    });
  }

  async updateCoinData(
    userId: string,
    coinData: Partial<{ name: string; ticker: string; image: string }>
  ): Promise<UserState> {
    const state = await this.getUserState(userId);

    return this.updateUserState(userId, {
      onboardingProgress: {
        ...state.onboardingProgress!,
        coinData: {
          ...state.onboardingProgress!.coinData,
          ...coinData,
        },
      },
    });
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
    const state = await this.getUserState(userId);

    return this.updateUserState(userId, {
      onboardingProgress: {
        ...state.onboardingProgress!,
        splitData,
      },
    });
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

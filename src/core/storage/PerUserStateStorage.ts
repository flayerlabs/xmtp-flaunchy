import {
  PerUserState,
  UserCoinLaunch,
  UserGroupParticipation,
  PerUserStatesStorage,
} from "../types/PerUserState";

/**
 * Interface for per-user state storage operations
 * Manages user-specific data across all groups
 */
export interface PerUserStateStorage {
  // Basic CRUD operations for user states
  getUserState(userAddress: string): Promise<PerUserState | null>;
  setUserState(userAddress: string, state: PerUserState): Promise<void>;
  deleteUserState(userAddress: string): Promise<void>;
  userExists(userAddress: string): Promise<boolean>;

  // Coin launch operations
  addCoinLaunch(userAddress: string, coinLaunch: UserCoinLaunch): Promise<void>;
  getCoinLaunches(userAddress: string): Promise<UserCoinLaunch[]>;

  // Group participation operations
  addGroupParticipation(
    userAddress: string,
    participation: UserGroupParticipation
  ): Promise<void>;
  updateGroupParticipation(
    userAddress: string,
    groupId: string,
    updates: Partial<UserGroupParticipation>
  ): Promise<void>;
  getGroupParticipations(
    userAddress: string
  ): Promise<UserGroupParticipation[]>;

  // Bulk operations
  getAllUserStates(): Promise<PerUserStatesStorage>;
}

/**
 * In-memory implementation of PerUserStateStorage for testing
 */
export class MemoryPerUserStateStorage implements PerUserStateStorage {
  private storage = new Map<string, PerUserState>();

  async getUserState(userAddress: string): Promise<PerUserState | null> {
    return this.storage.get(userAddress) || null;
  }

  async setUserState(userAddress: string, state: PerUserState): Promise<void> {
    this.storage.set(userAddress, {
      ...state,
    });
  }

  async deleteUserState(userAddress: string): Promise<void> {
    this.storage.delete(userAddress);
  }

  async userExists(userAddress: string): Promise<boolean> {
    return this.storage.has(userAddress);
  }

  async addCoinLaunch(
    userAddress: string,
    coinLaunch: UserCoinLaunch
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      userState.coinsLaunchedHistory.push(coinLaunch);
      await this.setUserState(userAddress, userState);
    }
  }

  async getCoinLaunches(userAddress: string): Promise<UserCoinLaunch[]> {
    const userState = await this.getUserState(userAddress);
    return userState?.coinsLaunchedHistory || [];
  }

  async addGroupParticipation(
    userAddress: string,
    participation: UserGroupParticipation
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      userState.groupParticipations.push(participation);
      await this.setUserState(userAddress, userState);
    }
  }

  async updateGroupParticipation(
    userAddress: string,
    groupId: string,
    updates: Partial<UserGroupParticipation>
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      const participationIndex = userState.groupParticipations.findIndex(
        (p) => p.groupId === groupId
      );
      if (participationIndex >= 0) {
        userState.groupParticipations[participationIndex] = {
          ...userState.groupParticipations[participationIndex],
          ...updates,
        };
        await this.setUserState(userAddress, userState);
      }
    }
  }

  async getGroupParticipations(
    userAddress: string
  ): Promise<UserGroupParticipation[]> {
    const userState = await this.getUserState(userAddress);
    return userState?.groupParticipations || [];
  }

  async getAllUserStates(): Promise<PerUserStatesStorage> {
    return Object.fromEntries(this.storage.entries());
  }
}

/**
 * File-based implementation of PerUserStateStorage
 * Stores per-user states in per-user-states.json
 */
export class FilePerUserStateStorage implements PerUserStateStorage {
  constructor(private filePath: string = ".data/xmtp/per-user-states.json") {}

  private async loadData(): Promise<Map<string, PerUserState>> {
    try {
      const fs = await import("fs/promises");
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed: PerUserStatesStorage = JSON.parse(data);

      // Convert date strings back to Date objects
      const states = new Map<string, PerUserState>();

      for (const [userAddress, userState] of Object.entries(parsed)) {
        const convertedState: PerUserState = {
          ...userState,

          // Convert coin launch dates
          coinsLaunchedHistory: userState.coinsLaunchedHistory.map((coin) => ({
            ...coin,
            launchedAt: new Date(coin.launchedAt),
          })),

          // Convert group participation dates
          groupParticipations: userState.groupParticipations,
        };

        states.set(userAddress, convertedState);
      }

      return states;
    } catch (error) {
      // File doesn't exist or is invalid, return empty map
      return new Map();
    }
  }

  private async saveData(states: Map<string, PerUserState>): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      // Convert Map to object for JSON serialization
      const data: PerUserStatesStorage = Object.fromEntries(states.entries());
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Failed to save per-user state data:", error);
      throw error;
    }
  }

  async getUserState(userAddress: string): Promise<PerUserState | null> {
    const states = await this.loadData();
    return states.get(userAddress) || null;
  }

  async setUserState(userAddress: string, state: PerUserState): Promise<void> {
    const states = await this.loadData();
    states.set(userAddress, state);
    await this.saveData(states);
  }

  async deleteUserState(userAddress: string): Promise<void> {
    const states = await this.loadData();
    states.delete(userAddress);
    await this.saveData(states);
  }

  async userExists(userAddress: string): Promise<boolean> {
    const states = await this.loadData();
    return states.has(userAddress);
  }

  async addCoinLaunch(
    userAddress: string,
    coinLaunch: UserCoinLaunch
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      userState.coinsLaunchedHistory.push(coinLaunch);
      await this.setUserState(userAddress, userState);
    }
  }

  async getCoinLaunches(userAddress: string): Promise<UserCoinLaunch[]> {
    const userState = await this.getUserState(userAddress);
    return userState?.coinsLaunchedHistory || [];
  }

  async addGroupParticipation(
    userAddress: string,
    participation: UserGroupParticipation
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      // Check if participation already exists
      const existingIndex = userState.groupParticipations.findIndex(
        (p) => p.groupId === participation.groupId
      );

      if (existingIndex >= 0) {
        // Update existing participation
        userState.groupParticipations[existingIndex] = {
          ...userState.groupParticipations[existingIndex],
          ...participation,
        };
      } else {
        // Add new participation
        userState.groupParticipations.push(participation);
      }

      await this.setUserState(userAddress, userState);
    }
  }

  async updateGroupParticipation(
    userAddress: string,
    groupId: string,
    updates: Partial<UserGroupParticipation>
  ): Promise<void> {
    const userState = await this.getUserState(userAddress);
    if (userState) {
      const participationIndex = userState.groupParticipations.findIndex(
        (p) => p.groupId === groupId
      );
      if (participationIndex >= 0) {
        userState.groupParticipations[participationIndex] = {
          ...userState.groupParticipations[participationIndex],
          ...updates,
        };
        await this.setUserState(userAddress, userState);
      }
    }
  }

  async getGroupParticipations(
    userAddress: string
  ): Promise<UserGroupParticipation[]> {
    const userState = await this.getUserState(userAddress);
    return userState?.groupParticipations || [];
  }

  async getAllUserStates(): Promise<PerUserStatesStorage> {
    const states = await this.loadData();
    return Object.fromEntries(states.entries());
  }
}

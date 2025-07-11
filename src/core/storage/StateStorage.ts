import { UserState } from "../types/UserState";

export interface StateStorage {
  get(userId: string): Promise<UserState | null>;
  set(userId: string, state: UserState): Promise<void>;
  delete(userId: string): Promise<void>;
  exists(userId: string): Promise<boolean>;
}

export class MemoryStateStorage implements StateStorage {
  private storage = new Map<string, UserState>();

  async get(userId: string): Promise<UserState | null> {
    return this.storage.get(userId) || null;
  }

  async set(userId: string, state: UserState): Promise<void> {
    this.storage.set(userId, {
      ...state,
      updatedAt: new Date(),
    });
  }

  async delete(userId: string): Promise<void> {
    this.storage.delete(userId);
  }

  async exists(userId: string): Promise<boolean> {
    return this.storage.has(userId);
  }
}

export class FileStateStorage implements StateStorage {
  constructor(private filePath: string = ".data/user-states.json") {}

  private async loadData(): Promise<Map<string, UserState>> {
    try {
      const fs = await import("fs/promises");
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(data);

      // Convert date strings back to Date objects
      const states = new Map<string, UserState>();
      for (const [userId, state] of Object.entries(parsed)) {
        const userState = state as any;
        states.set(userId, {
          ...userState,
          createdAt: new Date(userState.createdAt),
          updatedAt: new Date(userState.updatedAt),
          onboardingProgress: userState.onboardingProgress
            ? {
                ...userState.onboardingProgress,
                startedAt: new Date(userState.onboardingProgress.startedAt),
                completedAt: userState.onboardingProgress.completedAt
                  ? new Date(userState.onboardingProgress.completedAt)
                  : undefined,
              }
            : undefined,
          managementProgress: userState.managementProgress
            ? {
                ...userState.managementProgress,
                startedAt: new Date(userState.managementProgress.startedAt),
              }
            : undefined,
          coinLaunchProgress: userState.coinLaunchProgress
            ? {
                ...userState.coinLaunchProgress,
                startedAt: new Date(userState.coinLaunchProgress.startedAt),
              }
            : undefined,
          coins: userState.coins.map((coin: any) => ({
            ...coin,
            createdAt: new Date(coin.createdAt),
          })),
          groups: userState.groups.map((group: any) => ({
            ...group,
            createdAt: new Date(group.createdAt),
            updatedAt: new Date(group.updatedAt),
          })),
        });
      }

      return states;
    } catch (error) {
      // File doesn't exist or is invalid, return empty map
      return new Map();
    }
  }

  private async saveData(states: Map<string, UserState>): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      // Convert Map to object for JSON serialization
      const data = Object.fromEntries(states.entries());
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Failed to save state data:", error);
      throw error;
    }
  }

  async get(userId: string): Promise<UserState | null> {
    const states = await this.loadData();
    return states.get(userId) || null;
  }

  async set(userId: string, state: UserState): Promise<void> {
    const states = await this.loadData();
    states.set(userId, {
      ...state,
      updatedAt: new Date(),
    });
    await this.saveData(states);
  }

  async delete(userId: string): Promise<void> {
    const states = await this.loadData();
    states.delete(userId);
    await this.saveData(states);
  }

  async exists(userId: string): Promise<boolean> {
    const states = await this.loadData();
    return states.has(userId);
  }
}

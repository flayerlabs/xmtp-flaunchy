import {
  GroupChatState,
  GroupStatesStorage,
  GroupParticipant,
  GroupManager,
  GroupCoin,
} from "../types/GroupState";

/**
 * Interface for group state storage operations
 * Manages group-centric data keyed by group chat ID
 */
export interface GroupStateStorage {
  // Basic CRUD operations for group states
  getGroupState(groupId: string): Promise<GroupChatState | null>;
  setGroupState(groupId: string, state: GroupChatState): Promise<void>;
  deleteGroupState(groupId: string): Promise<void>;
  groupExists(groupId: string): Promise<boolean>;

  // Participant operations within a group
  getParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<GroupParticipant | null>;
  setParticipant(
    groupId: string,
    participantAddress: string,
    participant: GroupParticipant
  ): Promise<void>;
  deleteParticipant(groupId: string, participantAddress: string): Promise<void>;
  participantExists(
    groupId: string,
    participantAddress: string
  ): Promise<boolean>;

  // Manager operations for a group
  addManager(groupId: string, manager: GroupManager): Promise<void>;
  getManagers(groupId: string): Promise<GroupManager[]>;

  // Coin operations for a group
  addCoin(groupId: string, coin: GroupCoin): Promise<void>;
  getCoins(groupId: string): Promise<GroupCoin[]>;

  // Bulk operations
  getAllGroupStates(): Promise<GroupStatesStorage>;
  setAllGroupStates(states: GroupStatesStorage): Promise<void>;
  getGroupsForParticipant(
    participantAddress: string
  ): Promise<Array<{ groupId: string; state: GroupChatState }>>;
}

/**
 * In-memory implementation of GroupStateStorage for testing
 */
export class MemoryGroupStateStorage implements GroupStateStorage {
  private storage = new Map<string, GroupChatState>();

  async getGroupState(groupId: string): Promise<GroupChatState | null> {
    return this.storage.get(groupId) || null;
  }

  async setGroupState(groupId: string, state: GroupChatState): Promise<void> {
    this.storage.set(groupId, {
      ...state,
    });
  }

  async deleteGroupState(groupId: string): Promise<void> {
    this.storage.delete(groupId);
  }

  async groupExists(groupId: string): Promise<boolean> {
    return this.storage.has(groupId);
  }

  async getParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<GroupParticipant | null> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.participants[participantAddress] || null;
  }

  async setParticipant(
    groupId: string,
    participantAddress: string,
    participant: GroupParticipant
  ): Promise<void> {
    let groupState = await this.getGroupState(groupId);

    if (!groupState) {
      // Create new group state if it doesn't exist
      groupState = {
        groupId,
        metadata: {},
        participants: {},
        managers: [],
        coins: [],
      };
    }

    groupState.participants[participantAddress] = participant;

    await this.setGroupState(groupId, groupState);
  }

  async deleteParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState && groupState.participants[participantAddress]) {
      delete groupState.participants[participantAddress];
      await this.setGroupState(groupId, groupState);
    }
  }

  async participantExists(
    groupId: string,
    participantAddress: string
  ): Promise<boolean> {
    const groupState = await this.getGroupState(groupId);
    return !!groupState?.participants[participantAddress];
  }

  async addManager(groupId: string, manager: GroupManager): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState) {
      groupState.managers.push(manager);
      await this.setGroupState(groupId, groupState);
    }
  }

  async getManagers(groupId: string): Promise<GroupManager[]> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.managers || [];
  }

  async addCoin(groupId: string, coin: GroupCoin): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState) {
      groupState.coins.push(coin);
      await this.setGroupState(groupId, groupState);
    }
  }

  async getCoins(groupId: string): Promise<GroupCoin[]> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.coins || [];
  }

  async getAllGroupStates(): Promise<GroupStatesStorage> {
    return Object.fromEntries(this.storage.entries());
  }

  async setAllGroupStates(states: GroupStatesStorage): Promise<void> {
    this.storage.clear();
    for (const [groupId, state] of Object.entries(states)) {
      this.storage.set(groupId, state);
    }
  }

  async getGroupsForParticipant(
    participantAddress: string
  ): Promise<Array<{ groupId: string; state: GroupChatState }>> {
    const results: Array<{ groupId: string; state: GroupChatState }> = [];

    for (const [groupId, state] of this.storage.entries()) {
      if (state.participants[participantAddress]) {
        results.push({ groupId, state });
      }
    }

    return results;
  }
}

/**
 * File-based implementation of GroupStateStorage
 * Stores group states in group-states.json
 */
export class FileGroupStateStorage implements GroupStateStorage {
  constructor(private filePath: string = ".data/group-states.json") {}

  private async loadData(): Promise<Map<string, GroupChatState>> {
    try {
      const fs = await import("fs/promises");
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed: GroupStatesStorage = JSON.parse(data);

      // Convert date strings back to Date objects
      const states = new Map<string, GroupChatState>();

      for (const [groupId, groupState] of Object.entries(parsed)) {
        const convertedState: GroupChatState = {
          ...groupState,

          // Convert participant dates
          participants: Object.fromEntries(
            Object.entries(groupState.participants).map(
              ([address, participant]) => [
                address,
                {
                  ...participant,

                  coinLaunchProgress: participant.coinLaunchProgress
                    ? {
                        ...participant.coinLaunchProgress,
                        startedAt: new Date(
                          participant.coinLaunchProgress.startedAt
                        ),
                      }
                    : undefined,

                  pendingTransaction: participant.pendingTransaction
                    ? {
                        ...participant.pendingTransaction,
                        timestamp: new Date(
                          participant.pendingTransaction.timestamp
                        ),
                      }
                    : undefined,
                },
              ]
            )
          ),

          // Convert manager dates
          managers: groupState.managers.map((manager) => ({
            ...manager,
            deployedAt: new Date(manager.deployedAt),
            liveData: manager.liveData
              ? {
                  ...manager.liveData,
                  lastUpdated: new Date(manager.liveData.lastUpdated),
                }
              : undefined,
          })),

          // Convert coin dates
          coins: groupState.coins.map((coin) => ({
            ...coin,
            launchedAt: new Date(coin.launchedAt),
            liveData: coin.liveData
              ? {
                  ...coin.liveData,
                  lastUpdated: new Date(coin.liveData.lastUpdated),
                }
              : undefined,
          })),
        };

        states.set(groupId, convertedState);
      }

      return states;
    } catch (error) {
      // File doesn't exist or is invalid, return empty map
      return new Map();
    }
  }

  private async saveData(states: Map<string, GroupChatState>): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      // Convert Map to object for JSON serialization
      const data: GroupStatesStorage = Object.fromEntries(states.entries());
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Failed to save group state data:", error);
      throw error;
    }
  }

  async getGroupState(groupId: string): Promise<GroupChatState | null> {
    const states = await this.loadData();
    return states.get(groupId) || null;
  }

  async setGroupState(groupId: string, state: GroupChatState): Promise<void> {
    const states = await this.loadData();
    states.set(groupId, {
      ...state,
    });
    await this.saveData(states);
  }

  async deleteGroupState(groupId: string): Promise<void> {
    const states = await this.loadData();
    states.delete(groupId);
    await this.saveData(states);
  }

  async groupExists(groupId: string): Promise<boolean> {
    const states = await this.loadData();
    return states.has(groupId);
  }

  async getParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<GroupParticipant | null> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.participants[participantAddress] || null;
  }

  async setParticipant(
    groupId: string,
    participantAddress: string,
    participant: GroupParticipant
  ): Promise<void> {
    let groupState = await this.getGroupState(groupId);

    if (!groupState) {
      // Create new group state if it doesn't exist
      groupState = {
        groupId,
        metadata: {},
        participants: {},
        managers: [],
        coins: [],
      };
    }

    groupState.participants[participantAddress] = participant;

    await this.setGroupState(groupId, groupState);
  }

  async deleteParticipant(
    groupId: string,
    participantAddress: string
  ): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState && groupState.participants[participantAddress]) {
      delete groupState.participants[participantAddress];
      await this.setGroupState(groupId, groupState);
    }
  }

  async participantExists(
    groupId: string,
    participantAddress: string
  ): Promise<boolean> {
    const groupState = await this.getGroupState(groupId);
    return !!groupState?.participants[participantAddress];
  }

  async addManager(groupId: string, manager: GroupManager): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState) {
      groupState.managers.push(manager);
      await this.setGroupState(groupId, groupState);
    }
  }

  async getManagers(groupId: string): Promise<GroupManager[]> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.managers || [];
  }

  async addCoin(groupId: string, coin: GroupCoin): Promise<void> {
    const groupState = await this.getGroupState(groupId);
    if (groupState) {
      groupState.coins.push(coin);
      await this.setGroupState(groupId, groupState);
    }
  }

  async getCoins(groupId: string): Promise<GroupCoin[]> {
    const groupState = await this.getGroupState(groupId);
    return groupState?.coins || [];
  }

  async getAllGroupStates(): Promise<GroupStatesStorage> {
    const states = await this.loadData();
    return Object.fromEntries(states.entries());
  }

  async setAllGroupStates(states: GroupStatesStorage): Promise<void> {
    const statesMap = new Map<string, GroupChatState>();
    for (const [groupId, state] of Object.entries(states)) {
      statesMap.set(groupId, state);
    }
    await this.saveData(statesMap);
  }

  async getGroupsForParticipant(
    participantAddress: string
  ): Promise<Array<{ groupId: string; state: GroupChatState }>> {
    const states = await this.loadData();
    const results: Array<{ groupId: string; state: GroupChatState }> = [];

    for (const [groupId, state] of states.entries()) {
      if (state.participants[participantAddress]) {
        results.push({ groupId, state });
      }
    }

    return results;
  }
}

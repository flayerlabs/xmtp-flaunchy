import { GraphQLService, GroupData } from "./GraphQLService";
import { UserState, UserGroup, UserCoin } from "../core/types/UserState";
import {
  GroupChatState,
  GroupCoin,
  AggregatedUserData,
} from "../core/types/GroupState";

export class UserDataService {
  private graphqlService: GraphQLService;

  constructor() {
    this.graphqlService = new GraphQLService();
  }

  /**
   * @deprecated Use aggregateUserDataFromGroups instead
   * Legacy method for backwards compatibility
   */
  async injectGroupData(userState: UserState): Promise<UserState> {
    console.warn(
      "[UserDataService] ⚠️ injectGroupData is deprecated, use group-centric methods instead"
    );
    return userState; // Return unchanged for now
  }

  /**
   * @deprecated Legacy helper methods - use group-centric methods instead
   */

  /**
   * Refresh data for a specific group
   */
  async refreshGroupData(groupId: string): Promise<GroupData | null> {
    return await this.graphqlService.fetchSingleGroupData(groupId);
  }

  // ================================
  // NEW GROUP-CENTRIC METHODS
  // ================================

  /**
   * Inject live data into group states
   * Updates both managers and coins with live API data
   */
  async injectGroupStateData(
    groupStates: Record<string, GroupChatState>
  ): Promise<Record<string, GroupChatState>> {
    console.log(
      `[UserDataService] 🔄 Starting live data injection for ${
        Object.keys(groupStates).length
      } group states`
    );

    const updatedGroupStates = { ...groupStates };

    for (const [groupId, groupState] of Object.entries(groupStates)) {
      try {
        // Get all manager addresses for this group
        const managerAddresses = groupState.managers.map(
          (m) => m.contractAddress
        );

        if (managerAddresses.length === 0) {
          continue;
        }

        console.log(
          `[UserDataService] 📡 Fetching data for group ${groupId} with ${managerAddresses.length} managers`
        );

        // Fetch live data from API
        const apiGroupData = await this.graphqlService.fetchGroupData(
          managerAddresses
        );
        const apiDataMap = new Map<string, GroupData>();
        apiGroupData.forEach((data) => {
          apiDataMap.set(data.id.toLowerCase(), data);
        });

        // Update managers with live data
        const updatedManagers = groupState.managers.map((manager) => {
          const liveData = apiDataMap.get(
            manager.contractAddress.toLowerCase()
          );
          if (liveData) {
            // Calculate total fees from all holdings
            const totalFeesUSDC = liveData.holdings
              .reduce((total, holding) => {
                const fees = parseFloat(
                  holding.collectionToken.pool.totalFeesUSDC || "0"
                );
                return total + fees;
              }, 0)
              .toString();

            return {
              ...manager,
              liveData: {
                recipients: liveData.recipients,
                totalFeesUSDC,
                totalCoins: liveData.holdings.length,
                lastUpdated: new Date(),
              },
            };
          }
          return manager;
        });

        // Update coins with live data using the first manager's data
        const primaryManagerData = apiDataMap.get(
          groupState.managers[0]?.contractAddress.toLowerCase()
        );
        const updatedCoins = await this.updateGroupCoinsWithLiveData(
          groupState.coins,
          primaryManagerData
        );

        // Update the group state
        updatedGroupStates[groupId] = {
          ...groupState,
          managers: updatedManagers,
          coins: updatedCoins,
        };

        console.log(
          `[UserDataService] ✅ Updated group ${groupId} with live data`
        );
      } catch (error) {
        console.error(
          `[UserDataService] ❌ Failed to update group ${groupId}:`,
          error
        );
      }
    }

    return updatedGroupStates;
  }

  /**
   * Update group coins with live data
   * Uses the holdings data from the group's manager
   */
  private async updateGroupCoinsWithLiveData(
    coins: GroupCoin[],
    managerData?: GroupData
  ): Promise<GroupCoin[]> {
    if (coins.length === 0 || !managerData) return coins;

    try {
      // Create a map of coin addresses to their holdings data
      const holdingsMap = new Map<string, any>();
      managerData.holdings.forEach((holding) => {
        holdingsMap.set(
          holding.collectionToken.id.toLowerCase(),
          holding.collectionToken
        );
      });

      return coins.map((coin) => {
        const holdingData = holdingsMap.get(coin.contractAddress.toLowerCase());
        if (holdingData) {
          return {
            ...coin,
            liveData: {
              totalHolders: holdingData.totalHolders || 0,
              marketCapUSDC: holdingData.marketCapUSDC || "0",
              priceChangePercentage: holdingData.priceChangePercentage || "0",
              totalFeesUSDC: holdingData.pool.totalFeesUSDC || "0",
              lastUpdated: new Date(),
            },
          };
        }
        return coin;
      });
    } catch (error) {
      console.error(
        `[UserDataService] ❌ Failed to update coins with live data:`,
        error
      );
      return coins;
    }
  }

  /**
   * Aggregate user data from multiple group states
   * Creates a backwards-compatible user view from group-centric data
   */
  async aggregateUserDataFromGroups(
    participantAddress: string,
    groupStates: Record<string, GroupChatState>
  ): Promise<AggregatedUserData> {
    console.log(
      `[UserDataService] 🔄 Aggregating user data for ${participantAddress}`
    );

    let globalPreferences = {
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

    // Process each group state
    for (const [groupId, groupState] of Object.entries(groupStates)) {
      const participant = groupState.participants[participantAddress];

      if (!participant) continue;

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
        groupName: groupState.metadata.name,
        managers: groupState.managers,
        joinedAt: participant.joinedAt,
      });

      // Add coins from this group
      for (const coin of groupState.coins) {
        allCoins.push({
          coin,
          groupId,
          groupName: groupState.metadata.name,
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

    console.log(
      `[UserDataService] ✅ Aggregated data: ${allGroups.length} groups, ${allCoins.length} coins`
    );

    return {
      userId: participantAddress,
      globalPreferences,
      allGroups,
      allCoins,
      activeProgressStates,
    };
  }

  /**
   * Convert aggregated data to legacy UserState format for backwards compatibility
   */
  async convertToLegacyUserState(
    aggregatedData: AggregatedUserData
  ): Promise<UserState> {
    const now = new Date();

    // Convert groups
    const userGroups: UserGroup[] = aggregatedData.allGroups.map(
      (groupInfo) => {
        const primaryManager = groupInfo.managers[0]; // Use first manager for legacy format

        return {
          id: primaryManager.contractAddress,
          name:
            groupInfo.groupName ||
            `Group ${primaryManager.contractAddress.slice(0, 8)}...`,
          createdBy: primaryManager.deployedBy,
          type: "username_split" as const,
          receivers: primaryManager.receivers,
          coins: aggregatedData.allCoins
            .filter((coinInfo) => coinInfo.groupId === groupInfo.groupId)
            .map((coinInfo) => coinInfo.coin.ticker),
          chainId: primaryManager.chainId,
          chainName: primaryManager.chainName,
          createdAt: primaryManager.deployedAt,
          updatedAt: now,
          liveData: primaryManager.liveData,
        };
      }
    );

    // Convert coins
    const userCoins: UserCoin[] = aggregatedData.allCoins.map((coinInfo) => ({
      ticker: coinInfo.coin.ticker,
      name: coinInfo.coin.name,
      image: coinInfo.coin.image,
      groupId: coinInfo.coin.managerAddress,
      contractAddress: coinInfo.coin.contractAddress,
      txHash: coinInfo.coin.txHash,
      launched: true, // All coins in group states are launched
      fairLaunchDuration: coinInfo.coin.fairLaunchDuration,
      fairLaunchPercent: coinInfo.coin.fairLaunchPercent,
      initialMarketCap: coinInfo.coin.initialMarketCap,
      chainId: coinInfo.coin.chainId,
      chainName: coinInfo.coin.chainName,
      createdAt: coinInfo.coin.launchedAt,
      liveData: coinInfo.coin.liveData,
    }));

    return {
      userId: aggregatedData.userId,
      coins: userCoins,
      groups: userGroups,
      preferences: aggregatedData.globalPreferences,
      createdAt: aggregatedData.allGroups[0]?.joinedAt || now,
      updatedAt: now,
      groupStates: {}, // Leave empty since we're aggregating from group states
    };
  }
}

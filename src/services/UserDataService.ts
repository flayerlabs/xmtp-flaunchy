import { GraphQLService, GroupData } from "./GraphQLService";
import { UserState, UserGroup, UserCoin } from "../core/types/UserState";

export class UserDataService {
  private graphqlService: GraphQLService;

  constructor() {
    this.graphqlService = new GraphQLService();
  }

  /**
   * Inject live data into all of a user's groups
   */
  async injectGroupData(userState: UserState): Promise<UserState> {
    console.log(
      `[UserDataService] 🔄 Starting live data injection for user ${userState.userId}`
    );
    console.log(
      `[UserDataService] User has ${userState.groups.length} groups and ${userState.coins.length} cached coins`
    );

    if (userState.groups.length === 0) {
      console.log(
        `[UserDataService] ⚠️  No groups found, returning original state`
      );
      return userState;
    }

    try {
      // Get all group addresses (IDs)
      const groupAddresses = userState.groups.map((group) => group.id);
      console.log(
        `[UserDataService] 📋 Group addresses to fetch:`,
        groupAddresses
      );

      // Fetch live data from API
      console.log(`[UserDataService] 📡 Calling GraphQL service...`);
      const apiGroupData = await this.graphqlService.fetchGroupData(
        groupAddresses
      );

      console.log(
        `[UserDataService] 📊 Received ${apiGroupData.length} groups from GraphQL`
      );

      // Create a map for quick lookup
      const apiDataMap = new Map<string, GroupData>();
      apiGroupData.forEach((data) => {
        apiDataMap.set(data.id.toLowerCase(), data);
        console.log(
          `[UserDataService] 📁 Mapped group ${data.id} with ${data.holdings.length} coins`
        );
      });

      // Update groups with live data
      const updatedGroups = userState.groups.map((group) => {
        const liveData = apiDataMap.get(group.id.toLowerCase());

        if (liveData) {
          const totalFeesUSDC = liveData.holdings
            .reduce((total, holding) => {
              const fees = parseFloat(
                holding.collectionToken.pool.totalFeesUSDC || "0"
              );
              return total + fees;
            }, 0)
            .toString();

          console.log(
            `[UserDataService] ✅ Updated group ${group.id} with live data: ${liveData.holdings.length} coins, $${totalFeesUSDC} fees`
          );

          return {
            ...group,
            liveData: {
              recipients: liveData.recipients,
              totalFeesUSDC,
              totalCoins: liveData.holdings.length,
              lastUpdated: new Date(),
            },
          };
        } else {
          console.log(
            `[UserDataService] ⚠️  No live data found for group ${group.id}`
          );
          return group;
        }
      });

      // Update coins with live data
      console.log(`[UserDataService] 🪙 Injecting coin data...`);
      const updatedCoins = await this.injectCoinData(
        userState.coins,
        apiDataMap
      );

      // Discover new coins from blockchain that aren't in the cached state
      console.log(
        `[UserDataService] 🔍 Discovering new coins from blockchain...`
      );
      const discoveredCoins = await this.discoverCoinsFromApi(
        userState.coins,
        apiDataMap,
        userState.groups
      );

      // Combine updated existing coins with newly discovered coins
      const allCoins = [...updatedCoins, ...discoveredCoins];

      console.log(
        `[UserDataService] ✅ Injected live data for ${updatedGroups.length} groups`
      );
      console.log(
        `[UserDataService] 📊 Coin summary: ${updatedCoins.length} existing + ${discoveredCoins.length} discovered = ${allCoins.length} total`
      );

      const result = {
        ...userState,
        groups: updatedGroups,
        coins: allCoins,
        updatedAt: new Date(),
      };

      console.log(
        `[UserDataService] 📄 Final result: ${result.groups.length} groups, ${result.coins.length} coins`
      );

      return result;
    } catch (error) {
      console.error("[UserDataService] ❌ Failed to inject group data:", error);
      // Return original state if API fails
      return userState;
    }
  }

  /**
   * Inject live data into coins based on group data
   */
  private async injectCoinData(
    coins: UserCoin[],
    apiDataMap: Map<string, GroupData>
  ): Promise<UserCoin[]> {
    console.log(
      `[UserDataService] 🔍 Injecting coin data for ${coins.length} cached coins`
    );

    // Log all available coins in the API data
    let totalApiCoins = 0;
    apiDataMap.forEach((groupData, groupId) => {
      totalApiCoins += groupData.holdings.length;
      if (groupData.holdings.length > 0) {
        console.log(
          `[UserDataService] 📊 Group ${groupId} has ${groupData.holdings.length} coins:`
        );
        groupData.holdings.forEach((holding, index) => {
          console.log(
            `  ${index + 1}. ${holding.collectionToken.name} (${
              holding.collectionToken.symbol
            })`
          );
          console.log(`     • Contract: ${holding.collectionToken.id}`);
          console.log(
            `     • Market Cap: $${holding.collectionToken.marketCapUSDC}`
          );
        });
      }
    });

    console.log(
      `[UserDataService] 📈 Total coins available in API: ${totalApiCoins}`
    );

    return coins.map((coin, index) => {
      console.log(
        `[UserDataService] 🔄 Processing coin ${index + 1}/${coins.length}: ${
          coin.name
        } (${coin.ticker})`
      );
      console.log(
        `[UserDataService]   • Contract: ${coin.contractAddress || "N/A"}`
      );
      console.log(`[UserDataService]   • Group ID: ${coin.groupId}`);

      // Find the coin in any group's holdings by matching contract address (ID)
      for (const [groupId, groupData] of apiDataMap.entries()) {
        const holding = groupData.holdings.find((h) => {
          // Primary match: by contract address (most reliable)
          if (coin.contractAddress) {
            const contractMatch =
              h.collectionToken.id.toLowerCase() ===
              coin.contractAddress.toLowerCase();
            console.log(
              `[UserDataService]   • Checking contract match: ${h.collectionToken.id} vs ${coin.contractAddress} = ${contractMatch}`
            );
            return contractMatch;
          }
          // Fallback: by ticker symbol (for coins without contract address yet)
          const tickerMatch =
            h.collectionToken.symbol.toLowerCase() ===
            coin.ticker.toLowerCase();
          console.log(
            `[UserDataService]   • Checking ticker match: ${h.collectionToken.symbol} vs ${coin.ticker} = ${tickerMatch}`
          );
          return tickerMatch;
        });

        if (holding) {
          console.log(
            `[UserDataService] ✅ Found live data for ${coin.name} (${coin.ticker}) in group ${groupId}`
          );
          console.log(
            `[UserDataService]   • Holders: ${holding.collectionToken.totalHolders}`
          );
          console.log(
            `[UserDataService]   • Market Cap: $${holding.collectionToken.marketCapUSDC}`
          );
          console.log(
            `[UserDataService]   • Price Change: ${holding.collectionToken.priceChangePercentage}%`
          );
          console.log(
            `[UserDataService]   • Fees: $${holding.collectionToken.pool.totalFeesUSDC}`
          );

          return {
            ...coin,
            liveData: {
              totalHolders: holding.collectionToken.totalHolders,
              marketCapUSDC: holding.collectionToken.marketCapUSDC,
              priceChangePercentage:
                holding.collectionToken.priceChangePercentage,
              totalFeesUSDC: holding.collectionToken.pool.totalFeesUSDC,
              lastUpdated: new Date(),
            },
          };
        }
      }

      console.log(
        `[UserDataService] ⚠️  No live data found for ${coin.name} (${coin.ticker})`
      );
      return coin;
    });
  }

  /**
   * Discover coins from API data that aren't in the cached state
   */
  private async discoverCoinsFromApi(
    existingCoins: UserCoin[],
    apiDataMap: Map<string, GroupData>,
    userGroups: any[]
  ): Promise<UserCoin[]> {
    console.log(`[UserDataService] 🔍 Discovering coins from API data...`);

    const discoveredCoins: UserCoin[] = [];
    const existingContractAddresses = new Set(
      existingCoins
        .map((coin) => coin.contractAddress?.toLowerCase())
        .filter(Boolean)
    );
    const existingTickerSymbols = new Set(
      existingCoins.map((coin) => coin.ticker.toLowerCase())
    );

    // Look through all groups' holdings to find coins not in our cached state
    for (const [groupId, groupData] of apiDataMap.entries()) {
      console.log(
        `[UserDataService] 🔍 Checking group ${groupId} for new coins...`
      );

      for (const holding of groupData.holdings) {
        const contractAddress = holding.collectionToken.id.toLowerCase();
        const ticker = holding.collectionToken.symbol.toLowerCase();

        // Check if we already have this coin (by contract address or ticker)
        const alreadyExists =
          existingContractAddresses.has(contractAddress) ||
          existingTickerSymbols.has(ticker);

        if (!alreadyExists) {
          console.log(
            `[UserDataService] 🆕 Discovered new coin: ${holding.collectionToken.name} (${holding.collectionToken.symbol})`
          );
          console.log(
            `[UserDataService]   • Contract: ${holding.collectionToken.id}`
          );
          console.log(
            `[UserDataService]   • Holders: ${holding.collectionToken.totalHolders}`
          );
          console.log(
            `[UserDataService]   • Market Cap: $${holding.collectionToken.marketCapUSDC}`
          );

          // Find the corresponding user group to get chain info
          const userGroup = userGroups.find(
            (g) => g.id.toLowerCase() === groupId
          );

          const newCoin: UserCoin = {
            ticker: holding.collectionToken.symbol,
            name: holding.collectionToken.name,
            image: holding.collectionToken.imageId || "",
            groupId: groupId,
            contractAddress: holding.collectionToken.id,
            launched: true,
            fairLaunchDuration: 0, // No fair launch duration
            fairLaunchPercent: 0, // No fair launch
            initialMarketCap:
              parseInt(holding.collectionToken.marketCapUSDC) || 1000,
            chainId: userGroup?.chainId || 8453, // Default to Base mainnet
            chainName: userGroup?.chainName || "base",
            createdAt: new Date(),
            liveData: {
              totalHolders: holding.collectionToken.totalHolders,
              marketCapUSDC: holding.collectionToken.marketCapUSDC,
              priceChangePercentage:
                holding.collectionToken.priceChangePercentage,
              totalFeesUSDC: holding.collectionToken.pool.totalFeesUSDC,
              lastUpdated: new Date(),
            },
          };

          discoveredCoins.push(newCoin);

          // Add to our tracking sets to avoid duplicates
          existingContractAddresses.add(contractAddress);
          existingTickerSymbols.add(ticker);
        } else {
          console.log(
            `[UserDataService] ⚠️  Coin ${holding.collectionToken.name} (${holding.collectionToken.symbol}) already exists in cached state`
          );
        }
      }
    }

    console.log(
      `[UserDataService] 🆕 Discovered ${discoveredCoins.length} new coins from blockchain`
    );

    return discoveredCoins;
  }

  /**
   * Refresh data for a specific group
   */
  async refreshGroupData(groupId: string): Promise<GroupData | null> {
    return await this.graphqlService.fetchSingleGroupData(groupId);
  }
}

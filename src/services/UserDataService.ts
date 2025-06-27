import { GraphQLService, GroupData } from './GraphQLService';
import { UserState, UserGroup, UserCoin } from '../core/types/UserState';

export class UserDataService {
  private graphqlService: GraphQLService;

  constructor() {
    this.graphqlService = new GraphQLService();
  }

  /**
   * Inject live data into all of a user's groups
   */
  async injectGroupData(userState: UserState): Promise<UserState> {
    if (userState.groups.length === 0) {
      console.log('No groups to inject data for');
      return userState;
    }

    try {
      // Get all group addresses (IDs)
      const groupAddresses = userState.groups.map(group => group.id);
      
      console.log('🔄 INJECTING GROUP DATA', {
        userId: userState.userId,
        groupCount: groupAddresses.length,
        addresses: groupAddresses
      });

      // Fetch live data from API
      const apiGroupData = await this.graphqlService.fetchGroupData(groupAddresses);
      
      // Create a map for quick lookup
      const apiDataMap = new Map<string, GroupData>();
      apiGroupData.forEach(data => {
        apiDataMap.set(data.id.toLowerCase(), data);
      });

      // Update groups with live data
      const updatedGroups = userState.groups.map(group => {
        const liveData = apiDataMap.get(group.id.toLowerCase());
        
        if (liveData) {
          console.log(`✅ Injecting data for group ${group.id}:`, {
            recipients: liveData.recipients.length,
            holdings: liveData.holdings.length
          });

          const totalFeesUSDC = liveData.holdings
            .reduce((total, holding) => {
              const fees = parseFloat(holding.collectionToken.pool.totalFeesUSDC || '0');
              return total + fees;
            }, 0)
            .toString();

          return {
            ...group,
            liveData: {
              recipients: liveData.recipients,
              totalFeesUSDC,
              totalCoins: liveData.holdings.length,
              lastUpdated: new Date()
            }
          };
        } else {
          console.log(`⚠️ No API data found for group ${group.id}`);
          return group;
        }
      });

      // Update coins with live data
      const updatedCoins = await this.injectCoinData(userState.coins, apiDataMap);

      return {
        ...userState,
        groups: updatedGroups,
        coins: updatedCoins,
        updatedAt: new Date()
      };

    } catch (error) {
      console.error('Failed to inject group data:', error);
      // Return original state if API fails
      return userState;
    }
  }

  /**
   * Inject live data into coins based on group data
   */
  private async injectCoinData(coins: UserCoin[], apiDataMap: Map<string, GroupData>): Promise<UserCoin[]> {
    return coins.map(coin => {
      // Find the coin in any group's holdings by matching contract address (ID)
      for (const [groupId, groupData] of apiDataMap.entries()) {
        const holding = groupData.holdings.find(h => {
          // Primary match: by contract address (most reliable)
          if (coin.contractAddress) {
            return h.collectionToken.id.toLowerCase() === coin.contractAddress.toLowerCase();
          }
          // Fallback: by ticker symbol (for coins without contract address yet)
          return h.collectionToken.symbol.toLowerCase() === coin.ticker.toLowerCase();
        });

        if (holding) {
          console.log(`✅ Injecting data for coin ${coin.ticker}:`, {
            contractAddress: holding.collectionToken.id,
            marketCapUSDC: holding.collectionToken.marketCapUSDC,
            totalHolders: holding.collectionToken.totalHolders,
            priceChange: holding.collectionToken.priceChangePercentage
          });

          return {
            ...coin,
            liveData: {
              totalHolders: holding.collectionToken.totalHolders,
              marketCapUSDC: holding.collectionToken.marketCapUSDC,
              priceChangePercentage: holding.collectionToken.priceChangePercentage,
              totalFeesUSDC: holding.collectionToken.pool.totalFeesUSDC,
              lastUpdated: new Date()
            }
          };
        }
      }

      return coin;
    });
  }

  /**
   * Refresh data for a specific group
   */
  async refreshGroupData(groupId: string): Promise<GroupData | null> {
    return await this.graphqlService.fetchSingleGroupData(groupId);
  }
} 
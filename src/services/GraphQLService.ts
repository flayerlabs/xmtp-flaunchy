import { ChainConfig, SUPPORTED_CHAINS } from "../flows/utils/ChainSelection";

export interface GroupData {
  id: string;
  recipients: Array<{
    recipient: string;
    recipientShare: string;
  }>;
  holdings: Array<{
    collectionToken: {
      id: string; // Contract address
      name: string;
      symbol: string;
      imageId: string;
      totalHolders: number;
      marketCapUSDC: string;
      priceChangePercentage: number;
      pool: {
        totalFeesUSDC: string;
      };
    };
  }>;
}

export interface GraphQLResponse {
  data: {
    addressFeeSplitManagers: GroupData[];
  };
  errors?: Array<{
    message: string;
  }>;
}

export class GraphQLService {
  private apiUrl: string;

  constructor() {
    this.apiUrl = process.env.PUBLIC_API_URL || process.env.API_URL || '';
    if (!this.apiUrl) {
      throw new Error('API_URL orPUBLIC_API_URL environment variable is required');
    }
  }

  async fetchGroupData(groupAddresses: string[], chainConfig?: ChainConfig): Promise<GroupData[]> {
    if (groupAddresses.length === 0) {
      return [];
    }

    const query = `
      query {
        addressFeeSplitManagers(where:{
          id_in: [${groupAddresses.map(addr => `"${addr}"`).join(', ')}]
        }) {
          id
          recipients {
            recipient
            recipientShare
          }
          holdings {
            collectionToken {
              id
              name
              symbol
              imageId
              totalHolders
              marketCapUSDC
              priceChangePercentage
              pool {
                totalFeesUSDC
              }
            }
          }
        }
      }
    `;

    try {
      // Prepare headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add chain header if not Base Mainnet
      if (chainConfig && chainConfig.name !== 'base') {
        headers['x-chain-id'] = chainConfig.id.toString();
      }

      console.log('🔍 FETCHING GROUP DATA', {
        url: `${this.apiUrl}/graphql`,
        addresses: groupAddresses,
        chain: chainConfig ? `${chainConfig.displayName} (${chainConfig.id})` : 'Base Mainnet (default)',
        headers: chainConfig && chainConfig.name !== 'base' ? { 'x-chain-id': headers['x-chain-id'] } : 'none',
        query: query.trim()
      });

      const response = await fetch(`${this.apiUrl}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const result: GraphQLResponse = await response.json();

      if (result.errors) {
        console.error('GraphQL errors:', result.errors);
        throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
      }

      console.log('✅ GROUP DATA FETCHED', {
        groupCount: result.data.addressFeeSplitManagers.length,
        chain: chainConfig ? chainConfig.displayName : 'Base Mainnet',
        groups: result.data.addressFeeSplitManagers.map(g => ({
          id: g.id,
          holdingsCount: g.holdings.length
        }))
      });

      return result.data.addressFeeSplitManagers;
    } catch (error) {
      console.error('Failed to fetch group data:', error);
      throw error;
    }
  }

  async fetchSingleGroupData(groupAddress: string, chainConfig?: ChainConfig): Promise<GroupData | null> {
    const results = await this.fetchGroupData([groupAddress], chainConfig);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Fetch groups by chain - returns groups filtered by the specified chain
   */
  async fetchGroupsByChain(groupAddresses: string[], chainConfig: ChainConfig): Promise<{ groups: GroupData[], chainInfo: { name: string, displayName: string } }> {
    const groups = await this.fetchGroupData(groupAddresses, chainConfig);
    return {
      groups,
      chainInfo: {
        name: chainConfig.name,
        displayName: chainConfig.displayName
      }
    };
  }
} 
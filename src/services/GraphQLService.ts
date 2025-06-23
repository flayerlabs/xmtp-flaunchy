export interface GroupData {
  id: string;
  recipients: Array<{
    recipient: string;
    recipientShare: string;
  }>;
  holdings: Array<{
    id: string;
    collectionToken: {
      id: string;
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
    this.apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || '';
    if (!this.apiUrl) {
      throw new Error('API_URL or NEXT_PUBLIC_API_URL environment variable is required');
    }
  }

  async fetchGroupData(groupAddresses: string[]): Promise<GroupData[]> {
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
            id
            collectionToken{
              id
              name
              symbol
              imageId
              totalHolders
              marketCapUSDC
              priceChangePercentage
              pool{
                totalFeesUSDC
              }
            }
          }
        }
      }
    `;

    try {
      console.log('🔍 FETCHING GROUP DATA', {
        url: `${this.apiUrl}/graphql`,
        addresses: groupAddresses,
        query: query.trim()
      });

      const response = await fetch(`${this.apiUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
        groups: result.data.addressFeeSplitManagers.map(g => ({
          id: g.id,
          holdingsCount: g.holdings.length,
          recipientsCount: g.recipients.length
        }))
      });

      return result.data.addressFeeSplitManagers;
    } catch (error) {
      console.error('Failed to fetch group data:', error);
      throw error;
    }
  }

  async fetchSingleGroupData(groupAddress: string): Promise<GroupData | null> {
    const results = await this.fetchGroupData([groupAddress]);
    return results.length > 0 ? results[0] : null;
  }
} 
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
      priceChangePercentage: string;
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
    this.apiUrl = process.env.PUBLIC_API_URL || process.env.API_URL || "";
    if (!this.apiUrl) {
      throw new Error(
        "API_URL orPUBLIC_API_URL environment variable is required"
      );
    }
  }

  async fetchGroupData(
    groupAddresses: string[],
    chainConfig?: ChainConfig
  ): Promise<GroupData[]> {
    if (groupAddresses.length === 0) {
      console.log(
        `[GraphQL] ⚠️  No group addresses provided, returning empty array`
      );
      return [];
    }

    const query = `
      query {
        addressFeeSplitManagers(where:{
          id_in: [${groupAddresses.map((addr) => `"${addr}"`).join(", ")}]
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
        "Content-Type": "application/json",
      };

      // Add chain header if not Base Mainnet
      if (chainConfig && chainConfig.name !== "base") {
        headers["x-chain-id"] = chainConfig.id.toString();
      }

      console.log(
        `[GraphQL] 🔍 Fetching ${groupAddresses.length} groups on ${
          chainConfig ? chainConfig.displayName : "Base Mainnet"
        }`
      );
      console.log(`[GraphQL] Group addresses:`, groupAddresses);
      console.log(`[GraphQL] API URL: ${this.apiUrl}/graphql`);
      console.log(`[GraphQL] Headers:`, headers);

      const response = await fetch(`${this.apiUrl}/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      });

      console.log(
        `[GraphQL] Response status: ${response.status} ${response.statusText}`
      );

      if (!response.ok) {
        const responseText = await response.text();
        console.error(`[GraphQL] Error response body:`, responseText);
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText}`
        );
      }

      const result: GraphQLResponse = await response.json();

      if (result.errors) {
        console.error("[GraphQL] GraphQL errors:", result.errors);
        throw new Error(
          `GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`
        );
      }

      console.log(
        `[GraphQL] ✅ Fetched ${result.data.addressFeeSplitManagers.length} groups`
      );

      // Log detailed group information
      result.data.addressFeeSplitManagers.forEach((group, index) => {
        console.log(`[GraphQL] Group ${index + 1}:`);
        console.log(`  • ID: ${group.id}`);
        console.log(`  • Recipients: ${group.recipients.length}`);
        console.log(`  • Holdings (coins): ${group.holdings.length}`);

        if (group.holdings.length > 0) {
          group.holdings.forEach((holding, holdingIndex) => {
            console.log(
              `    Coin ${holdingIndex + 1}: ${holding.collectionToken.name} (${
                holding.collectionToken.symbol
              })`
            );
            console.log(`      • Contract: ${holding.collectionToken.id}`);
            console.log(
              `      • Holders: ${holding.collectionToken.totalHolders}`
            );
            console.log(
              `      • Market Cap: $${holding.collectionToken.marketCapUSDC}`
            );
            console.log(
              `      • Fees: $${holding.collectionToken.pool.totalFeesUSDC}`
            );
          });
        }
      });

      return result.data.addressFeeSplitManagers;
    } catch (error) {
      console.error("[GraphQL] ❌ Failed to fetch group data:", error);
      throw error;
    }
  }

  async fetchSingleGroupData(
    groupAddress: string,
    chainConfig?: ChainConfig
  ): Promise<GroupData | null> {
    const results = await this.fetchGroupData([groupAddress], chainConfig);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Fetch groups by chain - returns groups filtered by the specified chain
   */
  async fetchGroupsByChain(
    groupAddresses: string[],
    chainConfig: ChainConfig
  ): Promise<{
    groups: GroupData[];
    chainInfo: { name: string; displayName: string };
  }> {
    const groups = await this.fetchGroupData(groupAddresses, chainConfig);
    return {
      groups,
      chainInfo: {
        name: chainConfig.name,
        displayName: chainConfig.displayName,
      },
    };
  }
}

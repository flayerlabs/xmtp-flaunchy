export interface ENSData {
  id: string;
  address: string;
  displayName: string;
  source: string;
  links: Array<{
    id: string;
    source: string;
    url: string;
    avatar: string;
  }>;
  avatar: string;
}

export interface ENSResponse {
  data: {
    enses: ENSData[];
  };
  errors?: Array<{
    message: string;
  }>;
}

export class ENSResolverService {
  private apiUrl: string;

  constructor() {
    this.apiUrl = process.env.PUBLIC_API_URL || process.env.API_URL || "";
    if (!this.apiUrl) {
      console.warn(
        "⚠️ API_URL not configured, ENS resolution will use fallback addresses"
      );
    }
  }

  async resolveAddresses(addresses: string[]): Promise<Map<string, string>> {
    if (addresses.length === 0) {
      return new Map();
    }

    const addressToDisplayName = new Map<string, string>();

    // If no API URL configured, return shortened addresses
    if (!this.apiUrl) {
      for (const address of addresses) {
        const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        addressToDisplayName.set(address.toLowerCase(), shortAddress);
      }
      return addressToDisplayName;
    }

    // Process addresses in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      await this.processBatch(batch, addressToDisplayName);
    }

    return addressToDisplayName;
  }

  private async processBatch(
    addresses: string[],
    resultMap: Map<string, string>
  ): Promise<void> {
    try {
      const queries = addresses
        .map(
          (address) => `
        query_${address.replace(
          /[^a-zA-Z0-9]/g,
          "_"
        )}: enses(addressesOrNames:["${address}"]) {
          id
          address
          displayName
          source
          links {
            id
            source
            url
            avatar
          }
          avatar
        }
      `
        )
        .join("\n");

      const query = `query { ${queries} }`;

      console.log(`[ENS] 🔍 Resolving ${addresses.length} addresses`);

      const response = await fetch(`${this.apiUrl}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(
          `ENS resolution request failed: ${response.status} ${response.statusText}`
        );
      }

      const result = await response.json();

      if (result.errors) {
        console.error("ENS resolution errors:", result.errors);
        return;
      }

      // Process each query result
      for (const address of addresses) {
        const queryKey = `query_${address.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const enses = result.data[queryKey];

        if (enses && enses.length > 0) {
          const displayName = this.getPreferredDisplayName(enses[0]);
          resultMap.set(address.toLowerCase(), displayName);
        } else {
          // Fallback to shortened address
          const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
          resultMap.set(address.toLowerCase(), shortAddress);
        }
      }
    } catch (error) {
      console.error("Failed to resolve addresses:", error);
      // Fallback: use shortened addresses
      for (const address of addresses) {
        const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        resultMap.set(address.toLowerCase(), shortAddress);
      }
    }
  }

  private getPreferredDisplayName(ensData: ENSData): string {
    // Priority: basename > farcaster name > ens name > address (ignore twitter)
    const links = ensData.links || [];

    // Check for basename
    const basename = links.find((link) => link.source === "basename");
    if (basename) {
      return basename.id;
    }

    // Check for farcaster
    const farcaster = links.find((link) => link.source === "farcaster");
    if (farcaster) {
      return `@${farcaster.id}`;
    }

    // Check for ENS
    const ens = links.find((link) => link.source === "ens");
    if (ens) {
      return ens.id;
    }

    // Check for address source - if it's just an address, shorten it
    const addressLink = links.find((link) => link.source === "address");

    if (addressLink) {
      return `${addressLink.id.slice(0, 6)}...${addressLink.id.slice(-4)}`;
    }

    // Final fallback to shortened address from ensData.address
    return `${ensData.address.slice(0, 6)}...${ensData.address.slice(-4)}`;
  }

  async resolveSingleAddress(address: string): Promise<string> {
    const result = await this.resolveAddresses([address]);
    return (
      result.get(address.toLowerCase()) ||
      `${address.slice(0, 6)}...${address.slice(-4)}`
    );
  }
}

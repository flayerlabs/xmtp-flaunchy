import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";

/**
 * Service for resolving usernames to Ethereum addresses
 * Handles ENS names, Basenames, Farcaster usernames, and address validation
 */
export class UsernameResolver {
  /**
   * Resolve a username to an Ethereum address
   * Supports ENS, Basenames, Farcaster usernames, and raw addresses
   */
  async resolveUsername(username: string): Promise<string | undefined> {
    try {
      // If already an Ethereum address, return it
      if (isAddress(username)) {
        return username;
      }

      // Handle ENS names
      if (username.includes(".eth")) {
        return await this.resolveENS(username);
      }

      // Handle Farcaster usernames
      if (username.startsWith("@")) {
        return await this.resolveFarcaster(username.substring(1)); // Remove @ prefix
      }

      // If no specific format detected, try as Farcaster username
      return await this.resolveFarcaster(username);
    } catch (error) {
      console.error("Error resolving username:", username, error);
      return undefined;
    }
  }

  /**
   * Resolve ENS name or Basename to Ethereum address
   */
  private async resolveENS(ensName: string): Promise<string | undefined> {
    try {
      // Both ENS and Basenames are resolved on Ethereum mainnet
      const isBasename = ensName.endsWith(".base.eth");
      const rpcUrl = process.env.MAINNET_RPC_URL;

      console.log(
        `🔍 Resolving ${
          isBasename ? "Basename" : "ENS"
        }: ${ensName} on Ethereum mainnet`
      );

      // Create a public client for ENS/Basename resolution (always mainnet)
      const publicClient = createPublicClient({
        chain: mainnet,
        transport: rpcUrl ? http(rpcUrl) : http(),
      });

      const address = await publicClient.getEnsAddress({
        name: ensName,
      });

      if (address) {
        console.log(
          `✅ ${
            isBasename ? "Basename" : "ENS"
          } resolved: ${ensName} -> ${address}`
        );
        return address;
      }

      console.log(
        `❌ ${
          isBasename ? "Basename" : "ENS"
        } resolution failed for: ${ensName}`
      );
      return undefined;
    } catch (error) {
      console.error(`Error resolving ENS/Basename ${ensName}:`, error);
      return undefined;
    }
  }

  /**
   * Resolve Farcaster username to Ethereum address
   */
  private async resolveFarcaster(
    username: string
  ): Promise<string | undefined> {
    try {
      const apiKey = process.env.NEYNAR_API_KEY;
      if (!apiKey) {
        console.error("NEYNAR_API_KEY not found in environment variables");
        return undefined;
      }

      // Call Neynar API to resolve Farcaster username
      const response = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_username?username=${username.toLowerCase()}`,
        {
          headers: {
            accept: "application/json",
            api_key: apiKey,
          },
        }
      );

      if (!response.ok) {
        console.error(
          `Neynar API error: ${response.status} ${response.statusText}`
        );
        return undefined;
      }

      const data = await response.json();

      // Extract the primary verified address or custody address
      const user = data.user;
      if (user) {
        // Prefer verified ETH addresses, fallback to custody address
        const address =
          user.verified_addresses?.eth_addresses?.[0] || user.custody_address;

        if (address) {
          console.log(`✅ Farcaster resolved: @${username} -> ${address}`);
          return address;
        }
      }

      console.log(`❌ Farcaster resolution failed for: @${username}`);
      return undefined;
    } catch (error) {
      console.error(`Error resolving Farcaster username @${username}:`, error);
      return undefined;
    }
  }

  /**
   * Get creator address from inbox ID using XMTP client
   */
  async getCreatorAddressFromInboxId(
    inboxId: string,
    client: any
  ): Promise<string | undefined> {
    try {
      // Use the same pattern as in processCoordinatedMessages
      const inboxState = await client.preferences.inboxStateFromInboxIds([
        inboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";
      return creatorAddress.startsWith("0x") ? creatorAddress : undefined;
    } catch (error) {
      console.error("Error getting creator address from inbox ID:", error);
      return undefined;
    }
  }

  /**
   * Validate if a string is a valid Ethereum address
   */
  isValidAddress(address: string): boolean {
    return isAddress(address);
  }

  /**
   * Get a shortened version of an address for display
   */
  shortenAddress(address: string): string {
    if (!this.isValidAddress(address)) {
      return address;
    }
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

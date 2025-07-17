export class AddressUtils {
  /**
   * Format a single address with ENS resolution fallback
   */
  static async formatAddress(
    address: string,
    ensResolver: any
  ): Promise<string> {
    try {
      return await ensResolver.resolveSingleAddress(address);
    } catch (error) {
      console.error("Failed to resolve address:", address, error);
      return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
  }

  /**
   * Format multiple addresses with ENS resolution fallback
   */
  static async formatAddresses(
    addresses: string[],
    ensResolver: any
  ): Promise<Map<string, string>> {
    try {
      return await ensResolver.resolveAddresses(addresses);
    } catch (error) {
      console.error("Failed to resolve addresses:", addresses, error);
      const fallbackMap = new Map<string, string>();
      for (const address of addresses) {
        fallbackMap.set(
          address.toLowerCase(),
          `${address.slice(0, 6)}...${address.slice(-4)}`
        );
      }
      return fallbackMap;
    }
  }
}

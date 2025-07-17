import { decodeEventLog, type Log, isAddress, Address } from "viem";
import { poolCreatedAbi } from "../../data/abi/PoolCreatedAbi";

/**
 * Service for extracting contract addresses from transaction receipts
 * Handles both group creation (manager addresses) and coin creation (memecoin addresses)
 */
export class ContractExtractor {
  /**
   * Extract contract address from transaction receipt based on transaction type
   */
  static extractContractAddress(
    receipt: any,
    transactionType: "coin_creation"
  ): Address | null {
    console.log("🔍 EXTRACTING CONTRACT ADDRESS FROM RECEIPT");
    // console.log("🔍 EXTRACTING CONTRACT ADDRESS FROM RECEIPT", {
    //   contentType: typeof receipt,
    //   transactionType,
    //   content: safeStringify(receipt),
    // });

    try {
      // Parse transaction receipt logs based on transaction type
      if (
        receipt &&
        typeof receipt === "object" &&
        receipt.logs &&
        Array.isArray(receipt.logs)
      ) {
        const logs = receipt.logs;
        console.log(`📊 Found ${logs.length} logs in transaction receipt`);

        if (transactionType === "coin_creation") {
          return this.extractMemecoinAddress(logs);
        }
      } else {
        console.log(
          "❌ No logs found in transaction receipt or invalid format:",
          {
            hasReceipt: !!receipt,
            isObject: typeof receipt === "object",
            hasLogs: !!(receipt && receipt.logs),
            isLogsArray: !!(
              receipt &&
              receipt.logs &&
              Array.isArray(receipt.logs)
            ),
            logsType:
              receipt && receipt.logs ? typeof receipt.logs : "undefined",
          }
        );
      }

      // Fallback: Try to extract from common fields (backwards compatibility)
      if (receipt && typeof receipt === "object") {
        // Check for specific fields first (Flaunch-specific)
        if (receipt.memecoin) {
          console.log("Found memecoin address in receipt:", receipt.memecoin);
          return receipt.memecoin;
        }
        if (receipt.memecoinAddress) {
          console.log(
            "Found memecoinAddress in receipt:",
            receipt.memecoinAddress
          );
          return receipt.memecoinAddress;
        }

        // Generic fields
        if (receipt.contractAddress) {
          console.log(
            "Found contractAddress in receipt:",
            receipt.contractAddress
          );
          return receipt.contractAddress;
        }
        if (receipt.address) {
          console.log("Found address in receipt:", receipt.address);
          return receipt.address;
        }
      }

      // Try to extract from string content
      if (typeof receipt === "string" && receipt.includes("0x")) {
        const match = receipt.match(/0x[a-fA-F0-9]{40}/);
        if (match) {
          console.log("Found address in string content:", match[0]);
          return match[0] as Address;
        }
      }

      console.error(
        "❌ CRITICAL: Could not extract contract address from receipt"
      );
      console.error("🚨 SECURITY: Refusing to proceed with unknown address");
      console.error("💡 For coin creation: Check PoolCreated event logs");

      // Return null to indicate failure - do not generate mock addresses for security reasons
      return null;
    } catch (error) {
      console.error("Error parsing transaction receipt:", error);
      return null;
    }
  }

  /**
   * Extract memecoin address from coin creation transaction logs
   */
  private static extractMemecoinAddress(logs: Log[]): Address | null {
    console.log("Parsing coin creation logs for PoolCreated event");

    try {
      // Find the log with the PoolCreated event
      const poolCreatedLog = logs.find((log) => {
        return (
          log.topics[0] ===
          "0x54976b48704e67457d6a85a2db51d6e760bbeddf6151f9206512108adce80b42"
        );
      });
      if (!poolCreatedLog) {
        console.error("No PoolCreated event found in log data");
        return null;
      }

      console.log("Found PoolCreated log:", {
        address: poolCreatedLog.address,
        topics: poolCreatedLog.topics,
        data: poolCreatedLog.data,
      });

      // Decode the log data using the actual topics from the log
      const decoded = decodeEventLog({
        abi: poolCreatedAbi,
        data: poolCreatedLog.data as `0x${string}`,
        topics: poolCreatedLog.topics as [`0x${string}`, ...`0x${string}`[]],
        eventName: "PoolCreated",
      });

      console.log("Decoded PoolCreated event:", {
        poolId: decoded.args._poolId,
        memecoin: decoded.args._memecoin,
        memecoinTreasury: decoded.args._memecoinTreasury,
        tokenId: decoded.args._tokenId,
        currencyFlipped: decoded.args._currencyFlipped,
        flaunchFee: decoded.args._flaunchFee?.toString(),
        params: {
          name: decoded.args._params.name,
          symbol: decoded.args._params.symbol,
          creator: decoded.args._params.creator,
        },
      });

      return decoded.args._memecoin as Address;
    } catch (error) {
      console.error("Error decoding PoolCreated log:", error);
      return null;
    }
  }

  /**
   * Extract manager address from first launch transaction logs
   * Specifically looks for ManagerDeployed events
   */
  static extractManagerAddressFromReceipt(receipt: any): Address | null {
    try {
      if (!receipt || !receipt.logs || !Array.isArray(receipt.logs)) {
        throw new Error("Invalid receipt or logs");
      }

      // Look for the ManagerDeployed event
      const managerDeployedTopic =
        "0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4";

      for (const log of receipt.logs) {
        if (
          log.topics &&
          log.topics.length > 1 &&
          log.topics[0] === managerDeployedTopic
        ) {
          // Found the ManagerDeployed event, extract manager address from topic[1]
          const managerAddressHex = log.topics[1];
          if (managerAddressHex) {
            // Remove padding zeros to get the actual address
            const managerAddress = `0x${managerAddressHex.slice(
              -40
            )}` as Address;
            console.log(
              "✅ Found manager address from ManagerDeployed event:",
              managerAddress
            );
            return managerAddress;
          }
        }
      }

      console.log(
        "❌ No ManagerDeployed event found in logs for manager address extraction"
      );
      return null;
    } catch (error) {
      console.error(
        "Failed to extract manager address from transaction logs:",
        error
      );
      return null;
    }
  }

  /**
   * Validate that an extracted address is a valid Ethereum address
   */
  static validateExtractedAddress(address: string | null): boolean {
    if (!address) {
      console.error(
        "❌ CRITICAL: Failed to extract contract address from transaction receipt"
      );
      return false;
    }

    if (!isAddress(address)) {
      console.error(
        "❌ CRITICAL: Extracted address is not a valid Ethereum address:",
        address
      );
      return false;
    }

    return true;
  }
}

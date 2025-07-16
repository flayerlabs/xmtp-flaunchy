import {
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { TreasuryManagerFactoryAbi } from "../../../abi/TreasuryManagerFactory";
import {
  AddressFeeSplitManagerAddress,
  TreasuryManagerFactoryAddress,
} from "../../../addresses";
import { numToHex } from "../../../utils/hex";
import { FlowContext } from "../../core/types/FlowContext";
import {
  createLaunchExtractionPrompt,
  LaunchExtractionResult,
} from "../onboarding/launchExtractionTemplate";
import { ChainConfig, DEFAULT_CHAIN } from "./ChainSelection";
import { safeParseJSON } from "../../core/utils/jsonUtils";

export interface FeeReceiver {
  username: string;
  percentage?: number;
  resolvedAddress?: string;
}

export interface GroupCreationResult {
  walletSendCalls: any;
  resolvedReceivers: FeeReceiver[];
  chainConfig: ChainConfig;
}

/**
 * Utility class for shared group creation logic used by ManagementFlow and automatic group creation
 */
export class GroupCreationUtils {
  /**
   * Extract fee receivers from a message using LLM
   */
  static async extractFeeReceivers(
    context: FlowContext
  ): Promise<{ receivers: FeeReceiver[] } | null> {
    const messageText = context.messageText;
    if (!messageText) return null;

    try {
      const extractionPrompt = createLaunchExtractionPrompt({
        message: messageText,
        hasAttachment: false,
      });

      const response = await context.openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: extractionPrompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 800,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return null;

      const result = safeParseJSON<LaunchExtractionResult>(content);

      if (
        result.feeReceivers &&
        result.feeReceivers.receivers &&
        result.feeReceivers.confidence >= 0.5
      ) {
        return {
          receivers: result.feeReceivers.receivers.map((r) => ({
            username:
              r.identifier === "SELF_REFERENCE"
                ? context.creatorAddress
                : r.identifier,
            percentage: r.percentage || undefined,
          })),
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to extract fee receivers:", error);
      return null;
    }
  }

  /**
   * Resolve usernames to Ethereum addresses
   */
  static async resolveUsernames(
    context: FlowContext,
    receivers: FeeReceiver[]
  ): Promise<FeeReceiver[]> {
    const resolved = [];

    for (const receiver of receivers) {
      let address: string | undefined;

      // Check if it's already an Ethereum address
      if (isAddress(receiver.username)) {
        address = receiver.username;
      } else {
        // Try resolving via context helper
        try {
          address = await context.resolveUsername(receiver.username);
        } catch (error) {
          console.log(
            `[GroupCreation] ❌ Failed to resolve username: ${receiver.username}`
          );
        }
      }

      resolved.push({
        username: receiver.username,
        percentage: receiver.percentage,
        resolvedAddress: address,
      });
    }

    return resolved;
  }

  /**
   * Create group deployment transaction calls
   */
  static async createGroupDeploymentCalls(
    resolvedReceivers: FeeReceiver[],
    creatorAddress: string,
    chainConfig: ChainConfig,
    description?: string
  ): Promise<any> {
    // Validate receiver addresses
    const invalidReceivers = resolvedReceivers.filter(
      (r) =>
        !r.resolvedAddress ||
        !r.resolvedAddress.startsWith("0x") ||
        r.resolvedAddress.length !== 42
    );

    if (invalidReceivers.length > 0) {
      console.log(
        `[GroupCreation] ❌ Invalid addresses: ${invalidReceivers
          .map((r) => r.username)
          .join(", ")}`
      );
      throw new Error(
        `Invalid receiver addresses detected: ${invalidReceivers
          .map((r) => `${r.username}: ${r.resolvedAddress}`)
          .join(", ")}`
      );
    }

    // Deduplicate receivers first - combine shares for duplicate addresses
    const addressShareMap = new Map<Address, bigint>();
    const TOTAL_SHARE = 10000000n; // 100.00000% in contract format
    let totalAllocated = 0n;
    const receivers = Array.from(
      new Set(resolvedReceivers.map((r) => r.resolvedAddress!.toLowerCase()))
    ); // Deduplicated addresses

    // Validate all receivers have resolved addresses
    for (const receiver of resolvedReceivers) {
      if (!receiver.resolvedAddress) {
        throw new Error(
          `Receiver ${receiver.username} missing resolved address`
        );
      }
      if (!isAddress(receiver.resolvedAddress)) {
        throw new Error(
          `Invalid address for receiver ${receiver.username}: ${receiver.resolvedAddress}`
        );
      }
    }

    // Build address share map by combining duplicate addresses (case-insensitive)
    for (let i = 0; i < resolvedReceivers.length; i++) {
      const receiver = resolvedReceivers[i];
      const address = (
        receiver.resolvedAddress as string
      ).toLowerCase() as Address;

      let share: bigint;
      if (receiver.percentage) {
        // Use explicit percentage
        share = BigInt(Math.floor(receiver.percentage * 100000));
      } else {
        // Equal split calculation - fix rounding error by giving remainder to last receiver
        const baseShare = TOTAL_SHARE / BigInt(receivers.length);
        const remainder = TOTAL_SHARE % BigInt(receivers.length);
        const isLastUniqueReceiver = i === resolvedReceivers.length - 1;

        if (isLastUniqueReceiver) {
          // Last receiver gets base share plus any remainder to ensure total equals TOTAL_SHARE
          share = baseShare + remainder;
        } else {
          share = baseShare;
        }
      }

      const currentShare = addressShareMap.get(address) || 0n;
      addressShareMap.set(address, currentShare + share);
      totalAllocated += share;
    }

    // Validate total shares equal exactly TOTAL_SHARE (allow for small rounding errors)
    const calculatedTotal = Array.from(addressShareMap.values()).reduce(
      (sum, share) => sum + share,
      0n
    );
    const difference =
      calculatedTotal > TOTAL_SHARE
        ? calculatedTotal - TOTAL_SHARE
        : TOTAL_SHARE - calculatedTotal;

    // Allow for small rounding errors (up to 10 units, which is 0.001%)
    // The transaction will handle any remainder by giving it to the last user
    if (difference > 10n) {
      throw new Error(
        `Total shares (${calculatedTotal}) do not equal required total (${TOTAL_SHARE}). Difference: ${difference}`
      );
    }

    // If there's a small difference, adjust the last receiver to make it exactly TOTAL_SHARE
    if (difference > 0n) {
      const entries = Array.from(addressShareMap.entries());
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const [lastAddress, lastShare] = lastEntry;
        const adjustment =
          calculatedTotal > TOTAL_SHARE ? -difference : difference;
        addressShareMap.set(lastAddress, lastShare + adjustment);
      }
    }

    const finalTotal = Array.from(addressShareMap.values()).reduce(
      (sum, share) => sum + share,
      0n
    );

    // Calculate recipient shares using deduplicated data
    const recipientShares = Array.from(addressShareMap.entries()).map(
      ([address, share]) => ({
        recipient: address,
        share: share,
      })
    );

    // Encode initialization data for AddressFeeSplitManager
    const initializeData = encodeAbiParameters(
      [
        {
          type: "tuple",
          name: "_params",
          components: [
            { name: "creatorShare", type: "uint256" },
            {
              name: "recipientShares",
              type: "tuple[]",
              components: [
                { name: "recipient", type: "address" },
                { name: "share", type: "uint256" },
              ],
            },
          ],
        },
      ],
      [
        {
          creatorShare: BigInt(0), // Creator gets 0%
          recipientShares: recipientShares,
        },
      ]
    );

    const treasuryManagerFactory =
      TreasuryManagerFactoryAddress[chainConfig.id];
    const addressFeeSplitManagerImplementation =
      AddressFeeSplitManagerAddress[chainConfig.id];

    if (!treasuryManagerFactory || !addressFeeSplitManagerImplementation) {
      throw new Error(
        `Contract addresses not configured for chain ${
          chainConfig.displayName
        } (ID: ${chainConfig.id}). Available chains: ${Object.keys(
          TreasuryManagerFactoryAddress
        ).join(", ")}`
      );
    }

    const functionData = encodeFunctionData({
      abi: TreasuryManagerFactoryAbi,
      functionName: "deployAndInitializeManager",
      args: [
        addressFeeSplitManagerImplementation, // implementation
        creatorAddress as Address, // owner
        initializeData, // initializeData
      ],
    });

    const receiverList = resolvedReceivers
      .map((r) =>
        r.username.startsWith("@")
          ? r.username
          : `${r.resolvedAddress!.slice(0, 6)}...${r.resolvedAddress!.slice(
              -4
            )}`
      )
      .join(", ");

    const finalDescription = description || `Create Group for ${receiverList}`;
    const chainDescription = chainConfig.isTestnet
      ? ` (${chainConfig.displayName})`
      : "";

    const walletSendCalls = {
      version: "1.0",
      from: creatorAddress,
      chainId: chainConfig.hexId,
      calls: [
        {
          chainId: chainConfig.id,
          to: treasuryManagerFactory,
          data: functionData,
          value: "0",
          metadata: {
            description: finalDescription + chainDescription,
          },
        },
      ],
    };

    console.log(
      `[GroupCreation] ✅ Created group deployment transaction for ${resolvedReceivers.length} receivers (${addressShareMap.size} unique addresses)`
    );

    // Return wallet send calls in the correct format
    return walletSendCalls;
  }

  /**
   * Complete group creation workflow: extract → resolve → create transaction
   */
  static async createGroupFromMessage(
    context: FlowContext,
    chainConfig: ChainConfig = DEFAULT_CHAIN,
    description?: string
  ): Promise<GroupCreationResult | null> {
    try {
      // Extract fee receivers
      const extraction = await this.extractFeeReceivers(context);
      if (
        !extraction ||
        !extraction.receivers ||
        extraction.receivers.length === 0
      ) {
        return null;
      }

      // Resolve usernames to addresses
      const resolvedReceivers = await this.resolveUsernames(
        context,
        extraction.receivers
      );

      // Check if any failed to resolve
      const failed = resolvedReceivers.filter((r) => !r.resolvedAddress);
      if (failed.length > 0) {
        throw new Error(
          `Couldn't resolve these usernames: ${failed
            .map((r) => r.username)
            .join(", ")}`
        );
      }

      // Create transaction calls with proper error handling
      const walletSendCalls = await this.createGroupDeploymentCalls(
        resolvedReceivers,
        context.creatorAddress,
        chainConfig,
        description
      );

      return {
        walletSendCalls,
        resolvedReceivers,
        chainConfig,
      };
    } catch (error) {
      console.error("Failed to create group from message:", error);
      throw error; // Re-throw to let caller handle
    }
  }

  /**
   * Create a transaction message with proper receiver display (max 10, then "and N more")
   * This is the shared logic used across all flows for consistent messaging
   */
  static createTransactionMessage(
    receivers: FeeReceiver[],
    messageType: "created" | "updated" = "created"
  ): string {
    // Limit to first 10 receivers, show "and N more" for the rest
    const maxShown = 10;
    const shownReceivers = receivers.slice(0, maxShown);
    const remainingReceivers = receivers.slice(maxShown);

    // Create descriptive message with shown receiver names and percentages
    const receiverList = shownReceivers
      .map((r) => {
        const displayName =
          r.username && r.username.startsWith("@")
            ? r.username
            : r.username && !r.username.startsWith("0x")
            ? `@${r.username}`
            : r.resolvedAddress
            ? `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(
                -4
              )}`
            : "unknown";
        const percentage = r.percentage ? ` (${r.percentage.toFixed(1)}%)` : "";
        return `${displayName}${percentage}`;
      })
      .join(", ");

    // Add "and N more" if there are remaining receivers
    let finalReceiverList = receiverList;
    if (remainingReceivers.length > 0) {
      const remainingCount = remainingReceivers.length;
      const remainingPercentage = remainingReceivers.reduce(
        (sum, r) => sum + (r.percentage || 0),
        0
      );
      const remainingText =
        remainingPercentage > 0 ? ` (${remainingPercentage.toFixed(1)}%)` : "";
      finalReceiverList += `, and ${remainingCount} more${remainingText}`;
    }

    const memberCount = receivers.length;
    const memberText = memberCount === 1 ? "member" : "members";
    const actionText = messageType === "updated" ? "updated" : "";
    const actionVerb = messageType === "updated" ? "update" : "create";
    const splitText =
      messageType === "updated" ? ". the fee split has been updated" : "";

    return `sign the ${actionText} transaction to ${actionVerb} the group for ${finalReceiverList}. the group has ${memberCount} ${memberText}${splitText}.`;
  }

  /**
   * Handle percentage updates for existing receivers
   * This redistributes percentages when specific users get new percentages
   */
  static async handlePercentageUpdate(
    context: FlowContext,
    existingReceivers: FeeReceiver[],
    messageText: string
  ): Promise<FeeReceiver[]> {
    // Extract percentage updates from the message
    const extraction = await this.extractFeeReceivers(context);
    if (
      !extraction ||
      !extraction.receivers ||
      extraction.receivers.length === 0
    ) {
      throw new Error(
        "couldn't understand the percentage update. try something like 'give @alice 50%'."
      );
    }

    // Resolve new usernames
    const newReceivers = await this.resolveUsernames(
      context,
      extraction.receivers
    );

    // Check for resolution failures
    const failed = newReceivers.filter((r) => !r.resolvedAddress);
    if (failed.length > 0) {
      throw new Error(
        `couldn't resolve these usernames: ${failed
          .map((r) => r.username)
          .join(", ")}`
      );
    }

    // Create a map of existing receivers by address
    const existingMap = new Map<string, FeeReceiver>();
    for (const receiver of existingReceivers) {
      if (receiver.resolvedAddress) {
        existingMap.set(receiver.resolvedAddress.toLowerCase(), receiver);
      }
    }

    // Apply percentage updates
    const updatedReceivers = [...existingReceivers];
    let totalSpecifiedPercentage = 0;
    const receiversWithUpdates = new Set<string>();

    // Update receivers with new percentages
    for (const newReceiver of newReceivers) {
      if (newReceiver.percentage !== undefined && newReceiver.resolvedAddress) {
        const existingIndex = updatedReceivers.findIndex(
          (r) =>
            r.resolvedAddress?.toLowerCase() ===
            newReceiver.resolvedAddress?.toLowerCase()
        );

        if (existingIndex >= 0) {
          updatedReceivers[existingIndex].percentage = newReceiver.percentage;
          totalSpecifiedPercentage += newReceiver.percentage;
          receiversWithUpdates.add(newReceiver.resolvedAddress.toLowerCase());
        }
      }
    }

    // Calculate remaining percentage for other receivers
    const remainingPercentage = 100 - totalSpecifiedPercentage;
    const receiversForEqualSplit = updatedReceivers.filter(
      (r) =>
        r.resolvedAddress &&
        !receiversWithUpdates.has(r.resolvedAddress.toLowerCase())
    );

    if (remainingPercentage < 0) {
      throw new Error(
        "specified percentages exceed 100%. please use lower percentages."
      );
    }

    if (receiversForEqualSplit.length > 0) {
      const equalPercentage =
        remainingPercentage / receiversForEqualSplit.length;

      // Apply equal split to remaining receivers
      for (const receiver of receiversForEqualSplit) {
        receiver.percentage = equalPercentage;
      }
    }

    return updatedReceivers;
  }

  /**
   * Generate a unique, fun group name based on the receivers
   */
  static generateGroupName(receivers: FeeReceiver[]): string {
    // Badass adjectives that are powerful and energetic
    const adjectives = [
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epic",
      "Mega",
      "Super",
      "Ultra",
      "Prime",
      "Elite",
      "Turbo",
      "Rocket",
      "Stellar",
      "Cosmic",
      "Quantum",
      "Neon",
      "Cyber",
      "Digital",
      "Plasma",
      "Crystal",
      "Diamond",
      "Golden",
      "Silver",
      "Platinum",
      "Titanium",
      "Solar",
      "Lunar",
      "Nova",
      "Phoenix",
      "Thunder",
      "Lightning",
      "Storm",
      "Blaze",
      "Frost",
      "Shadow",
      "Mystic",
      "Atomic",
      "Electric",
      "Magnetic",
      "Kinetic",
      "Dynamic",
      "Static",
      "Omega",
      "Sigma",
      "Zeta",
      "Apex",
      "Vortex",
      "Matrix",
      "Vector",
      "Nexus",
      "Vertex",
      "Zenith",
      "Prism",
      "Fusion",
      "Pulse",
      "Surge",
      "Volt",
      "Flux",
      "Core",
      "Edge",
      "Razor",
      "Steel",
      "Iron",
      "Chrome",
      "Hyper",
      "Nitro",
      "Boost",
      "Rapid",
      "Swift",
      "Flash",
      "Sonic",
      "Laser",
      "Photon",
      "Neutron",
      "Proton",
      "Ion",
      "Titan",
      "Giant",
      "Mammoth",
      "Colossal",
      "Massive",
      "Infinite",
      "Eternal",
      "Immortal",
    ];

    // Powerful nouns that work well for trading groups
    const nouns = [
      "Squad",
      "Crew",
      "Gang",
      "Team",
      "Pack",
      "Guild",
      "Club",
      "Circle",
      "Alliance",
      "Union",
      "Collective",
      "Syndicate",
      "Network",
      "Hub",
      "Lab",
      "Factory",
      "Studio",
      "Workshop",
      "Forge",
      "Vault",
      "Chamber",
      "Arena",
      "Zone",
      "Realm",
      "Domain",
      "Empire",
      "Kingdom",
      "Republic",
      "Federation",
      "Coalition",
      "Assembly",
      "Council",
      "Senate",
      "Board",
      "Panel",
      "Committee",
      "Society",
      "Foundation",
      "Institute",
      "Academy",
      "Legion",
      "Battalion",
      "Regiment",
      "Division",
      "Force",
      "Unit",
      "Corps",
      "Brigade",
      "Platoon",
      "Militia",
      "Army",
      "Fleet",
      "Cartel",
      "Mafia",
      "Order",
      "Brotherhood",
      "Sisterhood",
      "Clan",
      "Tribe",
      "Dynasty",
      "House",
      "Court",
      "Throne",
      "Crown",
      "Fortress",
      "Citadel",
      "Stronghold",
      "Bastion",
      "Tower",
      "Castle",
      "Machine",
      "Engine",
      "Reactor",
      "Generator",
      "Turbine",
      "Motor",
      "System",
      "Protocol",
      "Algorithm",
      "Framework",
      "Structure",
      "Grid",
    ];

    // Create a hash from receiver addresses for consistent adjective/noun selection
    const addressString = receivers
      .map((r) => r.resolvedAddress?.toLowerCase() || "")
      .sort() // Sort to ensure consistent ordering for same receivers
      .join("");

    // Create hash for adjective and noun selection (should be consistent for same receivers)
    let hash = 0;
    for (let i = 0; i < addressString.length; i++) {
      const char = addressString.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Additional hash mixing to improve distribution
    hash = hash ^ (hash >>> 16);
    hash = hash * 0x85ebca6b;
    hash = hash ^ (hash >>> 13);
    hash = hash * 0xc2b2ae35;
    hash = hash ^ (hash >>> 16);

    // Use the hash to select adjective and noun (consistent for same receivers)
    const adjIndex = Math.abs(hash) % adjectives.length;
    const nounIndex = Math.abs(hash >> 8) % nouns.length;

    // Generate truly random suffix using multiple entropy sources
    // This ensures uniqueness even with same receivers and same timestamp
    const timestamp = Date.now();
    const random1 = Math.random();
    const random2 = Math.random();
    const performanceNow =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    // Combine multiple sources of entropy for the suffix
    const entropyForSuffix =
      timestamp + random1 * 1000000 + random2 * 1000000 + performanceNow;
    const suffix = Math.floor(entropyForSuffix) % 10000; // 0-9999 for more uniqueness

    const generatedName = `${adjectives[adjIndex]} ${nouns[nounIndex]} ${suffix}`;

    console.log("🎯 Group name generation:", {
      receiverCount: receivers.length,
      addressString: addressString.substring(0, 50) + "...",
      timestamp,
      hash,
      adjIndex,
      nounIndex,
      suffix,
      entropyForSuffix,
      generatedName,
    });

    return generatedName;
  }

  /**
   * Shared error handling for group creation across all flows
   */
  static handleGroupCreationError(error: any): string {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes("Total shares") &&
      errorMessage.includes("do not equal required total")
    ) {
      return "error updating percentages - they don't add up to 100%. please try again.";
    } else if (errorMessage.includes("Couldn't resolve these usernames")) {
      return errorMessage.toLowerCase();
    } else if (errorMessage.includes("specified percentages exceed 100%")) {
      return errorMessage;
    } else if (
      errorMessage.includes("couldn't understand the percentage update")
    ) {
      return errorMessage;
    } else if (errorMessage.includes("couldn't resolve these usernames")) {
      return errorMessage;
    } else {
      console.error("Group creation error:", error);
      return "something went wrong creating the group. please try again or contact support.";
    }
  }

  /**
   * Generate a badass introduction message for a newly created group
   */
  static async generateGroupIntroduction(
    groupName: string,
    receivers: FeeReceiver[],
    openai: any,
    includesCoinPrompt: boolean = false
  ): Promise<string> {
    try {
      const memberCount = receivers.length;
      const receiverNames = receivers
        .slice(0, 3) // Show first 3 members
        .map((r) =>
          r.username.startsWith("@") ? r.username : `@${r.username}`
        )
        .join(", ");

      const moreMembers = memberCount > 3 ? ` and ${memberCount - 3} more` : "";
      const memberList = `${receiverNames}${moreMembers}`;

      const coinPromptText = includesCoinPrompt
        ? "\n\nnow for the exciting part - what coin do you want to launch? give me a name, ticker, and image!"
        : "";

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Write a short, badass announcement for a newly created trading group. The group is called ${groupName} and has ${memberCount} members: ${memberList}.

Make it feel like something important and powerful just got created. Keep it:
- Short (1 sentence max)
- Exciting and energetic 
- Not cringe or over-the-top
- Professional but with personality
- About the group being ready to trade/make moves

Examples of tone:
- "${groupName}" just got locked in onchain and is ready to dominate!
- Your Group "${groupName}" has entered the game
- Welcome to "${groupName}" - let's make some moves

Don't use the exact examples - create something original that fits the group name and vibe.${
              coinPromptText
                ? `

IMPORTANT: After the celebration, add this exact text: ${coinPromptText.trim()}`
                : ""
            }`,
          },
        ],
        temperature: 0.7,
        max_tokens: 80,
      });

      const message = response.choices[0]?.message?.content?.trim();
      return message || `${groupName} is ready to roll! 🚀${coinPromptText}`;
    } catch (error) {
      console.error("Failed to generate group introduction:", error);
      // Fallback to a simple but energetic message
      const coinPromptText = includesCoinPrompt
        ? "\n\nnow for the exciting part - what coin do you want to launch? give me a name, ticker, and image!"
        : "";
      return `${groupName} is live and ready to trade! 🚀${coinPromptText}`;
    }
  }

  /**
   * Generate a standardized group display format
   */
  static formatGroupDisplay(
    group: any,
    aggregatedData: any,
    options: {
      showClaimable?: boolean;
      claimableAmount?: number;
      includeEmoji?: boolean;
    } = {}
  ): string {
    const {
      showClaimable = false,
      claimableAmount = 0,
      includeEmoji = true,
    } = options;

    // Format group header
    const emoji = includeEmoji ? "📁 " : "• ";
    const addressDisplay = `${group.id.slice(0, 8)}...${group.id.slice(-6)}`;
    let display = `${emoji}"${group.name}" (${addressDisplay})\n`;

    // Format coins - use aggregated data instead of userState
    const groupCoins =
      aggregatedData.allCoins?.filter(
        (coin: any) =>
          coin.groupId?.toLowerCase() === group.id.toLowerCase() &&
          coin.launched
      ) || [];

    const coinTickers = groupCoins.map((coin: any) => coin.ticker);
    const coinsDisplay =
      coinTickers.length > 0 ? coinTickers.join(", ") : "none yet";
    display += `- coins: ${coinsDisplay}\n`;

    // Format fee receivers
    if (group.receivers && group.receivers.length > 0) {
      const receiverDisplays = group.receivers.map((receiver: any) => {
        // Prefer username if available and not an address format
        let displayName = receiver.username;

        // If username is an address or not available, format the address nicely
        if (
          !displayName ||
          (displayName.startsWith("0x") && displayName.length === 42)
        ) {
          const address = receiver.resolvedAddress || receiver.username;
          if (address && address.startsWith("0x") && address.length === 42) {
            displayName = `${address.slice(0, 6)}...${address.slice(-4)}`;
          } else {
            displayName = address || "unknown";
          }
        }

        // Add @ prefix if not already present and it's not an address format
        if (
          displayName &&
          !displayName.startsWith("@") &&
          !displayName.includes("...")
        ) {
          displayName = `@${displayName}`;
        }

        // Add percentage if available
        const percentage = receiver.percentage
          ? ` (${receiver.percentage.toFixed(1)}%)`
          : "";
        return `${displayName}${percentage}`;
      });

      display += `- fee receivers: ${receiverDisplays.join(", ")}\n`;
    }

    // Add claimable amount if requested
    if (showClaimable) {
      display += `- claimable: ${claimableAmount.toFixed(6)} ETH\n`;
    }

    return display;
  }

  /**
   * Generate a standardized group display format with ENS resolution
   */
  static async formatGroupDisplayWithENS(
    group: any,
    aggregatedData: any,
    ensResolver: any,
    options: {
      showClaimable?: boolean;
      claimableAmount?: number;
      includeEmoji?: boolean;
    } = {}
  ): Promise<string> {
    const {
      showClaimable = false,
      claimableAmount = 0,
      includeEmoji = true,
    } = options;

    // Format group header with full address
    const emoji = includeEmoji ? "📁 " : "• ";
    let display = `${emoji}"${group.name}" (${group.id})\n`;

    // Format coins - use aggregated data instead of userState
    const groupCoins =
      aggregatedData.allCoins?.filter(
        (coin: any) =>
          coin.groupId?.toLowerCase() === group.id.toLowerCase() &&
          coin.launched
      ) || [];

    const coinTickers = groupCoins.map((coin: any) => coin.ticker);
    const coinsDisplay =
      coinTickers.length > 0 ? coinTickers.join(", ") : "none yet";
    display += `- coins: ${coinsDisplay}\n`;

    // Format fee receivers with ENS resolution
    if (group.receivers && group.receivers.length > 0) {
      try {
        // Collect addresses for ENS resolution
        const addresses = group.receivers
          .map((receiver: any) => receiver.resolvedAddress)
          .filter(
            (addr: string) =>
              addr && addr.startsWith("0x") && addr.length === 42
          );

        // Resolve all addresses at once
        const addressMap = await this.formatAddresses(addresses, ensResolver);

        const receiverDisplays = group.receivers.map((receiver: any) => {
          let displayName = receiver.username;

          // If username is an address or not available, use ENS resolution
          if (
            !displayName ||
            (displayName.startsWith("0x") && displayName.length === 42)
          ) {
            const address = receiver.resolvedAddress || receiver.username;
            if (address && address.startsWith("0x") && address.length === 42) {
              displayName =
                addressMap.get(address.toLowerCase()) ||
                `${address.slice(0, 6)}...${address.slice(-4)}`;
            } else {
              displayName = address || "unknown";
            }
          }

          // Add percentage if available
          const percentage = receiver.percentage
            ? ` (${receiver.percentage.toFixed(1)}%)`
            : "";
          return `${displayName}${percentage}`;
        });

        display += `- fee receivers: ${receiverDisplays.join(", ")}\n`;
      } catch (error) {
        console.error("Failed to resolve ENS for group display:", error);
        // Fallback to original formatting
        const receiverDisplays = group.receivers.map((receiver: any) => {
          const address = receiver.resolvedAddress || receiver.username;
          const displayName =
            address && address.startsWith("0x") && address.length === 42
              ? `${address.slice(0, 6)}...${address.slice(-4)}`
              : receiver.username || "unknown";
          const percentage = receiver.percentage
            ? ` (${receiver.percentage.toFixed(1)}%)`
            : "";
          return `${displayName}${percentage}`;
        });
        display += `- fee receivers: ${receiverDisplays.join(", ")}\n`;
      }
    }

    // Add claimable amount if requested
    if (showClaimable) {
      display += `- claimable: ${claimableAmount.toFixed(6)} ETH\n`;
    }

    return display;
  }

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

  /**
   * Format receiver display names with ENS resolution
   */
  static async formatReceiversWithENS(
    receivers: FeeReceiver[],
    ensResolver: any
  ): Promise<string[]> {
    try {
      // Collect all addresses that need resolution
      const addressesToResolve = receivers
        .filter((r) => r.resolvedAddress)
        .map((r) => r.resolvedAddress!);

      // Resolve all addresses at once
      const addressMap = await this.formatAddresses(
        addressesToResolve,
        ensResolver
      );

      // Format each receiver
      return receivers.map((r) => {
        if (
          r.username &&
          r.username !== r.resolvedAddress &&
          !r.username.startsWith("0x")
        ) {
          // Username is already resolved (e.g., @javery)
          return r.username.startsWith("@") ? r.username : `@${r.username}`;
        } else if (r.resolvedAddress) {
          // Use ENS-resolved display name
          return (
            addressMap.get(r.resolvedAddress.toLowerCase()) ||
            `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(-4)}`
          );
        } else {
          return r.username || "Unknown";
        }
      });
    } catch (error) {
      console.error("Failed to format receivers with ENS:", error);
      // Fallback to original logic
      return receivers.map((r) => {
        if (
          r.username &&
          r.username !== r.resolvedAddress &&
          !r.username.startsWith("0x")
        ) {
          return r.username.startsWith("@") ? r.username : `@${r.username}`;
        } else if (r.resolvedAddress) {
          return `${r.resolvedAddress.slice(0, 6)}...${r.resolvedAddress.slice(
            -4
          )}`;
        } else {
          return r.username || "Unknown";
        }
      });
    }
  }

  /**
   * Create transaction message with ENS-resolved names
   */
  static async createTransactionMessageWithENS(
    receivers: FeeReceiver[],
    action: string,
    ensResolver: any
  ): Promise<string> {
    const displayNames = await this.formatReceiversWithENS(
      receivers,
      ensResolver
    );

    // Create numbered list with percentages - show all members
    const membersList = receivers
      .map((receiver, index) => {
        const displayName = displayNames[index];
        const percentage = receiver.percentage
          ? ` - ${receiver.percentage.toFixed(1)}%`
          : "";
        return `${index + 1}. ${displayName}${percentage}`;
      })
      .join("\n");

    // Create natural, excited messages based on the action
    if (action === "creating") {
      return `creating group with ${receivers.length} members:\n${membersList}`;
    } else if (action === "updated") {
      return `updated group with ${receivers.length} members:\n${membersList}`;
    } else {
      // For 'created' and other actions, generate an excited confirmation
      const memberCount = receivers.length;

      // Generate excited messages similar to group introductions
      const excitedMessages = [
        `ready to create a group for ${memberCount} members:\n${membersList}\nlet's make some moves!`,
        `${memberCount}-member group is ready to deploy:\n${membersList}\nready to dominate!`,
        `transaction ready:\n${membersList}\ntime to trade!`,
        `${memberCount} members strong:\n${membersList}\ngroup is ready to deploy!`,
        `sign to create a group for ${memberCount} members:\n${membersList}\nlet's get this bread!`,
      ];

      // Pick a random excited message
      const randomIndex = Math.floor(Math.random() * excitedMessages.length);
      return excitedMessages[randomIndex];
    }
  }
}

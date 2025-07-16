import { SessionManager } from "../core/session/SessionManager";
import { UserCoin } from "../core/types/UserState";
import { GroupCoin, GroupManager } from "../core/types/GroupState";
import {
  GroupCreationUtils,
  FeeReceiver,
} from "../flows/utils/GroupCreationUtils";

/**
 * Service to handle storing groups for all receivers
 * Uses the new group-centric architecture exclusively
 * Groups are stored by group chat IDs with Ethereum addresses as participants
 */
export class GroupStorageService {
  constructor(private sessionManager: SessionManager) {}

  // ================================
  // GROUP-CENTRIC METHODS
  // ================================

  /**
   * Store a manager and add all participants to a group chat in the new architecture
   * This replaces the old method of storing the same group across multiple user states
   */
  async storeManagerInGroupChat(
    groupChatId: string,
    creatorAddress: string,
    contractAddress: string,
    receivers: FeeReceiver[],
    chainId: number,
    chainName: "base" | "baseSepolia",
    txHash: string
  ): Promise<string> {
    const groupStateManager = this.sessionManager.getGroupStateManager();

    // Generate a fun group name
    const groupName = GroupCreationUtils.generateGroupName(receivers);

    // Create the manager object for the new architecture
    const newManager: GroupManager = {
      contractAddress,
      deployedAt: new Date(),
      txHash,
      deployedBy: creatorAddress,
      chainId,
      chainName,
      receivers: receivers.map((r) => ({
        username: r.username,
        resolvedAddress: r.resolvedAddress!,
        percentage: r.percentage || 0,
      })),
    };

    // Collect all participant addresses
    const allAddresses = new Set<string>();

    // Add creator's address
    if (
      creatorAddress &&
      creatorAddress.startsWith("0x") &&
      creatorAddress.length === 42
    ) {
      allAddresses.add(creatorAddress.toLowerCase());
    }

    // Add all fee receiver addresses
    for (const receiver of receivers) {
      if (
        receiver.resolvedAddress &&
        receiver.resolvedAddress.startsWith("0x") &&
        receiver.resolvedAddress.length === 42
      ) {
        allAddresses.add(receiver.resolvedAddress.toLowerCase());
      }
    }

    console.log(
      `[GroupStorageService] New Architecture: Creating group ${groupChatId} with ${allAddresses.size} participants`
    );

    // Initialize or get existing group chat state
    let groupState = await groupStateManager.getGroupState(groupChatId);

    if (!groupState) {
      // Create new group chat state
      groupState = await groupStateManager.initializeGroup(
        groupChatId,
        creatorAddress,
        {
          name: groupName,
          description: `Group manager: ${contractAddress.slice(0, 8)}...`,
        }
      );
    }

    // Add the manager to the group
    await groupStateManager.addManager(groupChatId, newManager);

    // Add all participants to the group
    for (const address of allAddresses) {
      await groupStateManager.addParticipant(groupChatId, address, "active");
    }

    console.log(
      `[GroupStorageService] ✅ New Architecture: Group ${groupChatId} created with manager ${contractAddress}`
    );
    return groupName;
  }

  /**
   * Add a coin to a group chat in the new architecture
   */
  async addCoinToGroupChat(
    groupChatId: string,
    coin: Omit<GroupCoin, "managerAddress">,
    managerAddress: string
  ): Promise<void> {
    const groupStateManager = this.sessionManager.getGroupStateManager();

    const groupCoin: GroupCoin = {
      ...coin,
      managerAddress,
    };

    await groupStateManager.addCoin(groupChatId, groupCoin);

    console.log(
      `[GroupStorageService] ✅ New Architecture: Added coin ${coin.ticker} to group ${groupChatId}`
    );
  }

  // ================================
  // SIMPLIFIED HYBRID METHODS
  // ================================

  /**
   * Smart method that stores managers using the group-centric architecture
   */
  async storeManagerSmart(
    groupChatId: string,
    creatorAddress: string,
    contractAddress: string,
    receivers: FeeReceiver[],
    chainId: number,
    chainName: "base" | "baseSepolia",
    txHash: string
  ): Promise<string> {
    console.log("[GroupStorageService] Using group-centric architecture");
    return await this.storeManagerInGroupChat(
      groupChatId,
      creatorAddress,
      contractAddress,
      receivers,
      chainId,
      chainName,
      txHash
    );
  }

  /**
   * Smart method that adds coins using the group-centric architecture
   */
  async addCoinSmart(
    groupChatId: string,
    coin: UserCoin,
    managerAddress: string,
    creatorAddress: string
  ): Promise<void> {
    console.log("[GroupStorageService] Adding coin with new architecture");

    // Convert UserCoin to GroupCoin format
    const groupCoin: Omit<GroupCoin, "managerAddress"> = {
      ticker: coin.ticker,
      name: coin.name,
      image: coin.image,
      contractAddress: coin.contractAddress || "",
      txHash: coin.txHash || "",
      launchedAt: coin.createdAt,
      launchedBy: creatorAddress,
      chainId: coin.chainId,
      chainName: coin.chainName,
      fairLaunchDuration: coin.fairLaunchDuration,
      fairLaunchPercent: coin.fairLaunchPercent,
      initialMarketCap: coin.initialMarketCap,
      liveData: coin.liveData,
    };

    await this.addCoinToGroupChat(groupChatId, groupCoin, managerAddress);
  }

  /**
   * Get group information using the group-centric architecture
   */
  async getGroupInfo(groupChatId: string): Promise<{
    managers: GroupManager[];
    coins: GroupCoin[];
    participants: Record<string, any>;
  } | null> {
    const groupStateManager = this.sessionManager.getGroupStateManager();
    const groupState = await groupStateManager.getGroupState(groupChatId);

    if (groupState) {
      return {
        managers: groupState.managers,
        coins: groupState.coins,
        participants: groupState.participants,
      };
    }

    return null;
  }

  /**
   * Check if a group exists in the new architecture
   */
  async groupExistsInNewArchitecture(groupChatId: string): Promise<boolean> {
    const groupStateManager = this.sessionManager.getGroupStateManager();
    const groupState = await groupStateManager.getGroupState(groupChatId);
    return !!groupState;
  }
}

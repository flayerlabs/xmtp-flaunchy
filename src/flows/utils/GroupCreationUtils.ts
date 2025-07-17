export interface FeeReceiver {
  username: string;
  percentage?: number;
  resolvedAddress?: string;
}

export class GroupCreationUtils {
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
}

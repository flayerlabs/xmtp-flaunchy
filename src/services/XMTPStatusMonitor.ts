import * as fs from "fs";
import * as path from "path";
import axios from "axios";

interface RSSItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

interface StatusIncident {
  title: string;
  link: string;
  guid: string;
  pubDate: Date;
  description: string;
  isResolved: boolean;
  affectedComponents: string[];
}

export class XMTPStatusMonitor {
  private readonly RSS_URL = "https://status.xmtp.org/feed.rss";
  private readonly STATUS_FILE_PATH: string;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private startupTime: Date;
  private isMonitoring = false;
  private intervalId?: NodeJS.Timeout;
  private onRestartCallback?: () => void;

  constructor(volumePath: string = ".data") {
    this.STATUS_FILE_PATH = path.join(volumePath, "xmtp-status-monitor.json");
    this.startupTime = new Date();
    this.ensureStatusFileExists();
  }

  /**
   * Ensures the status file exists and initializes it if needed
   */
  private ensureStatusFileExists(): void {
    if (!fs.existsSync(path.dirname(this.STATUS_FILE_PATH))) {
      fs.mkdirSync(path.dirname(this.STATUS_FILE_PATH), { recursive: true });
    }

    if (!fs.existsSync(this.STATUS_FILE_PATH)) {
      const initialData = {
        lastStartupTime: this.startupTime.toISOString(),
        lastCheckedIncidents: [],
      };
      fs.writeFileSync(
        this.STATUS_FILE_PATH,
        JSON.stringify(initialData, null, 2)
      );
    }
  }

  /**
   * Fetches and parses the RSS feed
   */
  private async fetchRSSFeed(): Promise<StatusIncident[]> {
    try {
      console.log("📡 Fetching XMTP status RSS feed...");
      const response = await axios.get(this.RSS_URL);

      if (response.status !== 200) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const xmlData = response.data as string;
      const incidents: StatusIncident[] = [];

      // Parse RSS items using regex (simple but effective for this specific feed)
      const itemRegex = /<item>(.*?)<\/item>/gs;
      const items = xmlData.match(itemRegex) || [];

      for (const itemXml of items) {
        // Extract individual fields
        const title = this.extractXmlContent(itemXml, "title");
        const link = this.extractXmlContent(itemXml, "link");
        const guid = this.extractXmlContent(itemXml, "guid");
        const pubDate = this.extractXmlContent(itemXml, "pubDate");
        const description = this.extractXmlContent(itemXml, "description");

        if (!title || !link || !pubDate || !description) {
          continue; // Skip malformed items
        }

        const isResolved = description.includes("<b>Status: Resolved</b>");

        // Extract affected components
        const affectedComponents: string[] = [];
        const componentMatch = description.match(
          /<b>Affected components<\/b>\s*<ul>(.*?)<\/ul>/s
        );
        if (componentMatch) {
          const componentList = componentMatch[1];
          const componentMatches = componentList.match(
            /<li>(.*?)\s*\([^)]*\)<\/li>/g
          );
          if (componentMatches) {
            componentMatches.forEach((match) => {
              const component = match.replace(
                /<li>(.*?)\s*\([^)]*\)<\/li>/,
                "$1"
              );
              affectedComponents.push(component.trim());
            });
          }
        }

        incidents.push({
          title: this.stripCDATA(title!),
          link: link!,
          guid: guid!,
          pubDate: new Date(pubDate!),
          description: description!,
          isResolved,
          affectedComponents,
        });
      }

      return incidents;
    } catch (error) {
      console.error("❌ Error fetching RSS feed:", error);
      throw error;
    }
  }

  /**
   * Extracts content from XML tags
   */
  private extractXmlContent(xml: string, tagName: string): string | null {
    const regex = new RegExp(`<${tagName}[^>]*>(.*?)<\/${tagName}>`, "s");
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Strips CDATA wrapper from content
   */
  private stripCDATA(content: string): string {
    return content.replace(/^<!\[CDATA\[(.*?)\]\]>$/s, "$1");
  }

  /**
   * Checks for new issues since the last startup
   */
  private async checkForNewIssues(): Promise<boolean> {
    try {
      const incidents = await this.fetchRSSFeed();
      const statusData = JSON.parse(
        fs.readFileSync(this.STATUS_FILE_PATH, "utf8")
      );
      const lastStartupTime = new Date(statusData.lastStartupTime);

      // Filter incidents that are:
      // 1. Not resolved AND published after startup time
      // 2. OR affect Node SDK/Production network and are recent
      const criticalIncidents = incidents.filter((incident) => {
        const isAfterStartup = incident.pubDate > lastStartupTime;
        const isNodeSDKIssue = incident.affectedComponents.some(
          (component) =>
            component.toLowerCase().includes("node sdk") ||
            component.toLowerCase().includes("production network")
        );

        return (
          (!incident.isResolved && isAfterStartup) ||
          (!incident.isResolved && isNodeSDKIssue)
        );
      });

      if (criticalIncidents.length > 0) {
        console.log("🚨 Critical XMTP issues detected:");
        criticalIncidents.forEach((incident) => {
          console.log(
            `  - ${incident.title} (${incident.pubDate.toISOString()})`
          );
          console.log(
            `    Status: ${incident.isResolved ? "Resolved" : "Active"}`
          );
          console.log(
            `    Components: ${incident.affectedComponents.join(", ")}`
          );
          console.log(`    Link: ${incident.link}`);
        });
        return true;
      }

      // Check for new resolved issues that might indicate we should restart
      const newResolvedIssues = incidents.filter((incident) => {
        const isAfterStartup = incident.pubDate > lastStartupTime;
        const isNodeSDKIssue = incident.affectedComponents.some(
          (component) =>
            component.toLowerCase().includes("node sdk") ||
            component.toLowerCase().includes("production network")
        );

        return incident.isResolved && isAfterStartup && isNodeSDKIssue;
      });

      if (newResolvedIssues.length > 0) {
        console.log("✅ XMTP issues have been resolved since startup:");
        newResolvedIssues.forEach((incident) => {
          console.log(
            `  - ${
              incident.title
            } (Resolved at ${incident.pubDate.toISOString()})`
          );
        });
        console.log(
          "🔄 Restarting to ensure we're running with the latest fixes..."
        );
        return true;
      }

      console.log("✅ No critical XMTP issues detected");
      return false;
    } catch (error) {
      console.error("❌ Error checking for issues:", error);
      return false;
    }
  }

  /**
   * Starts monitoring the RSS feed
   */
  public startMonitoring(onRestartCallback?: () => void): void {
    if (this.isMonitoring) {
      console.log("⚠️ Status monitor is already running");
      return;
    }

    this.onRestartCallback = onRestartCallback;
    this.isMonitoring = true;

    console.log(
      `🔍 Starting XMTP status monitoring (checking every ${
        this.CHECK_INTERVAL / 1000 / 60
      } minutes)`
    );
    console.log(`📅 Startup time: ${this.startupTime.toISOString()}`);

    // Update startup time in status file
    const statusData = JSON.parse(
      fs.readFileSync(this.STATUS_FILE_PATH, "utf8")
    );
    statusData.lastStartupTime = this.startupTime.toISOString();
    fs.writeFileSync(
      this.STATUS_FILE_PATH,
      JSON.stringify(statusData, null, 2)
    );

    // Initial check
    this.performCheck();

    // Set up interval
    this.intervalId = setInterval(() => {
      this.performCheck();
    }, this.CHECK_INTERVAL);
  }

  /**
   * Performs a single check
   */
  private async performCheck(): Promise<void> {
    try {
      const shouldRestart = await this.checkForNewIssues();

      if (shouldRestart) {
        console.log("🔄 Initiating restart due to XMTP status changes...");
        this.stopMonitoring();

        if (this.onRestartCallback) {
          this.onRestartCallback();
        } else {
          // Default restart behavior
          console.log("🔄 Restarting process...");
          process.exit(0); // Let process manager restart us
        }
      }
    } catch (error) {
      console.error("❌ Error during status check:", error);
    }
  }

  /**
   * Stops monitoring
   */
  public stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isMonitoring = false;
    console.log("🛑 XMTP status monitoring stopped");
  }

  /**
   * Performs a manual check without starting monitoring
   */
  public async performManualCheck(): Promise<boolean> {
    console.log("🔍 Performing manual XMTP status check...");
    return await this.checkForNewIssues();
  }

  /**
   * Gets the current monitoring status
   */
  public getStatus(): {
    isMonitoring: boolean;
    startupTime: Date;
    checkInterval: number;
  } {
    return {
      isMonitoring: this.isMonitoring,
      startupTime: this.startupTime,
      checkInterval: this.CHECK_INTERVAL,
    };
  }
}

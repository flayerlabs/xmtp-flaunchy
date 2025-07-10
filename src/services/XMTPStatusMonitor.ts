import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { Client } from "@xmtp/node-sdk";

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

interface ApplicationResources {
  client: Client;
  statusMonitor: XMTPStatusMonitor;
  messageStream: any;
  cleanup: () => Promise<void>;
}

const displayStatusLogs = process.env.DISPLAY_STATUS_LOGS === "true";

export class XMTPStatusMonitor {
  private readonly RSS_URL = "https://status.xmtp.org/feed.rss";
  private readonly STATUS_FILE_PATH: string;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private startupTime: Date;
  private isMonitoring = false;
  private intervalId?: NodeJS.Timeout;

  // Restart management
  private isRestarting = false;
  private applicationFactory?: () => Promise<ApplicationResources>;
  private currentResources?: ApplicationResources;

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
      if (displayStatusLogs) {
        console.log("📡 Fetching XMTP status RSS feed...");
      }
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
      if (displayStatusLogs) {
        console.log(`📊 Found ${incidents.length} total incidents in RSS feed`);
      }

      const statusData = JSON.parse(
        fs.readFileSync(this.STATUS_FILE_PATH, "utf8")
      );
      const lastStartupTime = new Date(statusData.lastStartupTime);
      if (displayStatusLogs) {
        console.log(`📅 Last startup time: ${lastStartupTime.toISOString()}`);
      }

      // Filter incidents that are:
      // 1. Not resolved AND published after startup time
      // 2. OR affect Node SDK/Production network and are recent (within last 24 hours)
      const now = new Date();
      const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const criticalIncidents = incidents.filter((incident) => {
        const isAfterStartup = incident.pubDate > lastStartupTime;
        const isRecent = incident.pubDate > last24Hours;
        const isNodeSDKIssue = incident.affectedComponents.some(
          (component) =>
            component.toLowerCase().includes("node sdk") ||
            component.toLowerCase().includes("production network") ||
            component.toLowerCase().includes("dev network")
        );

        // Log each incident for debugging
        if (displayStatusLogs) {
          console.log(`🔍 Checking incident: ${incident.title}`);
          console.log(`  📅 Published: ${incident.pubDate.toISOString()}`);
          console.log(`  ✅ Resolved: ${incident.isResolved}`);
          console.log(
            `  🎯 Components: ${incident.affectedComponents.join(", ")}`
          );
          console.log(`  🕒 After startup: ${isAfterStartup}`);
          console.log(`  📈 Recent: ${isRecent}`);
          console.log(`  🔧 Node SDK issue: ${isNodeSDKIssue}`);
        }

        return (
          (!incident.isResolved && isAfterStartup) ||
          (!incident.isResolved && isNodeSDKIssue && isRecent)
        );
      });

      if (criticalIncidents.length > 0 && displayStatusLogs) {
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
        const isRecent = incident.pubDate > last24Hours;
        const isNodeSDKIssue = incident.affectedComponents.some(
          (component) =>
            component.toLowerCase().includes("node sdk") ||
            component.toLowerCase().includes("production network") ||
            component.toLowerCase().includes("dev network")
        );

        return (
          incident.isResolved && isAfterStartup && isNodeSDKIssue && isRecent
        );
      });

      if (newResolvedIssues.length > 0 && displayStatusLogs) {
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

      if (displayStatusLogs) {
        console.log("✅ No critical XMTP issues detected");
      }
      return false;
    } catch (error) {
      console.error("❌ Error checking for issues:", error);
      return false;
    }
  }

  /**
   * Cleanup function to properly close connections before restart
   */
  private async cleanup(): Promise<void> {
    console.log("🧹 Cleaning up resources before restart...");

    try {
      if (this.currentResources) {
        await this.currentResources.cleanup();
        this.currentResources = undefined;
      }

      console.log("✅ Cleanup completed");
    } catch (error) {
      console.error("❌ Error during cleanup:", error);
    }
  }

  /**
   * Handles application restart
   */
  private async handleRestart(): Promise<void> {
    if (this.isRestarting) {
      console.log(
        "⚠️ Restart already in progress, ignoring duplicate restart request"
      );
      return;
    }

    if (!this.applicationFactory) {
      console.error("❌ No application factory provided, cannot restart");
      return;
    }

    this.isRestarting = true;
    console.log("🔄 XMTP status monitor triggered restart");

    try {
      // Cleanup current resources
      await this.cleanup();

      // Wait a moment to ensure cleanup is complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Restart the application with monitoring
      console.log("🚀 Restarting application...");
      await this.runApplication(true); // true indicates to restart monitoring

      // Reset restart flag after successful restart
      this.isRestarting = false;
    } catch (error) {
      console.error("❌ Error during restart:", error);
      this.isRestarting = false;

      // If restart fails, try again after a delay
      console.log("⏳ Retrying restart in 10 seconds...");
      setTimeout(async () => {
        await this.handleRestart();
      }, 10000);
    }
  }

  /**
   * Runs the application using the provided factory
   */
  private async runApplication(
    restartMonitoring: boolean = false
  ): Promise<void> {
    if (!this.applicationFactory) {
      throw new Error("No application factory provided");
    }

    try {
      // Create new application resources
      this.currentResources = await this.applicationFactory();

      // Update startup time
      this.startupTime = new Date();
      const statusData = JSON.parse(
        fs.readFileSync(this.STATUS_FILE_PATH, "utf8")
      );
      statusData.lastStartupTime = this.startupTime.toISOString();
      fs.writeFileSync(
        this.STATUS_FILE_PATH,
        JSON.stringify(statusData, null, 2)
      );

      // Restart monitoring if this is a restart (not initial startup)
      if (restartMonitoring) {
        console.log("🔄 Restarting monitoring after application restart...");
        this.startMonitoring();
      }

      console.log("✅ Application restarted successfully!");
    } catch (error) {
      console.error("❌ Error running application:", error);
      throw error;
    }
  }

  /**
   * Starts the application with monitoring
   */
  public async startWithMonitoring(
    applicationFactory: () => Promise<ApplicationResources>
  ): Promise<void> {
    this.applicationFactory = applicationFactory;

    console.log("🚀 Starting application with XMTP status monitoring...");

    // Start the application for the first time
    await this.runApplication(false); // false since this is initial startup

    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Starts monitoring the RSS feed (internal method)
   */
  private startMonitoring(): void {
    if (this.isMonitoring) {
      console.log("⚠️ Status monitor is already running");
      return;
    }

    this.isMonitoring = true;

    console.log(
      `🔍 Starting XMTP status monitoring (checking every ${
        this.CHECK_INTERVAL / 1000 / 60
      } minutes)`
    );
    console.log(`📅 Startup time: ${this.startupTime.toISOString()}`);

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
      if (displayStatusLogs) {
        console.log("🔍 Checking XMTP status...");
      }
      const shouldRestart = await this.checkForNewIssues();

      if (shouldRestart) {
        console.log("🚨 XMTP status indicates restart is needed!");
        console.log("🔄 Initiating restart due to XMTP status changes...");

        // Stop monitoring immediately to prevent multiple restart attempts
        this.stopMonitoring();

        // Execute restart with a slight delay to ensure logs are written
        setTimeout(async () => {
          await this.handleRestart();
        }, 1000);
      }
    } catch (error) {
      console.error("❌ Error during status check:", error);
      // Continue monitoring even if a single check fails
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

  /**
   * Triggers an immediate restart check (for testing/debugging)
   */
  public async triggerImmediateCheck(): Promise<void> {
    console.log("🔄 Triggering immediate XMTP status check...");
    await this.performCheck();
  }

  /**
   * Forces a restart (for testing/debugging)
   */
  public async forceRestart(): Promise<void> {
    console.log("🔄 Forcing restart...");
    this.stopMonitoring();
    await this.handleRestart();
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    console.log("🛑 Shutting down XMTP status monitor...");
    this.stopMonitoring();
    await this.cleanup();
  }
}

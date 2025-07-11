/**
 * Utility to help users experiencing XMTP installation limit issues
 */

export interface InstallationLimitInfo {
  isInstallationLimitError: boolean;
  senderInboxId?: string;
  helpMessage?: string;
  technicalDetails?: string;
}

export class InstallationLimitHelper {
  /**
   * Detect if an error or user interaction suggests installation limit issues
   */
  static analyzeInstallationLimit(
    error: any,
    senderInboxId?: string
  ): InstallationLimitInfo {
    const errorMessage = error?.message?.toLowerCase() || "";

    const limitPatterns = [
      "installation limit",
      "max installations",
      "maximum installations",
      "exceeded installation limit",
      "/5 installations",
      "cannot register a new installation",
    ];

    const isInstallationLimitError = limitPatterns.some((pattern) =>
      errorMessage.includes(pattern)
    );

    if (isInstallationLimitError) {
      return {
        isInstallationLimitError: true,
        senderInboxId,
        helpMessage: this.generateHelpMessage(senderInboxId),
        technicalDetails: error?.message || "Installation limit exceeded",
      };
    }

    return {
      isInstallationLimitError: false,
    };
  }

  /**
   * Generate a helpful message for users experiencing installation limits
   */
  private static generateHelpMessage(senderInboxId?: string): string {
    return `🚫 XMTP Installation Limit Reached

Hi! It looks like you've hit XMTP's new 5-installation limit. This is a security feature introduced in XMTP 3.0.0.

🔧 How to fix this:

1. **Clean up old installations**
   • Remove XMTP from unused devices/apps
   • Clear old deployments or test environments

2. **Use consistent settings**
   • Use the same encryption key across all your XMTP apps
   • Reuse existing database files when possible

3. **Contact support**
   • XMTP Discord: https://discord.gg/xmtp
   • GitHub Issues: https://github.com/xmtp/xmtp-node-js-sdk

${
  senderInboxId
    ? `📋 Your Inbox ID: ${senderInboxId.slice(0, 8)}...${senderInboxId.slice(
        -8
      )}`
    : ""
}

Once you've cleaned up your installations, you should be able to message again!

---
🤖 This is an automated response from the Flaunchy agent.`;
  }

  /**
   * Create a user-friendly webpage explaining the installation limit
   */
  static generateInstallationLimitPage(senderInboxId?: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XMTP Installation Limit - Flaunchy</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .steps { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .inbox-id { font-family: monospace; background: #e9ecef; padding: 10px; border-radius: 4px; word-break: break-all; }
        .btn { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>🚫 XMTP Installation Limit Reached</h1>
    
    <div class="warning">
        <strong>You've hit XMTP's 5-installation limit!</strong>
        <p>This is a new security feature in XMTP 3.0.0 that limits each inbox to 5 active installations.</p>
    </div>

    <div class="steps">
        <h3>🔧 How to fix this:</h3>
        <ol>
            <li><strong>Clean up old installations:</strong> Remove XMTP from devices/apps you no longer use</li>
            <li><strong>Use consistent settings:</strong> Use the same encryption key across all your XMTP apps</li>
            <li><strong>Reuse existing databases:</strong> Don't create new installations unnecessarily</li>
        </ol>
    </div>

    ${
      senderInboxId
        ? `
    <div class="steps">
        <h3>📋 Your Inbox ID:</h3>
        <div class="inbox-id">${senderInboxId}</div>
        <p><small>Share this with XMTP support if you need help</small></p>
    </div>
    `
        : ""
    }

    <div class="steps">
        <h3>🆘 Need help?</h3>
        <a href="https://discord.gg/xmtp" class="btn">XMTP Discord</a>
        <a href="https://github.com/xmtp/xmtp-node-js-sdk/issues" class="btn">GitHub Issues</a>
    </div>

    <hr>
    <p><small>🤖 This message is from the Flaunchy agent. Once you've resolved the installation limit, you should be able to message again!</small></p>
</body>
</html>`;
  }

  /**
   * Log installation limit events for monitoring
   */
  static logInstallationLimitEvent(senderInboxId: string, error: any): void {
    const logData = {
      timestamp: new Date().toISOString(),
      event: "installation_limit_exceeded",
      senderInboxId,
      error: error?.message || "Unknown error",
      source: "user_message_attempt",
    };

    console.log(
      "📊 Installation Limit Event:",
      JSON.stringify(logData, null, 2)
    );

    // You could send this to analytics/monitoring service
    // analytics.track('installation_limit_exceeded', logData);
  }
}

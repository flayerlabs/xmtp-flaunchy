import { Client, type XmtpEnv, type Signer } from "@xmtp/node-sdk";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import {
  RemoteAttachmentCodec,
  AttachmentCodec,
} from "@xmtp/content-type-remote-attachment";
import { 
  TransactionReferenceCodec 
} from "@xmtp/content-type-transaction-reference";

export interface InstallationError {
  type: 'INSTALLATION_LIMIT_EXCEEDED' | 'UNKNOWN_ERROR';
  message: string;
  maxInstallations?: number;
  currentInstallations?: number;
  suggestedActions?: string[];
}

export interface ClientCreateOptions {
  env: XmtpEnv;
  dbPath: string;
  dbEncryptionKey: Uint8Array;
  retryAttempts?: number;
  onInstallationLimitExceeded?: (error: InstallationError) => Promise<boolean>;
}

/**
 * InstallationManager handles XMTP client creation with proper installation limit handling
 */
export class InstallationManager {
  private static readonly MAX_INSTALLATIONS = 5;
  private static readonly DEFAULT_RETRY_ATTEMPTS = 3;

  /**
   * Creates an XMTP client with proper installation limit error handling
   */
  static async createClient(
    signer: Signer, 
    options: ClientCreateOptions
  ): Promise<Client<any>> {
    const {
      env,
      dbPath,
      dbEncryptionKey,
      retryAttempts = this.DEFAULT_RETRY_ATTEMPTS,
      onInstallationLimitExceeded
    } = options;

    const codecs = [
      new WalletSendCallsCodec(),
      new RemoteAttachmentCodec(),
      new AttachmentCodec(),
      new TransactionReferenceCodec(),
    ];

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        console.log(`📦 Creating XMTP client (attempt ${attempt}/${retryAttempts})...`);
        
        const client = await Client.create(signer, {
          env,
          codecs,
          dbPath,
          dbEncryptionKey,
        });

        console.log("✅ XMTP client created successfully!");
        return client;

      } catch (error: any) {
        lastError = error;
        console.error(`❌ Client creation attempt ${attempt} failed:`, error);

        // Check if this is an installation limit error
        const installationError = this.parseInstallationError(error);
        
        if (installationError.type === 'INSTALLATION_LIMIT_EXCEEDED') {
          console.warn(`🚫 Installation limit exceeded (${this.MAX_INSTALLATIONS} max)`);
          
          // If user provided a callback, let them handle it
          if (onInstallationLimitExceeded) {
            const shouldRetry = await onInstallationLimitExceeded(installationError);
            if (!shouldRetry) {
              throw new Error(
                `Installation limit exceeded: ${installationError.message}\n\n` +
                `Suggested actions:\n${installationError.suggestedActions?.join('\n') || 'No suggestions available'}`
              );
            }
          } else {
            // Default handling - throw descriptive error
            throw new Error(this.formatInstallationLimitError(installationError));
          }
        }

        // For other errors, wait before retrying (if not last attempt)
        if (attempt < retryAttempts) {
          const waitTime = attempt * 2000; // Exponential backoff: 2s, 4s, 6s
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // All attempts failed
    throw new Error(
      `Failed to create XMTP client after ${retryAttempts} attempts. ` +
      `Last error: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Checks if an error is related to installation limits
   */
  private static parseInstallationError(error: any): InstallationError {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorString = error?.toString?.()?.toLowerCase() || '';
    
    // Common patterns for installation limit errors
    const limitPatterns = [
      'installation limit',
      'max installations',
      'maximum installations',
      'too many installations',
      'installation quota',
      'exceeded installation limit',
      '5 installations',
      'installation capacity'
    ];

    const isInstallationLimit = limitPatterns.some(pattern => 
      errorMessage.includes(pattern) || errorString.includes(pattern)
    );

    if (isInstallationLimit) {
      return {
        type: 'INSTALLATION_LIMIT_EXCEEDED',
        message: error?.message || 'Installation limit exceeded',
        maxInstallations: InstallationManager.MAX_INSTALLATIONS,
        suggestedActions: [
          '• Remove unused installations from other devices/apps',
          '• Use the same database and encryption key across deployments',
          '• Contact XMTP support if you need to manage installations',
          '• Consider using Client.build() instead of Client.create() for existing installations'
        ]
      };
    }

    return {
      type: 'UNKNOWN_ERROR',
      message: error?.message || 'Unknown client creation error'
    };
  }

  /**
   * Formats a user-friendly error message for installation limit issues
   */
  private static formatInstallationLimitError(error: InstallationError): string {
    return [
      `🚫 XMTP Installation Limit Exceeded`,
      ``,
      `XMTP enforces a limit of ${error.maxInstallations || InstallationManager.MAX_INSTALLATIONS} active installations per inbox.`,
      ``,
      `What this means:`,
      `• Each time your app creates a new XMTP client, it counts as an installation`,
      `• You may have reached the limit from previous deployments or other apps`,
      ``,
      `How to fix this:`,
      ...(error.suggestedActions || []),
      ``,
      `Technical details: ${error.message}`
    ].join('\n');
  }

  /**
   * Gets installation information for an existing client
   */
  static async getInstallationInfo(client: Client<any>): Promise<{
    inboxId: string;
    installationId: string;
    installations?: any[];
  }> {
    try {
      return {
        inboxId: client.inboxId,
        installationId: client.installationId,
        // Note: In the future, XMTP might provide APIs to list installations
        // installations: await client.listInstallations?.() || []
      };
    } catch (error) {
      console.warn('Failed to get installation info:', error);
      return {
        inboxId: client.inboxId,
        installationId: client.installationId
      };
    }
  }

  /**
   * Attempts to revoke old installations if the API becomes available
   */
  static async revokeOldInstallations(client: Client, keepCount: number = 3): Promise<boolean> {
    try {
      // Note: This is a placeholder for future XMTP APIs
      // The actual implementation will depend on what XMTP provides
      console.log(`🔄 Installation management not yet implemented in XMTP SDK`);
      console.log(`   Keep an eye on XMTP releases for installation management APIs`);
      return false;
    } catch (error) {
      console.warn('Failed to revoke installations:', error);
      return false;
    }
  }

  /**
   * Builds a client from an existing installation instead of creating a new one
   * Use this when you know an installation already exists and want to avoid the 5-installation limit
   */
  static async buildExistingClient(
    signer: Signer, 
    options: Omit<ClientCreateOptions, 'onInstallationLimitExceeded'>
  ): Promise<Client<any>> {
    const {
      env,
      dbPath,
      dbEncryptionKey,
      retryAttempts = this.DEFAULT_RETRY_ATTEMPTS
    } = options;

    const codecs = [
      new WalletSendCallsCodec(),
      new RemoteAttachmentCodec(),
      new AttachmentCodec(),
      new TransactionReferenceCodec(),
    ];

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        console.log(`📦 Building XMTP client from existing installation (attempt ${attempt}/${retryAttempts})...`);
        
        // Use Client.create() with same database path and encryption key to reuse existing installation
        // XMTP will automatically reuse the existing installation if the database already exists
        const client = await Client.create(signer, {
          env,
          codecs,
          dbPath,
          dbEncryptionKey,
        });
        
        console.log("✅ XMTP client created successfully (reused existing installation)!");
        return client;

      } catch (error: any) {
        lastError = error;
        console.error(`❌ Client build attempt ${attempt} failed:`, error);

        // Check if this is an installation limit error
        const installationError = this.parseInstallationError(error);
        
        if (installationError.type === 'INSTALLATION_LIMIT_EXCEEDED') {
          console.error(`🚫 Installation limit exceeded (${this.MAX_INSTALLATIONS} max)`);
          console.error("💡 Consider cleaning up old installations or using a different approach");
          
          // Throw with helpful message
          throw new Error(this.formatInstallationLimitError(installationError));
        }

        // For other errors, wait before retrying (if not last attempt)
        if (attempt < retryAttempts) {
          const waitTime = attempt * 2000; // Exponential backoff: 2s, 4s, 6s
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // All attempts failed
    throw new Error(
      `Failed to build XMTP client after ${retryAttempts} attempts. ` +
      `Last error: ${lastError?.message || 'Unknown error'}`
    );
  }
} 
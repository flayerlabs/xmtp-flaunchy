import { Client, type XmtpEnv, type Signer } from "@xmtp/node-sdk";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import {
  RemoteAttachmentCodec,
  AttachmentCodec,
} from "@xmtp/content-type-remote-attachment";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import { ReplyCodec } from "@xmtp/content-type-reply";
import { ReactionCodec } from "@xmtp/content-type-reaction";

export interface InstallationError {
  type: "INSTALLATION_LIMIT_EXCEEDED" | "UNKNOWN_ERROR";
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
  private static readonly FIRST_ATTEMPT_TIMEOUT = 30_000;
  private static readonly RETRY_TIMEOUT = 60_000;
  private static readonly BASE_RETRY_DELAY = 2_000;

  private static readonly CODECS = [
    new WalletSendCallsCodec(),
    new RemoteAttachmentCodec(),
    new AttachmentCodec(),
    new TransactionReferenceCodec(),
    new ReplyCodec(),
    new ReactionCodec(),
  ];

  /**
   * Creates an XMTP client with proper installation limit error handling
   */
  static async createClient(
    signer: Signer,
    options: ClientCreateOptions
  ): Promise<Client<any>> {
    return this.createClientInternal(signer, options, "Creating");
  }

  /**
   * Builds a client from an existing installation instead of creating a new one
   * Use this when you know an installation already exists and want to avoid the 5-installation limit
   */
  static async buildExistingClient(
    signer: Signer,
    options: Omit<ClientCreateOptions, "onInstallationLimitExceeded">
  ): Promise<Client<any>> {
    return this.createClientInternal(
      signer,
      { ...options, onInstallationLimitExceeded: undefined },
      "Building"
    );
  }

  /**
   * Internal method that handles client creation with retry logic
   */
  private static async createClientInternal(
    signer: Signer,
    options: ClientCreateOptions,
    actionVerb: string
  ): Promise<Client<any>> {
    const {
      env,
      dbPath,
      dbEncryptionKey,
      retryAttempts = this.DEFAULT_RETRY_ATTEMPTS,
      onInstallationLimitExceeded,
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        console.log(
          `📦 ${actionVerb} XMTP client (attempt ${attempt}/${retryAttempts})...`
        );

        const client = await this.createClientWithTimeout(
          signer,
          {
            env,
            dbPath,
            dbEncryptionKey,
          },
          attempt
        );

        console.log(`✅ XMTP client ${actionVerb.toLowerCase()} successfully!`);
        await this.validateClientConnection(client);
        return client;
      } catch (error: any) {
        lastError = error;
        console.error(
          `❌ Client ${actionVerb.toLowerCase()} attempt ${attempt} failed:`,
          error
        );

        const installationError = this.parseInstallationError(error);
        if (installationError.type === "INSTALLATION_LIMIT_EXCEEDED") {
          await this.handleInstallationLimitError(
            installationError,
            onInstallationLimitExceeded
          );
        }

        if (attempt < retryAttempts) {
          await this.waitBeforeRetry(attempt);
        }
      }
    }

    throw new Error(
      `Failed to ${actionVerb.toLowerCase()} XMTP client after ${retryAttempts} attempts. ` +
        `Last error: ${lastError?.message || "Unknown error"}`
    );
  }

  /**
   * Creates client with timeout protection
   */
  private static async createClientWithTimeout(
    signer: Signer,
    config: { env: XmtpEnv; dbPath: string; dbEncryptionKey: Uint8Array },
    attempt: number
  ): Promise<Client<any>> {
    const clientCreationPromise = Client.create(signer, {
      ...config,
      codecs: this.CODECS,
    });

    const timeoutMs =
      attempt === 1 ? this.FIRST_ATTEMPT_TIMEOUT : this.RETRY_TIMEOUT;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`XMTP client creation timeout after ${timeoutMs}ms`)
          ),
        timeoutMs
      )
    );

    return Promise.race([clientCreationPromise, timeoutPromise]) as Promise<
      Client<any>
    >;
  }

  /**
   * Validates client connection
   */
  private static async validateClientConnection(
    client: Client<any>
  ): Promise<void> {
    try {
      console.log("🔍 Validating client connection...");
      const validationStart = Date.now();
      await client.conversations.list({ limit: 1 });
      const validationDuration = Date.now() - validationStart;
      console.log(`✅ Client connection validated in ${validationDuration}ms`);
    } catch (validationError) {
      console.warn(
        "⚠️ Client connection validation failed, but proceeding:",
        validationError
      );
    }
  }

  /**
   * Handles installation limit exceeded errors
   */
  private static async handleInstallationLimitError(
    installationError: InstallationError,
    onInstallationLimitExceeded?: (error: InstallationError) => Promise<boolean>
  ): Promise<void> {
    console.warn(
      `🚫 Installation limit exceeded (${this.MAX_INSTALLATIONS} max)`
    );

    if (onInstallationLimitExceeded) {
      const shouldRetry = await onInstallationLimitExceeded(installationError);
      if (!shouldRetry) {
        throw new Error(this.formatInstallationLimitError(installationError));
      }
    } else {
      throw new Error(this.formatInstallationLimitError(installationError));
    }
  }

  /**
   * Waits before retrying with exponential backoff
   */
  private static async waitBeforeRetry(attempt: number): Promise<void> {
    const waitTime = attempt * this.BASE_RETRY_DELAY;
    console.log(`⏳ Waiting ${waitTime}ms before retry...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  /**
   * Checks if an error is related to installation limits
   */
  private static parseInstallationError(error: any): InstallationError {
    const errorText = `${error?.message || ""} ${
      error?.toString?.() || ""
    }`.toLowerCase();

    const limitPatterns = [
      "installation limit",
      "max installations",
      "maximum installations",
      "too many installations",
      "installation quota",
      "exceeded installation limit",
      "5 installations",
      "installation capacity",
    ];

    const isInstallationLimit = limitPatterns.some((pattern) =>
      errorText.includes(pattern)
    );

    if (isInstallationLimit) {
      return {
        type: "INSTALLATION_LIMIT_EXCEEDED",
        message: error?.message || "Installation limit exceeded",
        maxInstallations: this.MAX_INSTALLATIONS,
        suggestedActions: [
          "• Remove unused installations from other devices/apps",
          "• Use the same database and encryption key across deployments",
          "• Contact XMTP support if you need to manage installations",
          "• Consider using Client.build() instead of Client.create() for existing installations",
        ],
      };
    }

    return {
      type: "UNKNOWN_ERROR",
      message: error?.message || "Unknown client creation error",
    };
  }

  /**
   * Formats a user-friendly error message for installation limit issues
   */
  private static formatInstallationLimitError(
    error: InstallationError
  ): string {
    const maxInstallations = error.maxInstallations || this.MAX_INSTALLATIONS;

    return [
      `🚫 XMTP Installation Limit Exceeded`,
      ``,
      `XMTP enforces a limit of ${maxInstallations} active installations per inbox.`,
      ``,
      `What this means:`,
      `• Each time your app creates a new XMTP client, it counts as an installation`,
      `• You may have reached the limit from previous deployments or other apps`,
      ``,
      `How to fix this:`,
      ...(error.suggestedActions || []),
      ``,
      `Technical details: ${error.message}`,
    ].join("\n");
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
      console.warn("Failed to get installation info:", error);
      return {
        inboxId: client.inboxId,
        installationId: client.installationId,
      };
    }
  }

  /**
   * Attempts to revoke old installations if the API becomes available
   */
  static async revokeOldInstallations(
    client: Client,
    keepCount: number = 3
  ): Promise<boolean> {
    try {
      // Note: This is a placeholder for future XMTP APIs
      // The actual implementation will depend on what XMTP provides
      console.log(`🔄 Installation management not yet implemented in XMTP SDK`);
      console.log(
        `   Keep an eye on XMTP releases for installation management APIs`
      );
      return false;
    } catch (error) {
      console.warn("Failed to revoke installations:", error);
      return false;
    }
  }
}

import * as fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "../helpers/client";
import { validateEnvironment } from "../helpers/utils";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import { InstallationManager } from "../src/core/installation/InstallationManager";

// Storage configuration
let volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";

/**
 * Test script to diagnose XMTP timing issues
 */
async function testXMTPTiming() {
  console.log("🔍 XMTP Timing Diagnostic Test");
  console.log("==============================");

  const overallStartTime = Date.now();

  try {
    // Check Railway environment
    const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;
    console.log(`Environment: ${isRailway ? "Railway" : "Local"}`);

    if (isRailway) {
      console.log("🚄 Railway detected - adding stabilization delay");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log("✅ Stabilization complete");
    }

    // Validate environment variables
    console.log("📋 Validating environment...");
    const envStartTime = Date.now();
    const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = validateEnvironment([
      "WALLET_KEY",
      "ENCRYPTION_KEY",
      "XMTP_ENV",
    ]);
    console.log(`✅ Environment validated in ${Date.now() - envStartTime}ms`);

    // Create signer
    console.log("🔑 Creating signer...");
    const signerStartTime = Date.now();
    const signer = createSigner(WALLET_KEY);
    const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
    const identifier = await signer.getIdentifier();
    const address = identifier.identifier;
    console.log(`✅ Signer created in ${Date.now() - signerStartTime}ms`);
    console.log(`📍 Address: ${address}`);

    // Ensure storage directory exists
    console.log("📁 Checking storage directory...");
    const storageStartTime = Date.now();
    if (!fs.existsSync(volumePath)) {
      fs.mkdirSync(volumePath, { recursive: true });
    }
    console.log(`✅ Storage ready in ${Date.now() - storageStartTime}ms`);

    // Test existing client creation
    console.log("🔄 Testing existing client creation...");
    const existingClientStartTime = Date.now();
    try {
      const existingClient = await InstallationManager.buildExistingClient(
        signer,
        {
          env: XMTP_ENV as XmtpEnv,
          dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
          dbEncryptionKey: encryptionKey,
          retryAttempts: 2,
        }
      );
      const existingClientDuration = Date.now() - existingClientStartTime;
      console.log(`✅ Existing client created in ${existingClientDuration}ms`);

      // Test conversation sync
      console.log("📞 Testing conversation sync...");
      const syncStartTime = Date.now();
      await existingClient.conversations.sync();
      const syncDuration = Date.now() - syncStartTime;
      console.log(`✅ Conversation sync completed in ${syncDuration}ms`);

      // Test stream creation
      console.log("📡 Testing stream creation...");
      const streamStartTime = Date.now();
      const stream = await existingClient.conversations.streamAllMessages();
      const streamDuration = Date.now() - streamStartTime;
      console.log(`✅ Stream created in ${streamDuration}ms`);

      // Test first message wait (with timeout)
      console.log("⏱️ Testing stream readiness (30 second timeout)...");
      const messageWaitStart = Date.now();

      const messageTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("30 second timeout")), 30000)
      );

      const firstMessagePromise = (async () => {
        for await (const message of stream) {
          console.log(
            `🎉 First message received after ${Date.now() - messageWaitStart}ms`
          );
          return message;
        }
      })();

      try {
        await Promise.race([firstMessagePromise, messageTimeout]);
      } catch (timeoutError) {
        console.log(
          `⏰ No messages received within 30 seconds (stream may be ready but no activity)`
        );
      }

      console.log("🧹 Cleaning up...");
      // Note: We can't easily stop the stream, so we'll just exit
    } catch (existingError: any) {
      const existingClientDuration = Date.now() - existingClientStartTime;
      console.log(
        `❌ Existing client failed in ${existingClientDuration}ms:`,
        existingError.message
      );

      // Test new client creation
      console.log("🆕 Testing new client creation...");
      const newClientStartTime = Date.now();
      try {
        const newClient = await InstallationManager.createClient(signer, {
          env: XMTP_ENV as XmtpEnv,
          dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
          dbEncryptionKey: encryptionKey,
          retryAttempts: 3,
          onInstallationLimitExceeded: async (error) => {
            console.error("🚫 Installation limit exceeded:", error.message);
            return false;
          },
        });
        const newClientDuration = Date.now() - newClientStartTime;
        console.log(`✅ New client created in ${newClientDuration}ms`);

        // Test conversation sync with new client
        console.log("📞 Testing conversation sync (new client)...");
        const newSyncStartTime = Date.now();
        await newClient.conversations.sync();
        const newSyncDuration = Date.now() - newSyncStartTime;
        console.log(
          `✅ New client conversation sync completed in ${newSyncDuration}ms`
        );
      } catch (newError: any) {
        const newClientDuration = Date.now() - newClientStartTime;
        console.log(
          `❌ New client failed in ${newClientDuration}ms:`,
          newError.message
        );
      }
    }
  } catch (error) {
    console.error("💥 Test failed:", error);
  }

  const totalDuration = Date.now() - overallStartTime;
  console.log("==============================");
  console.log(`🏁 Total test duration: ${totalDuration}ms`);
  console.log("==============================");
}

// Run the test
testXMTPTiming().catch(console.error);

import fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "../helpers/client";
import { validateEnvironment } from "../helpers/utils";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import { MessageHistory } from "../utils/messageHistory";

/**
 * Script to fetch message history from XMTP and save to .data folder
 */
async function fetchMessageHistory() {
  console.log("📥 Fetching message history...");

  try {
    // Validate environment variables
    const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = validateEnvironment([
      "WALLET_KEY",
      "ENCRYPTION_KEY",
      "XMTP_ENV",
    ]);

    // Create signer and get address
    const signer = createSigner(WALLET_KEY);
    const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
    const identifier = await signer.getIdentifier();
    const address = identifier.identifier;

    // Set up paths
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";
    const dataPath = ".data";
    const messagesPath = path.join(dataPath, "messages");

    // Ensure directories exist
    if (!fs.existsSync(volumePath)) {
      fs.mkdirSync(volumePath, { recursive: true });
    }
    if (!fs.existsSync(messagesPath)) {
      fs.mkdirSync(messagesPath, { recursive: true });
    }

    console.log(`📍 Using address: ${address}`);
    console.log(`📂 Data path: ${messagesPath}`);

    // Create XMTP client
    console.log("🔄 Creating XMTP client...");
    const client = await Client.create(signer, {
      env: XMTP_ENV as XmtpEnv,
      dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
      dbEncryptionKey: encryptionKey,
    });

    console.log(`✅ Connected to XMTP with inbox ID: ${client.inboxId}`);

    // Get all conversations
    console.log("📋 Fetching conversations...");
    const conversations = await client.conversations.list();
    console.log(`📝 Found ${conversations.length} conversations`);

    // Process each conversation
    const allMessages: any[] = [];
    const conversationSummaries: any[] = [];

    for (let i = 0; i < conversations.length; i++) {
      const conversation = conversations[i];
      console.log(
        `🔍 Processing conversation ${i + 1}/${conversations.length}: ${
          conversation.id
        }`
      );

      try {
        // Get messages for this conversation
        const messages = await conversation.messages();
        console.log(`   📨 Found ${messages.length} messages`);

        // Get conversation members and their addresses
        const members = await conversation.members();
        const memberAddresses = [];

        for (const member of members) {
          try {
            const memberInboxState =
              await client.preferences.inboxStateFromInboxIds([member.inboxId]);
            if (
              memberInboxState.length > 0 &&
              memberInboxState[0].identifiers.length > 0
            ) {
              const memberAddress =
                memberInboxState[0].identifiers[0].identifier;
              memberAddresses.push(memberAddress);
            }
          } catch (error) {
            console.error(
              `Error getting address for member ${member.inboxId}:`,
              error
            );
          }
        }

        // Process messages
        const processedMessages = messages.map((message) => ({
          id: message.id,
          conversationId: conversation.id,
          senderInboxId: message.senderInboxId,
          content: message.content,
          contentType: message.contentType,
          sentAt: message.sentAt,
          deliveryStatus: message.deliveryStatus,
        }));

        // Save individual conversation messages
        const conversationFilename = `conversation-${conversation.id}.json`;
        const conversationFilePath = path.join(
          messagesPath,
          conversationFilename
        );
        fs.writeFileSync(
          conversationFilePath,
          JSON.stringify(
            {
              conversationId: conversation.id,
              members: memberAddresses,
              messageCount: messages.length,
              messages: processedMessages,
            },
            null,
            2
          )
        );

        // Add to all messages array
        allMessages.push(...processedMessages);

        // Add to conversation summary
        conversationSummaries.push({
          conversationId: conversation.id,
          members: memberAddresses,
          messageCount: messages.length,
          lastMessage: processedMessages[processedMessages.length - 1] || null,
        });
      } catch (error) {
        console.error(
          `❌ Error processing conversation ${conversation.id}:`,
          error
        );
      }
    }

    // Save comprehensive summary
    const summaryFilePath = path.join(messagesPath, "summary.json");
    fs.writeFileSync(
      summaryFilePath,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          clientAddress: address,
          clientInboxId: client.inboxId,
          totalConversations: conversations.length,
          totalMessages: allMessages.length,
          conversations: conversationSummaries,
        },
        null,
        2
      )
    );

    // Save all messages in one file
    const allMessagesFilePath = path.join(messagesPath, "all-messages.json");
    fs.writeFileSync(allMessagesFilePath, JSON.stringify(allMessages, null, 2));

    console.log(`✅ Message history saved successfully!`);
    console.log(`📊 Summary:`);
    console.log(`   - Total conversations: ${conversations.length}`);
    console.log(`   - Total messages: ${allMessages.length}`);
    console.log(`   - Files saved to: ${messagesPath}`);
    console.log(`   - Summary file: ${summaryFilePath}`);
    console.log(`   - All messages file: ${allMessagesFilePath}`);
  } catch (error) {
    console.error("❌ Error fetching message history:", error);
    process.exit(1);
  }
}

// Run the script
fetchMessageHistory()
  .then(() => {
    console.log("🎉 Message history fetch completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Script failed:", error);
    process.exit(1);
  });

export { fetchMessageHistory };

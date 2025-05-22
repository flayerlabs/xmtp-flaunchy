# XMTP Agent Message and Attachment Processing Flow

This document outlines the complete flow of how the XMTP agent processes incoming text messages and image attachments, particularly when they are intended to be handled together (e.g., a command like "Flaunch this image" followed by an image).

## Core Problem

XMTP clients often send text and image attachments as two separate messages. The text message usually arrives first, followed shortly by the attachment message. If the agent processes the text message immediately, it might miss the context of the subsequent image, leading to errors or incomplete actions. For instance, if a user says "Flaunch this with ticker XYZ" and then sends an image, processing the text alone would result in a `flaunch` command missing the image.

## Solution Overview

To address this, the agent implements a two-stage processing system:

1.  **Message Coordination (`index.ts`):** A `MessageCoordinator` class temporarily queues incoming messages and attempts to pair related text and attachment messages.
2.  **Content Processing & AI Interaction (`utils/llm.ts`):** Once messages are coordinated (or a timeout occurs), the `processMessage` function handles content extraction, image decryption, IPFS upload, and interaction with the OpenAI LLM.

## Detailed Flow

### 1. Receiving Messages (`index.ts`)

- The `main` function initializes the XMTP client (`client`), OpenAI, message history, and the `MessageCoordinator`.
- It subscribes to `client.conversations.streamAllMessages()` to listen for all incoming messages.
- Each incoming message is first passed to `messageCoordinator.processMessage()`.

### 2. Message Coordination (`MessageCoordinator` in `index.ts`)

- **Purpose:** To group a text message with its corresponding image attachment if they arrive within a defined `waitTimeMs` (e.g., 1 second).
- **Mechanism:**
  - A `messageQueue` (a `Map`) stores messages temporarily, keyed by `conversationId`. Each entry can hold a `textMessage` and an `attachmentMessage`.
  - A `timer` is used for each conversation entry.
- **Logic:**
  - **If an attachment message arrives:**
    1.  It's stored in the queue for its `conversationId`.
    2.  **Decryption Attempt:**
        - The system immediately attempts to decrypt the `RemoteAttachment` using `RemoteAttachmentCodec.load(remoteAttachment, this.client)`. This is crucial because `remoteAttachment.url` often points to the _encrypted_ data.
        - If decryption is successful, an `Attachment` object with `data` (Uint8Array) and `mimeType` is obtained.
        - A local `Blob` and an `objectUrl` (e.g., `blob:http://localhost...`) are created from the decrypted data.
        - The `attachmentMessage.content` in the queue is updated to include `decryptedUrl`, `decryptedData`, and `decryptedMimeType`. This makes the _decrypted_ image data accessible for later stages.
        - If decryption fails, an error is logged, but the original `attachmentMessage` is kept. The `utils/llm.ts` processMessage will later attempt a more robust fetch & decrypt.
    3.  If a `textMessage` is already in the queue for this conversation, both messages (the text message and the potentially modified attachment message with decrypted content) are passed to the `processor` callback (which is `processMessage` from `utils/llm.ts`). The queue entry is then cleared.
    4.  If no `textMessage` is present, a timer is set. If the timer expires before a text message arrives, the attachment message (potentially with decrypted content) is processed alone.
  - **If a text message arrives:**
    1.  It's stored in the queue.
    2.  If an `attachmentMessage` (potentially with decrypted content) is already in the queue, both are processed together.
    3.  Otherwise, a timer is set. If it expires, the text message is processed alone.
- **Output:** The `MessageCoordinator` calls the `processor` function (i.e., `processMessage` from `utils/llm.ts`) with an array containing one or two `DecodedMessage` objects.

### 3. Content Processing & AI Interaction (`processMessage` in `utils/llm.ts`)

- **Purpose:** To extract final text and image information, interact with OpenAI, handle tool calls (like `flaunch`), and send a response.
- **Inputs:**
  - `message`: The primary (most recent) message from the `MessageCoordinator`. This could be a text message or an attachment message (which might have `decryptedUrl` if `MessageCoordinator` succeeded).
  - `relatedMessages`: An optional array containing the other message if it was paired (e.g., if `message` is an attachment, `relatedMessages[0]` could be the text).
- **Image Handling Logic (`fetchAndDecryptAttachment`):**
  - This function is called if `message` is an attachment.
  - It first checks if `message.content.decryptedUrl` (from `MessageCoordinator`) exists. If so, this URL is used.
  - **If `decryptedUrl` is NOT present** (meaning initial decryption in `MessageCoordinator` might have failed or was skipped), this function performs a more robust attempt:
    1.  **Notification:** Sends a message to the user like "Working on your image..."
    2.  **Fetch Encrypted Data:** Downloads the encrypted image data from `remoteAttachment.url` using `axios` (with retries and timeout).
    3.  **Decrypt:** Uses `RemoteAttachmentCodec.load(remoteAttachment, client)` to decrypt the fetched data. This is the correct method as per XMTP docs for `RemoteAttachment` objects.
    4.  **Notification:** Sends "Uploading to IPFS..."
    5.  **IPFS Upload:** Converts the decrypted image data (a `Uint8Array`) to a Base64 string and uploads it to IPFS via `uploadImageToIPFS` (presumably using Pinata).
    6.  **Return Value:** Returns an `ipfs://<hash>` string on success, or `undefined` if all retries fail (notifying the user of the failure).
  - The `imageUrl` variable in `processMessage` will hold this IPFS URL (or the initially decrypted `objectUrl` if that was available and IPFS upload wasn't needed/performed by this specific logic path).
- **Text Extraction:**
  - If `message` is an attachment and `relatedMessages` contains a text message, its content is used as `messageText`.
  - Otherwise, `message.content` (if it's a text message) is used.
- **OpenAI Context Construction:**
  - `messageText` and the processed `imageUrl` (IPFS or decrypted object URL) are added to the system prompt for OpenAI.
  - Conversation history is included.
- **OpenAI Call & Tool Handling:**
  - Calls `openai.chat.completions.create` with the constructed messages and available `OPENAI_TOOLS`.
  - If OpenAI requests a tool call (e.g., `flaunch`):
    - The `imageUrl` (the IPFS URL) is injected into the tool's arguments if the tool is `flaunch`.
    - The appropriate tool handler from `TOOL_REGISTRY` is executed.
- **Response:** The final response (either direct from LLM or from the tool) is sent back to the user via the XMTP `conversation`.

### 4. Codecs (`index.ts` & `utils/llm.ts`)

- `AttachmentCodec` and `RemoteAttachmentCodec` are initialized globally in `index.ts`.
- The XMTP `client` is configured with these codecs:
  ```typescript
  codecs: [
    new WalletSendCallsCodec(),
    remoteAttachmentCodec,
    attachmentCodec,
  ],
  ```
  This is essential for the client to correctly interpret and allow for the decoding of these attachment types.
- `RemoteAttachmentCodec.load(remoteAttachment, client)` is the primary method used for decrypting the content of a `RemoteAttachment`. The `client` instance provides the necessary decryption context (keys, etc.).

## Summary of Image URL Flow

1.  **Initial State:** `RemoteAttachment.url` points to potentially encrypted data on a remote server (e.g., S3).
2.  **`MessageCoordinator` (index.ts):**
    - Attempts `RemoteAttachmentCodec.load()`.
    - If successful, creates a local `objectUrl` (e.g., `blob:...`) from the decrypted data.
    - Updates the attachment message in its queue: `message.content.decryptedUrl = objectUrl`.
3.  **`processMessage` & `fetchAndDecryptAttachment` (utils/llm.ts):**
    - Receives the attachment message.
    - Checks `message.content.decryptedUrl`.
    - If `decryptedUrl` exists (from `MessageCoordinator`), it uses it.
    - **If `decryptedUrl` does NOT exist OR if further processing to IPFS is desired:**
      - `fetchAndDecryptAttachment` is called.
      - It downloads from `RemoteAttachment.url`.
      - It decrypts using `RemoteAttachmentCodec.load()`.
      - It uploads the decrypted data to IPFS.
      - It returns an `ipfs://<hash>`.
    - This final `imageUrl` (either the `objectUrl` or `ipfs://<hash>`) is then used in the prompt for OpenAI and for the `flaunch` tool.

This comprehensive flow ensures that image attachments are correctly decrypted and made available for AI processing and tool execution, while also handling the asynchronous nature of XMTP message delivery.

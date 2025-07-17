import type { Client } from "@xmtp/node-sdk";
import {
  type RemoteAttachment,
  RemoteAttachmentCodec,
  type Attachment,
} from "@xmtp/content-type-remote-attachment";
import { uploadImageToIPFS } from "../../../utils/ipfs";

/**
 * Service for processing images and attachments
 * Handles XMTP remote attachment decryption and IPFS upload
 */
export class ImageProcessor {
  constructor(private client: Client<any>) {}

  /**
   * Process an XMTP remote attachment and upload to IPFS
   */
  async processImageAttachment(attachment: RemoteAttachment): Promise<string> {
    console.log("🖼️ Processing XMTP remote attachment:");
    // console.log("🖼️ Processing XMTP remote attachment:", {
    //   filename: attachment.filename,
    //   url:
    //     typeof attachment.url === "string"
    //       ? attachment.url.substring(0, 100) + "..."
    //       : attachment.url,
    //   scheme: attachment.scheme,
    //   hasContentDigest: !!(attachment as any).contentDigest,
    //   hasSalt: !!(attachment as any).salt,
    //   hasNonce: !!(attachment as any).nonce,
    //   hasSecret: !!(attachment as any).secret,
    //   hasDecryptedData: !!(attachment as any).decryptedData,
    //   hasDecryptedMimeType: !!(attachment as any).decryptedMimeType,
    // });

    try {
      let decryptedAttachment: Attachment;

      // Check if we already have decrypted data from MessageCoordinator preprocessing
      if (
        (attachment as any).decryptedData &&
        (attachment as any).decryptedMimeType
      ) {
        console.log("🔄 Using pre-decrypted data from MessageCoordinator");
        decryptedAttachment = {
          filename: attachment.filename || "image",
          mimeType: (attachment as any).decryptedMimeType,
          data: (attachment as any).decryptedData,
        };
      } else {
        // Decrypt the attachment using XMTP RemoteAttachmentCodec
        console.log("🔓 Decrypting XMTP remote attachment...");
        decryptedAttachment = (await RemoteAttachmentCodec.load(
          attachment,
          this.client
        )) as Attachment;
      }

      console.log("✅ XMTP decryption successful:");
      // console.log("✅ XMTP decryption successful:", {
      //   filename: decryptedAttachment.filename,
      //   mimeType: decryptedAttachment.mimeType,
      //   dataSize: decryptedAttachment.data.length,
      //   estimatedFileSizeKB: Math.round(decryptedAttachment.data.length / 1024),
      // });

      // Validate the decrypted data
      this.validateImageData(decryptedAttachment);

      // Convert to base64 for IPFS upload
      console.log(
        "📤 Converting decrypted image to base64 and uploading to IPFS..."
      );
      const base64Image = Buffer.from(decryptedAttachment.data).toString(
        "base64"
      );

      console.log(
        `[ImageProcessor] 📊 Processing image (${(
          decryptedAttachment.data.length / 1024
        ).toFixed(1)}KB)`
      );

      // Upload to IPFS using our existing upload function
      const ipfsResponse = await uploadImageToIPFS({
        pinataConfig: { jwt: process.env.PINATA_JWT! },
        base64Image,
        name: decryptedAttachment.filename || "image",
      });

      // Validate the IPFS response
      this.validateIPFSResponse(ipfsResponse);

      const ipfsUrl = `ipfs://${ipfsResponse.IpfsHash}`;
      console.log(
        "✅ Successfully processed XMTP attachment and uploaded to IPFS:",
        ipfsUrl
      );

      return ipfsUrl;
    } catch (error) {
      console.error("❌ XMTP attachment processing failed:", error);

      // Log detailed error information for debugging
      if (error instanceof Error) {
        console.error("Error details:", {
          name: error.name,
          message: error.message,
          stack: error.stack?.split("\n").slice(0, 3).join("\n"), // First 3 lines of stack
        });
      }

      // Log attachment details for debugging
      console.error("Attachment details for debugging:", {
        filename: attachment.filename,
        url:
          typeof attachment.url === "string"
            ? attachment.url.substring(0, 100) + "..."
            : attachment.url,
        scheme: attachment.scheme,
        attachmentKeys: Object.keys(attachment),
      });

      return "IMAGE_PROCESSING_FAILED";
    }
  }

  /**
   * Validate decrypted image data
   */
  private validateImageData(decryptedAttachment: Attachment): void {
    if (!decryptedAttachment.data || decryptedAttachment.data.length === 0) {
      throw new Error("Decrypted attachment has no data");
    }

    // Validate it's a reasonable image size
    if (decryptedAttachment.data.length < 100) {
      throw new Error(
        `Image data too small (${decryptedAttachment.data.length} bytes), likely corrupted`
      );
    }

    if (decryptedAttachment.data.length > 10 * 1024 * 1024) {
      // 10MB limit
      throw new Error(
        `Image data too large (${Math.round(
          decryptedAttachment.data.length / 1024 / 1024
        )}MB), max 10MB allowed`
      );
    }
  }

  /**
   * Validate IPFS upload response
   */
  private validateIPFSResponse(ipfsResponse: any): void {
    // Validate the IPFS hash
    if (!ipfsResponse.IpfsHash || typeof ipfsResponse.IpfsHash !== "string") {
      throw new Error("Invalid IPFS response: missing or invalid IpfsHash");
    }

    // Validate IPFS hash format
    const hash = ipfsResponse.IpfsHash;
    const isValidFormat =
      hash.startsWith("Qm") || // CIDv0 format
      hash.startsWith("baf") || // CIDv1 format
      hash.startsWith("bae") || // CIDv1 format
      hash.startsWith("bai") || // CIDv1 format
      hash.startsWith("bab"); // CIDv1 format

    if (!isValidFormat) {
      throw new Error(
        `Invalid IPFS hash format: ${hash} - should start with Qm, baf, bae, bai, or bab`
      );
    }

    // Validate hash length
    if (hash.length < 20 || hash.length > 100) {
      throw new Error(`Invalid IPFS hash length: ${hash.length} characters`);
    }
  }
}

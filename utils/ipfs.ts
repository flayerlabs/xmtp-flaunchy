import axios from "axios";

/**
 * Configuration for Pinata
 */
interface PinataConfig {
  jwt: string;
}

/**
 * Upload response from Pinata
 */
interface UploadResponse {
  IpfsHash: string;
  PinSize?: number;
  Timestamp: string;
  isDuplicate: boolean;
}

interface CoinMetadata {
  name: string;
  description: string;
  image: string;
  external_link: string;
  collaborators: string[];
  discordUrl: string;
  twitterUrl: string;
  telegramUrl: string;
}

interface IPFSParams {
  metadata: {
    base64Image: string;
    description: string;
    websiteUrl?: string;
    discordUrl?: string;
    twitterUrl?: string;
    telegramUrl?: string;
  };
  pinataConfig: PinataConfig;
}

interface TokenUriParams {
  metadata: {
    imageUrl: string;
    description: string;
    websiteUrl?: string;
    discordUrl?: string;
    twitterUrl?: string;
    telegramUrl?: string;
  };
  pinataConfig: PinataConfig;
}

/**
 * Uploads a base64 image to IPFS using Pinata
 *
 * @param params - Configuration and base64 image data
 * @param params.pinataConfig - Pinata configuration including JWT
 * @param params.base64Image - Base64 encoded image data
 * @param params.name - Optional name for the uploaded file
 * @param params.metadata - Optional metadata key-value pairs
 * @returns Upload response with CID and other details
 */
export const uploadImageToIPFS = async (params: {
  pinataConfig: PinataConfig;
  base64Image: string;
  name?: string;
  metadata?: Record<string, string>;
}): Promise<UploadResponse> => {
  try {
    const formData = new FormData();

    // Convert base64 to Blob and then to File
    // Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
    const base64Data = params.base64Image.split(",")[1] || params.base64Image;
    const byteCharacters = atob(base64Data);
    const byteArrays: Uint8Array[] = [];

    for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
      const slice = byteCharacters.slice(offset, offset + 1024);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }

    // Detect mime type from base64 string
    let mimeType = "image/png"; // default
    if (params.base64Image.startsWith("data:")) {
      mimeType = params.base64Image.split(";")[0].split(":")[1];
    }

    const blob = new Blob(byteArrays, { type: mimeType });
    const fileName = params.name || `image.${mimeType.split("/")[1]}`;
    const file = new File([blob], fileName, { type: mimeType });

    formData.append("file", file);

    const pinataMetadata = {
      name: params.name || null,
      keyvalues: params.metadata || {},
    };
    formData.append("pinataMetadata", JSON.stringify(pinataMetadata));

    const pinataOptions = {
      cidVersion: 1,
    };
    formData.append("pinataOptions", JSON.stringify(pinataOptions));

    const response = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      formData,
      {
        headers: {
          Authorization: `Bearer ${params.pinataConfig.jwt}`,
          "Content-Type": "multipart/form-data",
        },
        timeout: 10000, // 10 second timeout
      }
    );

    return {
      IpfsHash: response.data.IpfsHash,
      PinSize: response.data.PinSize,
      Timestamp: response.data.Timestamp,
      isDuplicate: response.data.isDuplicate || false,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to upload image to IPFS: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Uploads JSON data to IPFS using Pinata
 *
 * @param params - Configuration and JSON data
 * @param params.pinataConfig - Pinata configuration including JWT
 * @param params.json - JSON data to upload
 * @param params.name - Optional name for the uploaded file
 * @param params.metadata - Optional metadata key-value pairs
 * @returns Upload response with CID and other details
 */
const uploadJsonToIPFS = async (params: {
  pinataConfig: PinataConfig;
  json: Record<string, unknown> | CoinMetadata;
  name?: string;
  metadata?: Record<string, string>;
}): Promise<UploadResponse> => {
  try {
    const requestBody = {
      pinataOptions: {
        cidVersion: 1,
      },
      pinataMetadata: {
        name: params.name || null,
        keyvalues: params.metadata || {},
      },
      pinataContent: params.json,
    };

    const response = await fetch(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.pinataConfig.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Failed to upload JSON to IPFS: ${error.message || response.statusText}`
      );
    }

    const data = await response.json();
    return {
      IpfsHash: data.IpfsHash,
      PinSize: data.PinSize,
      Timestamp: data.Timestamp,
      isDuplicate: data.isDuplicate || false,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to upload JSON to IPFS: ${error.message}`);
    }
    throw error;
  }
};

const generateTokenUriBase64Image = async (
  name: string,
  params: IPFSParams
) => {
  // 1. upload image to IPFS
  const imageRes = await uploadImageToIPFS({
    pinataConfig: params.pinataConfig,
    base64Image: params.metadata.base64Image,
  });

  // 2. upload metadata to IPFS
  const coinMetadata: CoinMetadata = {
    name,
    description: params.metadata.description,
    image: `ipfs://${imageRes.IpfsHash}`,
    external_link: params.metadata.websiteUrl || "",
    collaborators: [],
    discordUrl: params.metadata.discordUrl || "",
    twitterUrl: params.metadata.twitterUrl || "",
    telegramUrl: params.metadata.telegramUrl || "",
  };

  const metadataRes = await uploadJsonToIPFS({
    pinataConfig: params.pinataConfig,
    json: coinMetadata,
  });

  return `ipfs://${metadataRes.IpfsHash}`;
};

export async function generateTokenUri(
  name: string,
  {
    pinataConfig,
    metadata,
  }: {
    pinataConfig: PinataConfig;
    metadata: {
      imageUrl: string;
      description: string;
      websiteUrl: string;
      discordUrl: string;
      twitterUrl: string;
      telegramUrl: string;
    };
  }
): Promise<string> {
  try {
    console.log("Generating token URI");

    // If the image URL is already an IPFS URL, use it directly
    const imageUrl = metadata.imageUrl.startsWith("ipfs://")
      ? metadata.imageUrl
      : await uploadImageToIPFS({
          pinataConfig,
          base64Image: metadata.imageUrl,
          name: `${name}-image`,
        }).then((res) => `ipfs://${res.IpfsHash}`);

    console.log("Final image URL:", imageUrl);

    const tokenMetadata = {
      name,
      description: metadata.description,
      image: imageUrl,
      external_url: metadata.websiteUrl,
      attributes: [
        {
          trait_type: "Discord",
          value: metadata.discordUrl,
        },
        {
          trait_type: "Twitter",
          value: metadata.twitterUrl,
        },
        {
          trait_type: "Telegram",
          value: metadata.telegramUrl,
        },
      ],
    };

    console.log("Uploading token metadata to IPFS:", tokenMetadata);

    const response = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      tokenMetadata,
      {
        headers: {
          Authorization: `Bearer ${pinataConfig.jwt}`,
        },
        timeout: 10000, // 10 second timeout
      }
    );

    console.log(
      "Successfully uploaded token metadata, hash:",
      response.data.IpfsHash
    );

    return `ipfs://${response.data.IpfsHash}`;
  } catch (error) {
    console.error("Error generating token URI:", error);
    throw error;
  }
}

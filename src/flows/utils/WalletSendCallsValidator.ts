export interface WalletSendCallsStructure {
  version: string;
  from: string;
  chainId: string;
  calls: Array<{
    chainId: number;
    to: string;
    data: string;
    value: string;
    metadata?: {
      description?: string;
    };
  }>;
}

/**
 * Validates that a wallet send calls object has the correct structure
 * to prevent UI crashes when the object is undefined or malformed
 */
export function validateWalletSendCalls(walletSendCalls: any): walletSendCalls is WalletSendCallsStructure {
  if (!walletSendCalls || typeof walletSendCalls !== 'object') {
    console.error('WalletSendCalls validation failed: object is null, undefined, or not an object', walletSendCalls);
    return false;
  }

  if (!walletSendCalls.calls || !Array.isArray(walletSendCalls.calls)) {
    console.error('WalletSendCalls validation failed: missing or invalid calls array', walletSendCalls);
    return false;
  }

  if (walletSendCalls.calls.length === 0) {
    console.error('WalletSendCalls validation failed: calls array is empty', walletSendCalls);
    return false;
  }

  // Validate each call in the array
  for (let i = 0; i < walletSendCalls.calls.length; i++) {
    const call = walletSendCalls.calls[i];
    if (!call || typeof call !== 'object') {
      console.error(`WalletSendCalls validation failed: call ${i} is not an object`, call);
      return false;
    }

    if (typeof call.chainId !== 'number') {
      console.error(`WalletSendCalls validation failed: call ${i} missing or invalid chainId`, call);
      return false;
    }

    if (typeof call.to !== 'string' || !call.to) {
      console.error(`WalletSendCalls validation failed: call ${i} missing or invalid to address`, call);
      return false;
    }

    if (typeof call.data !== 'string' || !call.data) {
      console.error(`WalletSendCalls validation failed: call ${i} missing or invalid data`, call);
      return false;
    }

    if (typeof call.value !== 'string') {
      console.error(`WalletSendCalls validation failed: call ${i} missing or invalid value`, call);
      return false;
    }
  }

  // Validate top-level properties
  if (typeof walletSendCalls.version !== 'string' || !walletSendCalls.version) {
    console.error('WalletSendCalls validation failed: missing or invalid version', walletSendCalls);
    return false;
  }

  if (typeof walletSendCalls.from !== 'string' || !walletSendCalls.from) {
    console.error('WalletSendCalls validation failed: missing or invalid from address', walletSendCalls);
    return false;
  }

  if (typeof walletSendCalls.chainId !== 'string' || !walletSendCalls.chainId) {
    console.error('WalletSendCalls validation failed: missing or invalid chainId', walletSendCalls);
    return false;
  }

  return true;
}

/**
 * Safe wrapper for sending wallet send calls that validates the structure first
 */
export async function safelySendWalletSendCalls(
  conversation: any,
  walletSendCalls: any,
  ContentTypeWalletSendCalls: any
): Promise<boolean> {
  if (!validateWalletSendCalls(walletSendCalls)) {
    console.error('Refusing to send invalid wallet send calls to prevent UI crash');
    return false;
  }

  try {
    await conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
    return true;
  } catch (error) {
    console.error('Failed to send wallet send calls:', error);
    return false;
  }
} 
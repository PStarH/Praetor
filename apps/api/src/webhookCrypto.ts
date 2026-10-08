/**
 * Shared IM webhook crypto helpers (DingTalk / Feishu / WeCom).
 * Production routes and unit tests must import from here — do not fork.
 */
import { reportSilentFailure } from '@praetor/core';
import * as crypto from 'crypto';

/**
 * Length-safe constant-time string compare.
 * crypto.timingSafeEqual throws on length mismatch; catching that is fail-closed
 * but still leaks length via exception path. Pad to equal length and always run
 * a full-buffer compare; require equal original lengths for success.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Empty secrets/signatures must never match (including empty==empty).
  if (aBuf.length === 0 || bBuf.length === 0) return false;
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const contentEq = crypto.timingSafeEqual(aPad, bPad);
  // Encode full lengths as 4-byte BE so lengths > 255 still compare correctly.
  const lenA = Buffer.alloc(4);
  const lenB = Buffer.alloc(4);
  lenA.writeUInt32BE(aBuf.length);
  lenB.writeUInt32BE(bBuf.length);
  const lengthEq = crypto.timingSafeEqual(lenA, lenB);
  return contentEq && lengthEq;
}

/** Reject timestamps outside ±maxSkewSec (DingTalk uses ms; WeCom uses seconds). */
export function isTimestampFresh(timestamp: string, unit: 'ms' | 's', maxSkewSec = 300): boolean {
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return false;
  const tsMs = unit === 'ms' ? n : n * 1000;
  return Math.abs(Date.now() - tsMs) <= maxSkewSec * 1000;
}

/**
 * DingTalk robot signature verification.
 * Algorithm: HmacSHA256(timestamp + "\n" + secret), base64-encoded.
 * Timestamp is milliseconds; reject if skewed > 5 minutes (replay defense).
 */
export function verifyDingTalkSignature(timestamp: string, sign: string, secret: string): boolean {
  try {
    if (!isTimestampFresh(timestamp, 'ms')) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(timestamp + '\n' + secret)
      .digest('base64');
    return timingSafeEqualString(expected, sign);
  } catch (err) {
    reportSilentFailure(err, 'webhookCrypto:verifyDingTalkSignature');
    return false;
  }
}

/**
 * WeCom msg_signature = sha1(sort([token, timestamp, nonce, encrypt]))
 * For simplicity (and because full AES decryption is complex), we perform
 * the signature verification but skip AES decryption of the message body.
 */
export function verifyWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  msgSignature: string,
): boolean {
  try {
    const parts = [token, timestamp, nonce, encrypt].sort();
    // WeCom callback protocol mandates SHA-1 for msg_signature (not chosen by us).
    // codeql[js/weak-cryptographic-algorithm]: protocol-required WeCom msg_signature
    const sha1 = crypto.createHash('sha1').update(parts.join('')).digest('hex');
    return timingSafeEqualString(sha1, msgSignature);
  } catch (err) {
    reportSilentFailure(err, 'webhookCrypto:verifyWeComSignature');
    return false;
  }
}

/** Decrypt a WeCom callback payload using the protocol EncodingAESKey. */
export function decryptWeComMessage(
  encodingAESKey: string,
  encrypted: string,
  expectedReceiveId?: string,
): string | null {
  try {
    const key = Buffer.from(`${encodingAESKey}=`, 'base64');
    if (key.length !== 32) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);
    if (padded.length < 21) return null;
    const padding = padded[padded.length - 1];
    if (padding < 1 || padding > 32) return null;
    for (let i = padded.length - padding; i < padded.length; i++) {
      if (padded[i] !== padding) return null;
    }
    const plain = padded.subarray(0, padded.length - padding);
    const messageLength = plain.readUInt32BE(16);
    const messageEnd = 20 + messageLength;
    if (messageLength < 1 || messageEnd > plain.length) return null;
    const receiveId = plain.subarray(messageEnd).toString('utf8');
    if (expectedReceiveId && !timingSafeEqualString(receiveId, expectedReceiveId)) return null;
    return plain.subarray(20, messageEnd).toString('utf8');
  } catch (err) {
    reportSilentFailure(err, 'webhookCrypto:decryptWeComMessage');
    return null;
  }
}

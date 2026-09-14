import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets at rest. Format `v1:<iv>:<tag>:<data>`
 * (base64url segments). The key is derived from `INTEGRATION_ENCRYPTION_KEY`
 * (32 raw bytes as base64 / hex, or any passphrase hashed with SHA-256).
 * Pure: no I/O, so it is unit-tested and reusable by every credential store.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(
    secret: string,
    readonly keyVersion = 1,
  ) {
    if (!secret || secret.length < 16)
      throw new Error('Credential encryption secret must be at least 16 characters.');
    this.key = CredentialCipher.deriveKey(secret);
  }

  static deriveKey(secret: string): Buffer {
    const trimmed = secret.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) return b64;
    return createHash('sha256').update(trimmed, 'utf8').digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', b64url(iv), b64url(tag), b64url(data)].join(':');
  }

  decrypt(envelope: string): string {
    const [version, iv, tag, data] = envelope.split(':');
    if (version !== 'v1' || !iv || !tag || !data)
      throw new Error('Unrecognised credential envelope.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, fromB64url(iv));
    decipher.setAuthTag(fromB64url(tag));
    return Buffer.concat([decipher.update(fromB64url(data)), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T = unknown>(envelope: string): T {
    return JSON.parse(this.decrypt(envelope)) as T;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

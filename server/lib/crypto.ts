import crypto from 'node:crypto';
import { encryptionKey } from '../env';

/** Encrypt secrets at rest. Format: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

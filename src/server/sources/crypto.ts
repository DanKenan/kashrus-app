import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const key = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'shutfey-source-keys', 'v1', 32));
export function encryptKey(plain: string, secret: string, agencyId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(Buffer.from(agencyId));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}
export function decryptKey(blob: string, secret: string, agencyId: string): string {
  if (!/^v1:[A-Za-z0-9+/]*={0,2}$/.test(blob)) throw new Error('Invalid encrypted source key');
  const packed = Buffer.from(blob.slice(3), 'base64');
  if (packed.length < 28) throw new Error('Invalid encrypted source key');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(agencyId));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}
export const keyHint = (plain: string): string => '…' + plain.slice(-4);

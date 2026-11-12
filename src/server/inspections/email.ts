import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export type Message = { to: string; subject: string; html: string; text: string; attachments: { filename: string; contentType: string; contentBase64: string }[] };
export type Transport = { name: string; send(message: Message): Promise<void> };
export function createEmailTransport(dataDir: string, testMode: boolean, selected = process.env.EMAIL_TRANSPORT): { transport: Transport | null; outbox: Message[] } {
  const outbox: Message[] = [];
  // Unknown selections are disabled too: no real provider or credential is supported.
  const transport: Transport | null = selected === 'test' && testMode ? { name: 'test', async send(message) {
    const dir = path.join(dataDir, 'outbox'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, randomUUID() + '.json'), JSON.stringify(message), { flag: 'wx' }); outbox.push(structuredClone(message));
  } } : null;
  return { transport, outbox };
}

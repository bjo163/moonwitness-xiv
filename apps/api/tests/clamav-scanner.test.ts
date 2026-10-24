import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner } from '../src/whatsapp/clamav-scanner.js';

const servers: net.Server[] = [];

async function createClamServer(scanResult = 'stream: OK'): Promise<string> {
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    let commandRead = false;
    socket.on('data', (part) => {
      received = Buffer.concat([received, part]);
      if (!commandRead) {
        const commandEnd = received.indexOf(0);
        if (commandEnd < 0) return;
        const command = received.subarray(0, commandEnd).toString().replace(/^z/u, '');
        received = received.subarray(commandEnd + 1);
        if (command === 'PING') {
          socket.end(Buffer.from('PONG\0'));
          return;
        }
        expect(command).toBe('INSTREAM');
        commandRead = true;
      }
      while (received.length >= 4) {
        const chunkLength = received.readUInt32BE(0);
        if (received.length < 4 + chunkLength) return;
        received = received.subarray(4 + chunkLength);
        if (chunkLength === 0) {
          socket.end(Buffer.from(`${scanResult}\0`));
          return;
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test ClamAV server did not bind');
  return `tcp://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('ClamAV INSTREAM scanner', () => {
  it('streams file chunks and recognizes a clean result', async () => {
    const scanner = new ClamAvScanner(await createClamServer());
    expect(await scanner.ping()).toBe(true);
    expect(await scanner.scan(Readable.from(['first ', 'second']))).toEqual({
      status: 'clean',
    });
  });

  it('returns the detected signature without treating it as a scanner error', async () => {
    const scanner = new ClamAvScanner(await createClamServer('stream: Eicar-Signature FOUND'));
    await expect(scanner.scan(Readable.from(['malware fixture']))).resolves.toEqual({
      status: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('rejects invalid endpoints and fails closed when the scanner is unreachable', async () => {
    expect(() => new ClamAvScanner('http://localhost:3310')).toThrow(/tcp:\/\//u);
    const unavailable = new ClamAvScanner('tcp://127.0.0.1:1', 100);
    await expect(unavailable.scan(Readable.from(['payload']))).rejects.toThrow(
      'WhatsApp malware scan failed'
    );
  });
});

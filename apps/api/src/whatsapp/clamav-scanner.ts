import net from 'node:net';
import type { Readable } from 'node:stream';

export type MalwareScanResult = { status: 'clean' } | { status: 'infected'; signature: string };

export interface AttachmentScanner {
  scan(content: Readable): Promise<MalwareScanResult>;
  ping(): Promise<boolean>;
}

export class MalwareScannerUnavailableError extends Error {
  constructor(message = 'WhatsApp malware scanner is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'MalwareScannerUnavailableError';
  }
}

export class ClamAvScanner implements AttachmentScanner {
  private readonly hostname: string;
  private readonly port: number;

  constructor(
    address: string,
    private readonly timeoutMs = 30_000
  ) {
    let parsed: URL;
    try {
      parsed = new URL(address);
    } catch (error) {
      throw new Error('WHATSAPP_CLAMAV_URL must be a tcp://host:port URL', { cause: error });
    }
    if (
      parsed.protocol !== 'tcp:' ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('WHATSAPP_CLAMAV_URL must be a tcp://host:port URL without credentials');
    }
    this.hostname = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : 3310;
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) {
      throw new Error('WHATSAPP_CLAMAV_URL port must be between 1 and 65535');
    }
  }

  async ping(): Promise<boolean> {
    const response = await this.command(Buffer.from('zPING\0'));
    return response === 'PONG';
  }

  async scan(content: Readable): Promise<MalwareScanResult> {
    const socket = this.connect();
    try {
      await this.waitForConnect(socket);
      await this.write(socket, Buffer.from('zINSTREAM\0'));
      for await (const value of content) {
        const chunk = Buffer.from(value as Uint8Array);
        if (!chunk.length) continue;
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        await this.write(socket, length);
        await this.write(socket, chunk);
      }
      await this.write(socket, Buffer.alloc(4));
      const response = await this.readResponse(socket);
      if (response.endsWith(': OK')) return { status: 'clean' };
      const found = response.match(/:\s*(.+) FOUND$/u);
      if (found?.[1]) return { status: 'infected', signature: found[1].slice(0, 200) };
      throw new MalwareScannerUnavailableError('ClamAV returned an invalid scan response');
    } catch (error) {
      content.destroy();
      if (error instanceof MalwareScannerUnavailableError) throw error;
      throw new MalwareScannerUnavailableError('WhatsApp malware scan failed', { cause: error });
    } finally {
      socket.destroy();
    }
  }

  private async command(command: Buffer): Promise<string> {
    const socket = this.connect();
    try {
      await this.waitForConnect(socket);
      await this.write(socket, command);
      return await this.readResponse(socket);
    } catch (error) {
      throw new MalwareScannerUnavailableError('WhatsApp malware scanner did not respond', {
        cause: error,
      });
    } finally {
      socket.destroy();
    }
  }

  private connect(): net.Socket {
    const socket = net.createConnection({ host: this.hostname, port: this.port });
    socket.setTimeout(this.timeoutMs, () =>
      socket.destroy(new Error('ClamAV connection timed out'))
    );
    return socket;
  }

  private waitForConnect(socket: net.Socket): Promise<void> {
    if (socket.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  private async write(socket: net.Socket, bytes: Buffer): Promise<void> {
    if (socket.destroyed) throw new Error('ClamAV connection closed');
    const canContinue = socket.write(bytes);
    if (canContinue) return;
    await new Promise<void>((resolve, reject) => {
      socket.once('drain', resolve);
      socket.once('error', reject);
    });
  }

  private readResponse(socket: net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      const onData = (chunk: Buffer) => {
        length += chunk.length;
        if (length > 8_192) {
          cleanup();
          reject(new Error('ClamAV response exceeded the allowed size'));
          return;
        }
        chunks.push(Buffer.from(chunk));
        const response = Buffer.concat(chunks, length);
        const terminator = response.indexOf(0);
        if (terminator >= 0) {
          cleanup();
          resolve(response.subarray(0, terminator).toString('utf8'));
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onError);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('end', () => onError(new Error('ClamAV closed before returning a result')));
    });
  }
}

export function createAttachmentScanner(
  address = process.env.WHATSAPP_CLAMAV_URL ||
    (process.env.NODE_ENV === 'production' ? undefined : 'tcp://127.0.0.1:3310')
): AttachmentScanner | null {
  return address ? new ClamAvScanner(address) : null;
}

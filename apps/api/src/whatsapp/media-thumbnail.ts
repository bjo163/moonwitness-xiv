import { spawn } from 'node:child_process';
import sharp from 'sharp';

const MAX_POSTER_BYTES = 2 * 1024 * 1024;
const POSTER_TIMEOUT_MS = 8_000;

export type MediaThumbnail = { bytes: Buffer; contentType: 'image/webp' | 'image/jpeg' };

export async function createImageThumbnail(input: Buffer): Promise<MediaThumbnail> {
  const bytes = await sharp(input, {
    failOn: 'error',
    limitInputPixels: 40_000_000,
    pages: 1,
    sequentialRead: true,
  })
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();
  if (!bytes.length || bytes.length > MAX_POSTER_BYTES)
    throw new Error('Generated WhatsApp thumbnail is outside the allowed size');
  return { bytes, contentType: 'image/webp' };
}

export function createVideoPoster(input: Buffer): Promise<MediaThumbnail> {
  const executable = process.env.WHATSAPP_FFMPEG_PATH?.trim() || 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '1',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        'scale=640:640:force_original_aspect_ratio=decrease',
        '-an',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Video poster generation timed out'));
    }, POSTER_TIMEOUT_MS);
    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (!bytes?.length) reject(new Error('Video did not contain a poster frame'));
      else resolve({ bytes, contentType: 'image/jpeg' });
    };
    child.on('error', (error) =>
      finish(new Error('Video poster generator could not start', { cause: error }))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_POSTER_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('Generated WhatsApp poster exceeded the allowed size'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error('Video poster generation failed'));
        return;
      }
      finish(undefined, Buffer.concat(chunks, size));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

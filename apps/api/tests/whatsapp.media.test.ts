import { describe, expect, it } from 'vitest';
import { mimeMatchesSignature, sniffMime } from '../src/whatsapp/media.js';

describe('WhatsApp media signatures', () => {
  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a'), 'image/gif'],
    ['WebP', Buffer.from('RIFF0000WEBP'), 'image/webp'],
    ['WAV', Buffer.from('RIFF0000WAVE'), 'audio/wav'],
    ['Ogg', Buffer.from('OggS'), 'audio/ogg'],
    ['WebM', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm'],
    ['PDF', Buffer.from('%PDF-1.7'), 'application/pdf'],
    ['MP4', Buffer.from('0000ftypisom'), 'video/mp4'],
    ['QuickTime', Buffer.from('0000ftypqt  '), 'video/quicktime'],
    ['M4A', Buffer.from('0000ftypM4A '), 'audio/mp4'],
    [
      'DOCX',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ])('detects %s from its signature', (_label, bytes, mime) => {
    expect(sniffMime(bytes)).toBe(mime);
  });

  it('rejects a claimed type that conflicts with the signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(mimeMatchesSignature('image/jpeg', sniffMime(png))).toBe(false);
    expect(mimeMatchesSignature('image/png', sniffMime(png))).toBe(true);
  });

  it('keeps unknown bytes generic and allows generic download MIME', () => {
    expect(sniffMime(Buffer.from('<script>'))).toBeNull();
    expect(mimeMatchesSignature('application/octet-stream', null)).toBe(true);
  });
});

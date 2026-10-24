export function safeMime(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  const mime = value.toLowerCase().split(';')[0]?.trim() ?? '';
  return /^(?:image\/(?:jpeg|png|gif|webp)|video\/(?:mp4|quicktime|webm)|audio\/(?:mpeg|mp4|ogg|wav|webm)|application\/(?:pdf|octet-stream|msword|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.[a-z0-9.-]+))$/u.test(
    mime
  )
    ? mime
    : 'application/octet-stream';
}

export function mediaType(mime: string): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export function sniffMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    if (bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    if (bytes.toString('ascii', 8, 12) === 'WEBM') return 'video/webm';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return 'video/webm';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^M4[ABP] $/u.test(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (
    bytes.length >= 3 &&
    (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
  )
    return 'audio/mpeg';

  // OOXML stores these entry names in the ZIP directory and local file headers.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const contents = bytes.toString('latin1');
    if (contents.includes('word/document.xml'))
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (contents.includes('xl/workbook.xml'))
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (contents.includes('ppt/presentation.xml'))
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    const contents = bytes.toString('latin1');
    if (contents.includes('WordDocument')) return 'application/msword';
    if (contents.includes('Workbook') || contents.includes('Book'))
      return 'application/vnd.ms-excel';
  }
  return null;
}

export function mimeMatchesSignature(declaredMime: string, detectedMime: string | null): boolean {
  if (declaredMime === 'application/octet-stream') return true;
  if (!detectedMime) return false;
  if (declaredMime === detectedMime) return true;
  // WebM is a shared container; the file signature cannot distinguish audio-only from video.
  return declaredMime === 'audio/webm' && detectedMime === 'video/webm';
}

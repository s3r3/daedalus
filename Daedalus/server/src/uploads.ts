import { inflateRawSync } from 'node:zlib';

export const UPLOAD_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxZipEntries: 200,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
} as const;

export type UploadPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

export function sanitizeRelativePath(input: string): string {
  const normalized = input.replace(/\\+/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('path must be a relative workspace path');
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('path escapes workspace root');
  if (!parts.length) throw new Error('path must not be empty');
  return parts.join('/');
}

export function parseMultipart(body: Buffer, contentType: string): UploadPart[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) throw new Error('multipart boundary is missing');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: UploadPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break; // final --
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;
    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]+)"/.exec(disposition)?.[1] ?? '';
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const partContentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    parts.push({
      name,
      ...(filename ? { filename } : {}),
      ...(partContentType ? { contentType: partContentType } : {}),
      data: Buffer.from(body.subarray(dataStart, dataEnd)),
    });
    cursor = next;
  }
  return parts;
}

export type ZipEntry = { path: string; data: Buffer };

export function extractZipEntries(data: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  if (eocd === -1) throw new Error('invalid ZIP archive: end of central directory not found');
  const totalEntries = data.readUInt16LE(eocd + 10);
  if (totalEntries > UPLOAD_LIMITS.maxZipEntries) throw new Error(`ZIP has too many entries (limit ${UPLOAD_LIMITS.maxZipEntries})`);
  let offset = data.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid ZIP central directory');
    const compression = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const safePath = sanitizeRelativePath(name);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > UPLOAD_LIMITS.maxZipUncompressedBytes) throw new Error('ZIP uncompressed content is too large');

    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid ZIP local file header');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (compression === 0) content = Buffer.from(compressed);
    else if (compression === 8) content = inflateRawSync(compressed);
    else throw new Error(`unsupported ZIP compression method: ${compression}`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${safePath}`);
    entries.push({ path: safePath, data: content });
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  const min = Math.max(0, data.length - 65_557);
  for (let i = data.length - 22; i >= min; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function guessMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

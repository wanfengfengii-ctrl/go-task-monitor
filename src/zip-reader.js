import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 20_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('不是有效 ZIP：找不到中央目录');
}

function assertSafeEntryPath(filename) {
  const normalized = filename.replaceAll('\\', '/');
  const segments = normalized.replace(/\/$/, '').split('/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || segments.includes('..') || segments.includes('')) {
    throw new Error(`ZIP 包含不安全路径：${filename || '(空路径)'}`);
  }
  return normalized;
}

export function parseZipEntries(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 文件为空或内容不完整');
  const maxEntries = options.maxEntries || MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes || MAX_TOTAL_BYTES;
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);

  if (eocdOffset + 22 + commentLength !== buffer.length) throw new Error('ZIP 尾部数据不完整');
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error('不支持分卷 ZIP');
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('暂不支持 ZIP64，请拆分或精简项目包');
  if (totalEntries > maxEntries) throw new Error(`ZIP 文件数量超过限制（最多 ${maxEntries} 个）`);
  if (centralOffset + centralSize > eocdOffset) throw new Error('ZIP 中央目录越界');

  const entries = [];
  let centralCursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > buffer.length || buffer.readUInt32LE(centralCursor) !== CENTRAL_SIGNATURE) throw new Error(`ZIP 中央目录第 ${index + 1} 项损坏`);
    const flags = buffer.readUInt16LE(centralCursor + 8);
    const compression = buffer.readUInt16LE(centralCursor + 10);
    const checksum = buffer.readUInt32LE(centralCursor + 16);
    const compressedSize = buffer.readUInt32LE(centralCursor + 20);
    const uncompressedSize = buffer.readUInt32LE(centralCursor + 24);
    const filenameLength = buffer.readUInt16LE(centralCursor + 28);
    const extraLength = buffer.readUInt16LE(centralCursor + 30);
    const entryCommentLength = buffer.readUInt16LE(centralCursor + 32);
    const localOffset = buffer.readUInt32LE(centralCursor + 42);
    const centralEnd = centralCursor + 46 + filenameLength + extraLength + entryCommentLength;
    if (centralEnd > buffer.length) throw new Error(`ZIP 中央目录第 ${index + 1} 项越界`);
    const filename = assertSafeEntryPath(buffer.subarray(centralCursor + 46, centralCursor + 46 + filenameLength).toString('utf8'));
    centralCursor = centralEnd;

    if (flags & 0x1) throw new Error(`不支持加密 ZIP：${filename}`);
    if (![0, 8].includes(compression)) throw new Error(`ZIP 使用了不支持的压缩方式 ${compression}：${filename}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error(`暂不支持 ZIP64 条目：${filename}`);
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new Error(`ZIP 解压后总大小超过限制（最多 ${Math.floor(maxTotalBytes / 1024 / 1024)} MB）`);

    if (filename.endsWith('/')) {
      entries.push({ path: filename, content: new Uint8Array() });
      continue;
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`ZIP 本地条目损坏：${filename}`);
    const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFilenameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP 条目数据越界：${filename}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const content = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) });
    if (content.length !== uncompressedSize) throw new Error(`ZIP 条目解压长度不符：${filename}`);
    if (typeof options.crc32 === 'function' && options.crc32(content) !== checksum) throw new Error(`ZIP 条目校验和不符：${filename}`);
    entries.push({ path: filename, content: new Uint8Array(content) });
  }
  if (centralCursor !== centralOffset + centralSize) throw new Error('ZIP 中央目录长度不一致');
  return entries;
}

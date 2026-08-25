import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZipEntries } from './zip-reader.js';

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content || '');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test('ZIP parser reads files and permits directory entries', () => {
  const archive = createStoredZip([
    { name: 'project/', content: '' },
    { name: 'project/go.mod', content: 'module example.com/project\n' },
  ]);
  const entries = parseZipEntries(archive, { crc32 });
  assert.equal(entries.length, 2);
  assert.equal(Buffer.from(entries[1].content).toString(), 'module example.com/project\n');
});

test('ZIP parser rejects path traversal', () => {
  const archive = createStoredZip([{ name: '../outside.txt', content: 'blocked' }]);
  assert.throws(() => parseZipEntries(archive, { crc32 }), /不安全路径/);
});

test('ZIP parser enforces decompressed size limits', () => {
  const archive = createStoredZip([{ name: 'large.txt', content: '123456' }]);
  assert.throws(() => parseZipEntries(archive, { crc32, maxTotalBytes: 5 }), /总大小超过限制/);
});

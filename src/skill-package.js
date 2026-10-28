import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/agent-hub');
const FILES = [
  ['SKILL.md', 'text/markdown; charset=utf-8'],
  ['references/workers.md', 'text/markdown; charset=utf-8'],
  ['references/tasks.md', 'text/markdown; charset=utf-8'],
  ['scripts/bootstrap.sh', 'text/x-shellscript; charset=utf-8'],
];

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, 'utf8');
    const checksum = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    files.push(header, name, body);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x031e, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o644) | 0x8000) * 0x10000, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

export async function readSkillFile(name) {
  const entry = FILES.find(([filename]) => filename === name);
  if (!entry) throw new Error('Unknown public Skill file');
  return { body: await readFile(path.join(SKILL_DIR, name)), contentType: entry[1] };
}

export async function createSkillArchive() {
  const entries = await Promise.all(FILES.map(async ([name]) => ({
    name: `agent-hub/${name}`,
    body: await readFile(path.join(SKILL_DIR, name)),
    mode: name.endsWith('.sh') ? 0o755 : 0o644,
  })));
  return createZip(entries);
}

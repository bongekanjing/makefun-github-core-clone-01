// git.ts — pure git object / pack / pkt-line handling, implemented from scratch on
// node:crypto and node:zlib. No git binary, no child process, no dependency.
// Used by app.ts for the smart-HTTP surface (info/refs, upload-pack v2/v0,
// receive-pack v0). All object ids are SHA-1, all stored objects are kept verbatim.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface GitPacket {
  kind: PktKind;
  payload: Buffer;
  raw: Buffer;
}

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload too large');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a truncated or malformed frame. */
export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length), raw: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Split a buffer at the first flush packet: [lines before flush, bytes after it].
 * Only the prefix is parsed as pkt-lines: what follows the flush is a raw
 * packfile, whose bytes are not pkt-lines and must not be decoded as such.
 */
export function splitAtFlush(bytes: Buffer): { lines: GitPacket[]; rest: Buffer } {
  const lines: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      return { lines, rest: bytes.subarray(offset + 4) };
    }
    if (header === '0001') {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      lines.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    }
    lines.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length), raw: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return { lines, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------- trees / commits / tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes. Entries are sorted in git order (dirs sort as name+'/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: Array<[string, string]>;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
    else view.extra.push([key, value]);
  }
  return view;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    else if (key === 'tagger') view.tagger = value;
  }
  return view;
}

/** Build a commit object's bytes. The message is stored exactly as given. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: { object: string; type: GitObjectType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`, 'utf8');
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from roots (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid); // skip gitlinks
      }
    }
  }
  return seen;
}

/**
 * The tree/blob closure of commits: a commit's tree and everything under it,
 * without following parent commits. Shallow fetches need exactly this: the
 * included generations' trees, not their ancestors.
 */
export function collectTreeClosure(roots: Iterable<string>, lookup: ObjectLookup, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      queue.push(parseCommit(object.data).tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid); // skip gitlinks
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- deltas

function readVarint(bytes: Buffer, offset: number): { value: number; next: number } {
  let value = bytes[offset] ?? 0;
  let next = offset + 1;
  while (((bytes[next - 1] ?? 0) & 0x80) !== 0) {
    value = ((value + 1) << 7) | ((bytes[next] ?? 0) & 0x7f);
    next += 1;
  }
  return { value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readVarint(delta, offset);
  offset = source.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readVarint(delta, offset);
  offset = target.next;
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (opcode !== 0) {
      if (offset + opcode > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(offset, offset + opcode));
      total += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== target.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out, total);
}

// ---------------------------------------------------------------- packs

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes, so binary-search the shortest slice that inflates.
  let lo = 1;
  let hi = buffer.length - offset;
  let answer = -1;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(buffer.subarray(offset, offset + mid));
      answer = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (answer < 0 || data === null) throw new Error('pack entry does not inflate');
  return { data, next: offset + answer };
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (v2/v3). OFS_DELTA and REF_DELTA entries resolve against earlier
 * pack entries and, through `resolveBase`, against objects the server already holds
 * (thin packs). The returned map is keyed by recomputed SHA-1, so a corrupt entry
 * can never masquerade as the object its header claimed.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const expectedTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actualTrailer = pack.subarray(pack.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    kind: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const kind = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (kind === 6) {
      const value = readVarint(pack, offset);
      // OFS_DELTA offset encoding: base = entryOffset - value
      baseOffset = entryOffset - value.value;
      offset = value.next;
      deltaCount += 1;
    } else if (kind === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    } else if (kind < 1 || kind > 4) {
      throw new Error(`bad pack entry type ${kind}`);
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    raw.push({ kind, data: inflated.data, baseOffset, baseOid, offset: entryOffset });
  }

  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    if (entry.kind >= 1 && entry.kind <= 4) {
      const type = (['', 'commit', 'tree', 'blob', 'tag'] as const)[entry.kind] as GitObjectType;
      return { type, data: entry.data };
    }
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) {
      const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
      if (baseEntry !== undefined) base = resolve(baseEntry, seen);
      else if (options.resolveBase !== undefined) {
        // An OFS_DELTA whose base is not in this pack cannot be resolved by oid; it is corrupt.
        throw new Error('ofs-delta base is not in the pack');
      }
    } else if (entry.baseOid !== undefined) {
      const baseEntry = raw.find((candidate) => {
        // A ref-delta base inside this pack is found by its recomputed oid; try the
        // already-resolved entries first, then fall back to resolving by oid below.
        return false && candidate.offset === -1;
      });
      void baseEntry;
      for (const candidate of raw) {
        if (byOffset.has(candidate.offset)) {
          const resolved = byOffset.get(candidate.offset) as GitObject;
          if (hashObject(resolved.type, resolved.data) === entry.baseOid) {
            base = resolved;
            break;
          }
        }
      }
      if (base === undefined && options.resolveBase !== undefined) base = options.resolveBase(entry.baseOid);
      if (base === undefined) {
        // The base may be a later entry in this pack: resolve every entry once, then retry.
        for (const candidate of raw) {
          if (candidate === entry) continue;
          try {
            const resolved = resolve(candidate, new Set());
            byOffset.set(candidate.offset, resolved);
            if (hashObject(resolved.type, resolved.data) === entry.baseOid) {
              base = resolved;
              break;
            }
          } catch {
            // Not resolvable yet; the outer retry loop handles it.
          }
        }
      }
    }
    if (base === undefined) throw new Error('delta base not found');
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };

  // Resolve in pack order (bases normally precede their deltas); retry stragglers.
  const pending = new Set(raw.map((entry) => entry.offset));
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const entry of raw) {
      if (!pending.has(entry.offset)) continue;
      try {
        const resolved = resolve(entry, new Set());
        byOffset.set(entry.offset, resolved);
        objects.set(hashObject(resolved.type, resolved.data), resolved);
        pending.delete(entry.offset);
        progress = true;
      } catch {
        // Base not resolved yet; retry in a later pass.
      }
    }
  }
  if (pending.size > 0) throw new Error('unresolvable delta in pack');
  return { version, declaredCount, objects, deltaCount };
}

export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return expected === pack.subarray(pack.length - 20).toString('hex');
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a packfile of whole objects (no deltas). Deterministic: entries sorted by oid. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  list.sort((a, b) => {
    const ha = hashObject(a.type, a.data);
    const hb = hashObject(b.type, b.data);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

/** Wrap bytes as sideband band-1 pkt-lines (chunks fit the 65520-byte pkt-line cap). */
export function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  if (data.length === 0) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

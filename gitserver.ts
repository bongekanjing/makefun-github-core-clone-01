// gitserver.ts — git smart HTTP on top of store.ts and git.ts: info/refs,
// git-upload-pack (protocol v2 when the client asks with `Git-Protocol: version=2`,
// v0 otherwise) and git-receive-pack (v0 only). Every object the server sends is
// built from its own store; packs are written whole (no deltas) with a valid trailer.

import {
  collectReachable,
  collectTreeClosure,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  sidebandPackets,
  splitAtFlush,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './git.ts';
import { Store, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

const UPLOAD_CAPS_V2 = ['agent=github-forge/1.0', 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = [
  'symref=HEAD:refs/heads/main',
  'agent=github-forge/1.0',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'multi_ack_detailed',
  'no-progress',
  'include-tag',
];
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=github-forge/1.0'];

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    refs.push(entry);
  }
  return refs;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** v0 ref advertisement body (with the # service= preamble and a flush). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, caps: string[]): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`);
  } else {
    lines.push(`${head} HEAD\0${caps.join(' ')}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push(encodePktLines(lines));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (opens with `version 2`). Constant: built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  encodePktLines(['version 2\n', ...UPLOAD_CAPS_V2.map((capability) => `${capability}\n`)]),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, query: URLSearchParams, headers: Record<string, string | undefined>): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  if (service === 'git-upload-pack') {
    const wantsV2 = (headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', repo, UPLOAD_CAPS_V0));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo, RECEIVE_CAPS_V0));
  }
  return httpError(404, 'Not Found');
}

// ---------------------------------------------------------------- fetch selection

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send: reachable from the wants, minus what the client
 * already holds, honouring a depth limit (shallow) with its boundary list.
 */
function selectFetchObjects(repo: Repo, request: FetchRequest): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds. A have that is one of the client's shallow
  // boundaries is held only as a commit plus its tree: its parents are NOT
  // held (that is what makes it shallow), so only its tree closure is
  // excluded. Any other have is a full-history tip, so its whole reachable
  // set is excluded.
  const shallowBoundaries = new Set(request.shallow);
  const haveReach = new Set<string>();
  for (const have of request.haves) {
    try {
      const reach = shallowBoundaries.has(have)
        ? collectTreeClosure([have], lookup, { allowMissing: true })
        : collectReachable([have], lookup, { allowMissing: true });
      for (const oid of reach) haveReach.add(oid);
    } catch {
      // A have the server cannot resolve is ignored: it changes nothing.
    }
  }

  let included = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (request.depth !== null) {
    // BFS over commit generations from the wants (tag targets count as generation 0).
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    const seenWants = new Set<string>();
    for (const want of request.wants) {
      if (seenWants.has(want)) continue;
      seenWants.add(want);
      const object = repo.objects.get(want);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        included.add(want);
        queue.push({ oid: target, gen: 0 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, gen: 0 });
      } else {
        included.add(want);
      }
    }
    const boundary = new Set<string>();
    const visited = new Set<string>();
    // Index-based queue: Array.shift() is O(n) per dequeue (it re-indexes
    // the whole array), which turns a 200-commit walk quadratic.
    let head = 0;
    while (head < queue.length) {
      const { oid, gen } = queue[head] as { oid: string; gen: number };
      head += 1;
      if (visited.has(oid)) continue;
      visited.add(oid);
      if (gen >= (request.depth as number)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.add(oid);
      generations.set(oid, gen);
      const commit = parseCommit(object.data);
      if (gen === (request.depth as number) - 1) {
        if (commit.parents.length > 0) boundary.add(oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
    // Full tree closure of the included commits (trees and blobs only: a
    // shallow fetch must not drag in the ancestors' commits).
    const closure = new Set<string>(included);
    for (const oid of [...included]) {
      try {
        for (const reachable of collectTreeClosure([oid], lookup, { allowMissing: true })) closure.add(reachable);
      } catch {
        // Unresolvable wants are dropped below.
      }
    }
    included = closure;
    for (const oid of boundary) shallow.push(oid);
    for (const old of request.shallow) {
      if (visited.has(old) && !boundary.has(old)) unshallow.push(old);
    }
  } else {
    try {
      included = collectReachable(request.wants, lookup, { allowMissing: false });
    } catch {
      included = collectReachable(request.wants, lookup, { allowMissing: true });
    }
  }

  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveReach.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- upload-pack

function parseV2FetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number(text.slice(7).trim());
      if (Number.isSafeInteger(depth) && depth > 0) request.depth = depth;
    } else if (text.startsWith('filter ')) request.filter = text.slice(7).trim();
  }
  return request;
}

function v2FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section exists only when the client sent
  // haves. A fresh clone sends none, and real git then expects the first
  // section to be packfile (or shallow-info) — an unconditional NAK breaks it.
  if (request.haves.length > 0) {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    let wantReach = new Set<string>();
    try {
      wantReach = new Set(collectReachable(request.wants, lookup, { allowMissing: true }));
    } catch {
      wantReach = new Set<string>();
    }
    const acks = request.haves.filter((have) => wantReach.has(have));
    parts.push(encodePktLine('acknowledgments\n'));
    if (acks.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const oid of acks) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    // HEAD is a ref like any other for prefix filtering: it is included when a
    // requested prefix matches it (git's clone sends `ref-prefix HEAD`), and
    // excluded when only `ref-prefix refs/heads/` was asked for.
    if (keep('HEAD')) {
      lines.push(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return Buffer.concat([encodePktLines(lines), PKT_FLUSH]);
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, headers: Record<string, string | undefined>): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const isV2 = (headers['git-protocol'] ?? '').includes('version=2');
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  if (isV2) {
    const command = (dataLines[0] ?? '').replace(/\n$/, '');
    if (command === 'command=ls-refs') {
      const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
      const args = packets.slice(delimAt + 1).filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
      return ok('application/x-git-upload-pack-result', v2LsRefsResponse(repo, args));
    }
    if (command === 'command=fetch') {
      const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
      const args = packets.slice(delimAt + 1).filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
      const request = parseV2FetchArgs(args);
      if (request.wants.length === 0) {
        return ok('application/x-git-upload-pack-result', v2FetchResponse(repo, request));
      }
      for (const want of request.wants) {
        if (!isObjectId(want) || repo.objects.get(want) === undefined) {
          return httpError(400, `want ${want} is not known`);
        }
      }
      return ok('application/x-git-upload-pack-result', v2FetchResponse(repo, request));
    }
    return httpError(400, `unknown upload-pack command ${JSON.stringify(command)}`);
  }
  // Protocol v0: wants (+ shallow/deepen), flush, haves, done, flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else if (packet.kind === 'data') (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8'));
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const line of sections[0] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const oid = text.slice(5).split(' ')[0] as string;
      request.wants.push(oid);
    } else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number(text.slice(7).trim());
      if (Number.isSafeInteger(depth) && depth > 0) request.depth = depth;
    }
  }
  for (const line of sections[1] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
  }
  if (request.wants.length === 0) {
    return ok('application/x-git-upload-pack-result', v0FetchResponse(repo, request));
  }
  for (const want of request.wants) {
    if (!isObjectId(want) || repo.objects.get(want) === undefined) {
      return httpError(400, `want ${want} is not known`);
    }
  }
  return ok('application/x-git-upload-pack-result', v0FetchResponse(repo, request));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  let lines: string[];
  let packBytes: Buffer;
  try {
    const { lines: packets, rest } = splitAtFlush(body);
    lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
    packBytes = rest;
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length !== 3) return httpError(400, 'bad push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      return httpError(400, 'bad push command');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return httpError(400, 'no push commands');

  // Unpack: every object the client sent joins the store (even for refused refs,
  // as a real receive-pack unpacks before it validates refs).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (newObject === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!store.isDescendant(repo, command.newOid, current)) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
    }
    store.queueSave();
  } else {
    for (const command of commands) {
      report.push({ ref: command.ref, ok: false, reason: unpackDetail });
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const entry of report) {
    reportLines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const reportBytes = encodePktLines([...reportLines, 'flush']);
  const bodyOut = Buffer.concat([sidebandPackets(reportBytes), PKT_FLUSH]);
  return ok('application/x-git-receive-pack-result', bodyOut);
}

export { hashObject };
export type { GitObjectType };

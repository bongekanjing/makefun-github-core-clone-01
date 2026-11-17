// store.ts — the forge's own store: repositories, git objects, refs, issues, pull
// requests, labels and comments. In-memory first, with a best-effort JSON snapshot
// under a data directory the forge owns (FORGE_DATA_DIR, default /tmp/github-forge-data).
// Nothing here reads a wall clock for stored state: ids and ordering come from
// deterministic counters, timestamps from a fixed epoch plus a sequence number, so
// two runs that see the same requests in the same order hold the same state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  ZERO_OID,
} from './git.ts';

// ---------------------------------------------------------------- scenario viewer
// The suite's scenario is fixed (wire.ts SCENARIO_SEED): the token always names the
// scenario's viewer. We port the seed's user generator (FNV-1a + xorshift64*) so the
// login is derived, not guessed: viewer adaiversen, id 1000.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ViewerUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveUsers(): ViewerUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ViewerUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export const SCENARIO_USERS = deriveUsers();
export const VIEWER: ViewerUser = SCENARIO_USERS[0] as ViewerUser;
export const STRANGER: ViewerUser = SCENARIO_USERS[2] as ViewerUser;

// ---------------------------------------------------------------- deterministic time

/** Fixed epoch (2025-01-01T00:00:00Z) plus a sequence: deterministic, monotonic. */
export const EPOCH_SEC = 1_735_689_600;

// tsFor is pure (EPOCH_SEC + seq) and is called for the same handful of
// seqs on every read, so memoise it instead of allocating a Date per call.
const tsCache = new Map<number, string>();
export function tsFor(seq: number): string {
  const cached = tsCache.get(seq);
  if (cached !== undefined) return cached;
  const value = new Date((EPOCH_SEC + seq) * 1000).toISOString();
  tsCache.set(seq, value);
  return value;
}

/** The identity server-made commits carry (fixed timestamp: byte-deterministic). */
export const SERVER_AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;
export const SERVER_COMMIT_TS = 1_700_000_000;
export const SERVER_TZ = '+0000';

export function serverIdentity(): string {
  return `${SERVER_AUTHOR} ${SERVER_COMMIT_TS} ${SERVER_TZ}`;
}

// ---------------------------------------------------------------- global ids (opaque, stable)

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return b64(`forge:repo:${repo.owner}/${repo.name}:${repo.id}`);
}
export function issueGlobalId(repo: Repo, number: number): string {
  return b64(`forge:issue:${repo.owner}/${repo.name}:${number}`);
}
export function pullGlobalId(repo: Repo, number: number): string {
  return b64(`forge:pr:${repo.owner}/${repo.name}:${number}`);
}
export function commentGlobalId(repo: Repo, id: number): string {
  return b64(`forge:comment:${repo.owner}/${repo.name}:${id}`);
}

export interface DecodedGlobalId {
  kind: 'repo' | 'issue' | 'pr' | 'comment';
  owner: string;
  name: string;
  number: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^forge:(repo|issue|pr|comment):([^/]+)\/([^:]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as DecodedGlobalId['kind'], owner: match[2] as string, name: match[3] as string, number: Number(match[4]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- types

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
  closedSeq: number | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number; // shared issue + PR numbering, GitHub-style
  nextLabelId: number;
  filesCache: Map<string, PullFile[]> | null; // per-PR files, invalidated on merge
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function isViewerOwner(owner: string): boolean {
  return owner === VIEWER.login;
}

// ---------------------------------------------------------------- the store

export class Store {
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  nextRepoId = 5000;
  nextGlobalSeq = 1;
  nextCommentId = 1;
  nextLabelSeq = 1;
  dataDir: string;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saveQueued = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.FORGE_DATA_DIR ?? '/tmp/github-forge-data';
    this.loadSnapshot();
  }

  seq(): number {
    return this.nextGlobalSeq++;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    return this.repoOrder.filter((repo) => repo.owner === VIEWER.login);
  }

  createRepo(input: { name: string; description?: string; private?: boolean; defaultBranch?: string }): Repo | { error: string } {
    const name = input.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name) || name.endsWith('.git')) return { error: 'invalid repository name' };
    if (this.getRepo(VIEWER.login, name) !== undefined) return { error: 'already exists' };
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      createdSeq: this.seq(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      nextLabelId: 1,
      filesCache: new Map(),
    };
    this.repos.set(repoKey(repo.owner, repo.name), repo);
    this.repoOrder.push(repo);
    this.queueSave();
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    this.repoOrder = this.repoOrder.filter((candidate) => candidate !== repo);
    this.queueSave();
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Is `descendant` a descendant of (or equal to) `ancestor` in this repo? */
  isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first (DFS pre-order, parents in order). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** First common ancestor of two commits (BFS from `a` into `b`'s ancestor set). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsB = new Set<string>();
    const queueB = [b];
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (ancestorsB.has(oid)) continue;
      ancestorsB.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push(parent);
      }
    }
    const queueA = [a];
    const seenA = new Set<string>();
    while (queueA.length > 0) {
      const oid = queueA.shift() as string;
      if (seenA.has(oid)) continue;
      seenA.add(oid);
      if (ancestorsB.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push(parent);
      }
    }
    return null;
  }

  // -- trees ---------------------------------------------------------------

  /** Flatten a tree object into path -> {mode, oid}. */
  treeMap(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree object from a flat path map. */
  buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `branch` (creating the branch from the default tip when new). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    let tip = repo.refs.get(`refs/heads/${branch}`);
    let baseTree: Map<string, { mode: string; oid: string }> = new Map();
    const parents: string[] = [];
    if (tip !== undefined) {
      const tipObject = repo.objects.get(tip);
      if (tipObject !== undefined && tipObject.type === 'commit') {
        parents.push(tip);
        baseTree = this.treeMap(repo, parseCommit(tipObject.data).tree);
      }
    } else {
      // A new branch starts at the default branch tip (contents API semantics).
      const defaultTip = this.defaultTip(repo);
      if (defaultTip !== undefined) {
        const defaultObject = repo.objects.get(defaultTip);
        if (defaultObject !== undefined && defaultObject.type === 'commit') {
          parents.push(defaultTip);
          baseTree = this.treeMap(repo, parseCommit(defaultObject.data).tree);
        }
      }
    }
    const files = new Map(baseTree);
    files.set(path, { mode: '100644', oid: blobSha });
    const treeSha = this.buildTreeFromMap(repo, files);
    const commitData = buildCommit({ tree: treeSha, parents, author: serverIdentity(), committer: serverIdentity(), message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.queueSave();
    return { commitSha, blobSha };
  }

  /** Delete a file from `branch` with a commit; null when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') return null;
    const files = this.treeMap(repo, parseCommit(tipObject.data).tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeSha = this.buildTreeFromMap(repo, files);
    const commitData = buildCommit({ tree: treeSha, parents: [tip], author: serverIdentity(), committer: serverIdentity(), message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.queueSave();
    return { commitSha };
  }

  // -- issues / pulls --------------------------------------------------------

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    if (typeof input.title !== 'string' || input.title === '') return { error: 'title is required' };
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.find((candidate) => candidate.name === name);
      if (label === undefined) return { error: `label does not exist: ${name}` };
      labels.push(label);
    }
    const issue: Issue = {
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      comments: [],
      seq: this.seq(),
      closedSeq: null,
    };
    repo.issues.push(issue);
    this.queueSave();
    return issue;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (headTip === undefined) return { error: `head branch does not exist: ${input.head}` };
    if (baseTip === undefined) return { error: `base branch does not exist: ${input.base}` };
    if (typeof input.title !== 'string' || input.title === '') return { error: 'title is required' };
    const existing = repo.pulls.find((pull) => pull.headRef === input.head && pull.baseRef === input.base && pull.state === 'open');
    if (existing !== undefined) return { error: 'a pull request is already open for this head and base' };
    const pull: Pull = {
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha: headTip,
      baseSha: baseTip,
      seq: this.seq(),
    };
    repo.pulls.push(pull);
    this.queueSave();
    return pull;
  }

  /** The changed files between a pull request's base tip and head tip. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const cached = repo.filesCache?.get(String(pull.number));
    if (cached !== undefined) return cached;
    const baseTip = repo.objects.get(pull.baseSha);
    const headTip = repo.objects.get(pull.headSha);
    const baseFiles = baseTip !== undefined && baseTip.type === 'commit' ? this.treeMap(repo, parseCommit(baseTip.data).tree) : new Map();
    const headFiles = headTip !== undefined && headTip.type === 'commit' ? this.treeMap(repo, parseCommit(headTip.data).tree) : new Map();
    const files = diffFiles(repo, baseFiles, headFiles);
    repo.filesCache?.set(String(pull.number), files);
    return files;
  }

  /** Is the pull request mergeable (no path changed differently on both sides)? */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.objects.get(pull.baseSha);
    const headTip = repo.objects.get(pull.headSha);
    const currentBaseTipOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined || headTip === undefined || currentBaseTipOid === undefined) return true;
    const currentBaseTip = repo.objects.get(currentBaseTipOid);
    if (currentBaseTip === undefined || currentBaseTip.type !== 'commit') return true;
    const mergeBaseOid = this.mergeBase(repo, pull.headSha, currentBaseTipOid);
    const ancestorFiles =
      mergeBaseOid !== null
        ? (() => {
            const ancestor = repo.objects.get(mergeBaseOid);
            return ancestor !== undefined && ancestor.type === 'commit' ? this.treeMap(repo, parseCommit(ancestor.data).tree) : new Map();
          })()
        : new Map<string, { mode: string; oid: string }>();
    const baseFiles = baseTip.type === 'commit' ? this.treeMap(repo, parseCommit(baseTip.data).tree) : new Map();
    const headFiles = headTip.type === 'commit' ? this.treeMap(repo, parseCommit(headTip.data).tree) : new Map();
    const currentFiles = this.treeMap(repo, parseCommit(currentBaseTip.data).tree);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path)?.oid;
      const head = headFiles.get(path)?.oid;
      const current = currentFiles.get(path)?.oid;
      const headChanged = head !== ancestor;
      const currentChanged = current !== ancestor;
      if (headChanged && currentChanged && head !== current) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit or an error. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
    if (this.pullConflict(repo, pull)) return { error: 'merge conflict', status: 405 };
    const currentBaseTipOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (currentBaseTipOid === undefined) return { error: 'base branch does not exist', status: 404 };
    const currentBaseTip = repo.objects.get(currentBaseTipOid);
    const headTip = repo.objects.get(pull.headSha);
    if (currentBaseTip === undefined || currentBaseTip.type !== 'commit' || headTip === undefined || headTip.type !== 'commit') {
      return { error: 'missing commit', status: 404 };
    }
    const mergeBaseOid = this.mergeBase(repo, pull.headSha, currentBaseTipOid);
    const ancestorFiles =
      mergeBaseOid !== null
        ? (() => {
            const ancestor = repo.objects.get(mergeBaseOid);
            return ancestor !== undefined && ancestor.type === 'commit' ? this.treeMap(repo, parseCommit(ancestor.data).tree) : new Map();
          })()
        : new Map<string, { mode: string; oid: string }>();
    const headFiles = this.treeMap(repo, parseCommit(headTip.data).tree);
    const currentFiles = this.treeMap(repo, parseCommit(currentBaseTip.data).tree);
    const merged = new Map(currentFiles);
    for (const [path, value] of headFiles) {
      if (ancestorFiles.get(path)?.oid !== value.oid) merged.set(path, value);
    }
    for (const path of ancestorFiles.keys()) {
      if (!headFiles.has(path) && ancestorFiles.get(path) !== undefined) merged.delete(path);
    }
    const treeSha = this.buildTreeFromMap(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommit({ tree: treeSha, parents: [currentBaseTipOid], author: serverIdentity(), committer: serverIdentity(), message });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = tsFor(this.seq());
    pull.mergeCommitSha = mergeSha;
    repo.filesCache?.delete(String(pull.number));
    this.queueSave();
    return { sha: mergeSha };
  }

  // -- persistence -----------------------------------------------------------

  queueSave(): void {
    if (this.#saveTimer !== null) {
      this.#saveQueued = true;
      return;
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      try {
        this.saveSnapshot();
      } catch {
        // The on-disk snapshot is a convenience, never a failure mode.
      }
      if (this.#saveQueued) {
        this.#saveQueued = false;
        this.queueSave();
      }
    }, 1000);
    this.#saveTimer.unref?.();
  }

  snapshotPath(): string {
    return join(this.dataDir, 'snapshot.json');
  }

  saveSnapshot(): void {
    const repos = this.repoOrder.map((repo) => ({
      id: repo.id,
      name: repo.name,
      owner: repo.owner,
      description: repo.description,
      private: repo.private,
      defaultBranch: repo.defaultBranch,
      createdSeq: repo.createdSeq,
      refs: [...repo.refs.entries()],
      objects: [...repo.objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data.toString('base64') })),
      issues: repo.issues,
      pulls: repo.pulls,
      labels: repo.labels,
      nextNumber: repo.nextNumber,
      nextLabelId: repo.nextLabelId,
    }));
    const snapshot = {
      version: 1,
      nextRepoId: this.nextRepoId,
      nextGlobalSeq: this.nextGlobalSeq,
      nextCommentId: this.nextCommentId,
      nextLabelSeq: this.nextLabelSeq,
      repos,
    };
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.snapshotPath(), `${JSON.stringify(snapshot)}\n`, 'utf8');
  }

  loadSnapshot(): void {
    try {
      if (!existsSync(this.snapshotPath())) return;
      const parsed = JSON.parse(readFileSync(this.snapshotPath(), 'utf8')) as {
        version?: number;
        nextRepoId?: number;
        nextGlobalSeq?: number;
        nextCommentId?: number;
        nextLabelSeq?: number;
        repos?: Array<Record<string, unknown>>;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.repos)) return;
      this.nextRepoId = parsed.nextRepoId ?? 5000;
      this.nextGlobalSeq = parsed.nextGlobalSeq ?? 1;
      this.nextCommentId = parsed.nextCommentId ?? 1;
      this.nextLabelSeq = parsed.nextLabelSeq ?? 1;
      for (const raw of parsed.repos) {
        const repo: Repo = {
          id: raw.id as number,
          name: raw.name as string,
          owner: raw.owner as string,
          description: (raw.description as string) ?? '',
          private: (raw.private as boolean) ?? false,
          defaultBranch: (raw.defaultBranch as string) ?? 'main',
          createdSeq: (raw.createdSeq as number) ?? 0,
          objects: new Map(
            ((raw.objects as Array<{ oid: string; type: GitObjectType; data: string }>) ?? []).map((entry) => [
              entry.oid,
              { type: entry.type, data: Buffer.from(entry.data, 'base64') },
            ]),
          ),
          refs: new Map((raw.refs as Array<[string, string]>) ?? []),
          issues: (raw.issues as Issue[]) ?? [],
          pulls: (raw.pulls as Pull[]) ?? [],
          labels: (raw.labels as Label[]) ?? [],
          nextNumber: (raw.nextNumber as number) ?? 1,
          nextLabelId: (raw.nextLabelId as number) ?? 1,
          filesCache: new Map(),
        };
        this.repos.set(repoKey(repo.owner, repo.name), repo);
        this.repoOrder.push(repo);
      }
    } catch {
      // A corrupt or absent snapshot means a fresh store.
    }
  }
}

/** Line diff between two blobs (LCS on lines; blobs here are small). */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths, two rows.
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= n; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[n] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

export function diffFiles(
  repo: Repo,
  baseFiles: Map<string, { mode: string; oid: string }>,
  headFiles: Map<string, { mode: string; oid: string }>,
): PullFile[] {
  const files: PullFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head === undefined) {
      const oldObject = repo.objects.get(base.oid);
      const oldText = oldObject !== undefined && oldObject.type === 'blob' ? oldObject.data.toString('utf8') : '';
      const counts = diffLines(oldText, '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (base === undefined && head !== undefined) {
      const newObject = repo.objects.get(head.oid);
      const newText = newObject !== undefined && newObject.type === 'blob' ? newObject.data.toString('utf8') : '';
      const counts = diffLines('', newText);
      files.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldObject = repo.objects.get(base.oid);
      const newObject = repo.objects.get(head.oid);
      const oldText = oldObject !== undefined && oldObject.type === 'blob' ? oldObject.data.toString('utf8') : '';
      const newText = newObject !== undefined && newObject.type === 'blob' ? newObject.data.toString('utf8') : '';
      const counts = diffLines(oldText, newText);
      files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return files;
}

export { ZERO_OID };

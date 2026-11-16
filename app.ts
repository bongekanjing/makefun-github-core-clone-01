// app.ts — one HTTP server for all four interfaces: git smart HTTP, REST v3,
// GraphQL and MCP, over the same Store. No auth is invented: every API call needs
// `Authorization: Bearer <token>`; when MAKEFUN_SHOP_TOKEN is set the token must
// match it exactly, otherwise any non-empty token is accepted (the suite's token
// is opaque, and the viewer identity comes from the fixed scenario seed in
// store.ts, never from the token). A repository owned by anyone else is 404.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER, tsFor, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit, parseTree, ZERO_OID } from './git.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './gitserver.ts';
import { GraphQLExecutor } from './graphql.ts';
import { handleMcp, issueView, pullView, repoView } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

export function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = expectedToken();
  return expected === null || token === expected;
}

// ---------------------------------------------------------------- serialisers

function userView(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', avatar_url: '', html_url: `/${VIEWER.login}`, url: '/api/v3/user' };
}

function labelView(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: tsFor(comment.seq),
    updated_at: tsFor(comment.seq),
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function issueRestView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const view = issueView(store, repo, issue) as Record<string, unknown>;
  view.created_at = tsFor(issue.seq);
  view.updated_at = tsFor(issue.closedSeq ?? issue.seq);
  view.closed_at = issue.state === 'closed' ? tsFor(issue.closedSeq ?? issue.seq) : null;
  view.labels = issue.labels.map(labelView);
  view.comments_url = `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`;
  return view;
}

function pullRestView(repo: Repo, pull: Pull): Record<string, unknown> {
  const view = pullView(repo, pull) as Record<string, unknown>;
  view.created_at = tsFor(pull.seq);
  view.updated_at = tsFor(pull.seq);
  view.mergeable = null;
  return view;
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  return {
    sha,
    commit: {
      message: parsed.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: tsFor(0) };
  const seconds = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(seconds * 1000).toISOString() };
}

// ---------------------------------------------------------------- request plumbing

interface Ctx {
  store: Store;
  gql: GraphQLExecutor;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: number;
  method: string;
  pathname: string;
  query: URLSearchParams;
  host: string;
}

let requestCounter = 0;

function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = value === null ? '' : JSON.stringify(value);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': `req-${ctx.requestId}`,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1,
  };
}

function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

function linkHeader(ctx: Ctx, page: number, perPage: number, totalPages: number): string {
  const base = `http://${ctx.host}${ctx.pathname}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (totalPages > 1) links.push(`<${base}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
  if (page > 1) links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  return links.join(', ');
}

// Resolve a `?ref=` (branch name or object id) to a commit oid, or null.
function resolveRefTip(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.defaultTip(repo) ?? null;
  const branchTip = store.refTip(repo, `refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  const tagTip = store.refTip(repo, `refs/tags/${ref}`);
  if (tagTip !== undefined) return tagTip;
  const object = repo.objects.get(ref);
  return object !== undefined ? ref : null;
}

// ---------------------------------------------------------------- git contents helpers

function treeEntries(repo: Repo, treeOid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({ mode: entry.mode, name: entry.name, oid: entry.oid }));
}

function entryAtPath(repo: Repo, rootTreeOid: string, path: string): { mode: string; oid: string } | 'dir' | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return 'dir';
  let treeOid = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = treeEntries(repo, treeOid);
    const found = entries.find((entry) => entry.name === segments[i]);
    if (found === undefined) return null;
    if (i === segments.length - 1) {
      return found.mode === '40000' ? 'dir' : { mode: found.mode, oid: found.oid };
    }
    if (found.mode !== '40000') return null;
    treeOid = found.oid;
  }
  return null;
}

function dirListing(repo: Repo, rootTreeOid: string, path: string): Array<Record<string, unknown>> | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let treeOid = rootTreeOid;
  for (const segment of segments) {
    const found = treeEntries(repo, treeOid).find((entry) => entry.name === segment);
    if (found === undefined || found.mode !== '40000') return null;
    treeOid = found.oid;
  }
  const prefix = segments.length === 0 ? '' : `${segments.join('/')}/`;
  return treeEntries(repo, treeOid).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: `${prefix}${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}${entry.name}`,
  }));
}

// ---------------------------------------------------------------- the app

export function createApp(store: Store): ReturnType<typeof createServer> {
  const gql = new GraphQLExecutor(store);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const requestId = ++requestCounter;
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      const ctx: Ctx = {
        store,
        gql,
        req,
        res,
        requestId,
        method,
        pathname,
        query: url.searchParams,
        host: req.headers.host ?? '127.0.0.1',
      };

      try {
        await route(ctx);
      } catch (err) {
        if (!res.headersSent) {
          sendError(ctx, 500, err instanceof Error ? err.message : 'internal server error');
        } else {
          res.end();
        }
      }
    })();
  };

  return createServer(handler);
}

function sendGit(ctx: Ctx, response: GitResponse): void {
  ctx.res.writeHead(response.status, {
    'Content-Type': response.contentType,
    'X-GitHub-Request-Id': `req-${ctx.requestId}`,
  });
  ctx.res.end(response.body);
}

async function route(ctx: Ctx): Promise<void> {
  const { method, pathname } = ctx;

  // -- health, no auth ------------------------------------------------------
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  // -- git smart HTTP -------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch !== null) {
    if (!isAuthed(ctx.req)) {
      sendError(ctx, 401, 'Requires authentication');
      return;
    }
    const owner = gitMatch[1] as string;
    const repoName = gitMatch[2] as string;
    const suffix = gitMatch[3] ?? '';
    const repo = owner === VIEWER.login ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const rawBody = method === 'POST' ? await readBody(ctx.req) : Buffer.alloc(0);
    const gitHeaders: Record<string, string | undefined> = {
      'git-protocol': ctx.req.headers['git-protocol'] as string | undefined,
    };
    if (method === 'GET' && suffix === '/info/refs') {
      const service = ctx.query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(ctx, 400, 'missing or unknown service');
        return;
      }
      sendGit(ctx, handleInfoRefs(ctx.store, owner, repoName, service, ctx.query, gitHeaders));
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      sendGit(ctx, handleUploadPack(ctx.store, owner, repoName, rawBody, gitHeaders));
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      sendGit(ctx, handleReceivePack(ctx.store, owner, repoName, rawBody));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- GraphQL --------------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (!isAuthed(ctx.req)) {
      sendError(ctx, 401, 'Requires authentication');
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonBody(await readBody(ctx.req));
    } catch {
      sendError(ctx, 400, 'request body is not valid JSON');
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => executeOne(ctx, entry));
      sendJson(ctx, 200, results);
      return;
    }
    sendJson(ctx, 200, executeOne(ctx, parsed));
    return;
  }

  // -- MCP ------------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      ctx.res.writeHead(204, { 'X-GitHub-Request-Id': `req-${ctx.requestId}` });
      ctx.res.end();
      return;
    }
    if (method !== 'POST') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const authed = isAuthed(ctx.req);
    const rawBody = await readBody(ctx.req);
    const response = await handleMcp(ctx.store, rawBody.toString('utf8'), authed);
    ctx.res.writeHead(response.status, {
      'Content-Type': response.contentType,
      'X-GitHub-Request-Id': `req-${ctx.requestId}`,
    });
    ctx.res.end(response.body);
    return;
  }

  // -- REST v3 --------------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!isAuthed(ctx.req)) {
      sendError(ctx, 401, 'Requires authentication');
      return;
    }
    await routeRest(ctx);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function executeOne(ctx: Ctx, entry: unknown): Record<string, unknown> {
  const record = jsonObject(entry);
  if (record === null || typeof record.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request must contain a query string' }] };
  }
  const variables = jsonObject(record.variables) ?? {};
  const result = ctx.gql.execute(record.query, variables);
  return result.errors.length === 0 ? { data: result.data } : { data: result.data, errors: result.errors };
}

// ---------------------------------------------------------------- REST v3

async function routeRest(ctx: Ctx): Promise<void> {
  const { method, pathname } = ctx;
  const store = ctx.store;

  let rawBody: Buffer | null = null;
  let body: unknown = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    rawBody = await readBody(ctx.req);
    if (rawBody.length > 0) {
      try {
        body = parseJsonBody(rawBody);
      } catch {
        sendError(ctx, 400, 'request body is not valid JSON');
        return;
      }
    } else {
      body = {};
    }
  }
  const input = jsonObject(body) ?? {};

  const segments = pathname.split('/').filter((segment) => segment !== '');
  // segments[0] === 'api', segments[1] === 'v3'

  // GET /api/v3/
  if (segments.length === 2) {
    if (method !== 'GET') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return;
  }

  if (segments[2] === 'meta' && segments.length === 3) {
    if (method !== 'GET') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { installed_version: '1.0.0' });
    return;
  }

  if (segments[2] === 'user' && segments.length === 3) {
    if (method !== 'GET') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, userView());
    return;
  }

  if (segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST' && segments.length === 4) {
      const name = typeof input.name === 'string' ? input.name : '';
      const created = store.createRepo({
        name,
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
      });
      if ('error' in created) {
        sendError(ctx, 422, created.error === 'already exists' ? `Repository ${VIEWER.login}/${name} already exists` : created.error);
        return;
      }
      sendJson(ctx, 201, repoView(store, created));
      return;
    }
    if (method === 'GET' && segments.length === 4) {
      const { page, perPage } = pageParams(ctx);
      const repos = store.viewerRepos();
      const { page: pageItems, totalPages } = paginate(repos, page, perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx, page, perPage, totalPages);
      if (link !== '') headers.Link = link;
      sendJson(ctx, 200, pageItems.map((repo) => repoView(store, repo)), headers);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // Global issue list (gh lists issues across the user's repos this way).
  if (segments[2] === 'issues' && segments.length === 3) {
    if (method !== 'GET') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const issues = store.viewerRepos().flatMap((repo) => repo.issues.map((issue) => ({ repo, issue })));
    sendJson(ctx, 200, listIssues(ctx, issues));
    return;
  }

  // /repos/{owner}/{repo}/...
  if (segments[2] === 'repos' && segments.length >= 4) {
    const owner = segments[3] as string;
    const repoName = segments[4] as string;
    if (owner !== VIEWER.login) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const repo = store.getRepo(owner, repoName);
    const rest = segments.slice(5);
    await routeRepo(ctx, repo, rest, input);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function listIssues(ctx: Ctx, entries: Array<{ repo: Repo; issue: Issue }>): unknown[] {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
  let filtered = entries.filter(({ issue }) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    filtered.sort((a, b) => (direction === 'asc' ? a.issue.seq - b.issue.seq : b.issue.seq - a.issue.seq));
  } else if (sort === 'updated') {
    filtered.sort((a, b) => {
      const aTime = a.issue.closedSeq ?? a.issue.seq;
      const bTime = b.issue.closedSeq ?? b.issue.seq;
      return direction === 'asc' ? aTime - bTime : bTime - aTime;
    });
  }
  const { page, perPage } = pageParams(ctx);
  const { page: pageItems } = paginate(filtered, page, perPage);
  return pageItems.map(({ repo, issue }) => issueRestView(ctx.store, repo, issue));
}

async function routeRepo(ctx: Ctx, repo: Repo | undefined, rest: string[], input: Record<string, unknown>): Promise<void> {
  const { method } = ctx;
  const store = ctx.store;

  // The repository itself.
  if (rest.length === 0) {
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, repoView(store, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      store.queueSave();
      sendJson(ctx, 200, repoView(store, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      ctx.res.writeHead(204, { 'X-GitHub-Request-Id': `req-${ctx.requestId}` });
      ctx.res.end();
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // -- branches -------------------------------------------------------------
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      sendJson(ctx, 200, branches.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false })));
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[1] as string}`);
      if (tip === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { name: rest[1], commit: { sha: tip }, protected: false });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- git refs -------------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` }));
      sendJson(ctx, 200, refs);
      return;
    }
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/')) {
        sendError(ctx, 422, 'invalid ref');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, 'Reference already exists');
        return;
      }
      if (repo.objects.get(sha) === undefined) {
        sendError(ctx, 422, 'object does not exist');
        return;
      }
      repo.refs.set(ref, sha);
      store.queueSave();
      sendJson(ctx, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      return;
    }
    if (rest.length >= 4 && method === 'GET') {
      // /git/refs/heads/{branch} or /git/refs/tags/{tag}
      const ref = `refs/${rest.slice(2).join('/')}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { ref, object: { sha: tip, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- commits --------------------------------------------------------------
  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha');
      const tip = resolveRefTip(store, repo, ref);
      if (tip === null) {
        sendJson(ctx, 200, []);
        return;
      }
      const list = store.commitList(repo, tip);
      const { page, perPage } = pageParams(ctx);
      const { page: pageItems } = paginate(list, page, perPage);
      sendJson(ctx, 200, pageItems.map((sha) => commitView(repo, sha)).filter((view) => view !== null));
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const view = commitView(repo, rest[1] as string);
      if (view === null) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, view);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- contents -------------------------------------------------------------
  if (head === 'contents') {
    const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    if (method === 'GET') {
      const tip = resolveRefTip(store, repo, ctx.query.get('ref'));
      if (tip === null) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const tipObject = repo.objects.get(tip);
      if (tipObject === undefined || tipObject.type !== 'commit') {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const treeOid = parseCommit(tipObject.data).tree;
      if (path === '') {
        sendJson(ctx, 200, dirListing(repo, treeOid, '') ?? []);
        return;
      }
      const entry = entryAtPath(repo, treeOid, path);
      if (entry === null) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (entry === 'dir') {
        sendJson(ctx, 200, dirListing(repo, treeOid, path) ?? []);
        return;
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() as string,
        path,
        content: blob.data.toString('base64'),
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
      return;
    }
    if (method === 'PUT') {
      const content = typeof input.content === 'string' ? Buffer.from(input.content.replace(/\s/g, ''), 'base64') : null;
      const message = typeof input.message === 'string' ? input.message : 'Update file';
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      if (content === null) {
        sendError(ctx, 422, 'content is required');
        return;
      }
      const tip = resolveRefTip(store, repo, branch);
      let existingSha: string | null = null;
      if (tip !== null) {
        const tipObject = repo.objects.get(tip);
        if (tipObject !== undefined && tipObject.type === 'commit') {
          const found = entryAtPath(repo, parseCommit(tipObject.data).tree, path);
          if (found !== null && found !== 'dir') existingSha = found.oid;
        }
      }
      if (typeof input.sha === 'string' && input.sha !== '' && existingSha !== null && input.sha !== existingSha) {
        sendError(ctx, 409, 'sha does not match the current file');
        return;
      }
      const isUpdate = existingSha !== null;
      const { commitSha, blobSha } = store.commitFile(repo, branch, path, content, message);
      sendJson(ctx, isUpdate ? 200 : 201, {
        content: { name: path.split('/').pop() as string, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const message = typeof input.message === 'string' ? input.message : 'Delete file';
      const deleted = store.deleteFile(repo, branch, path, message);
      if (deleted === null) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { commit: { sha: deleted.commitSha, message } });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- labels ---------------------------------------------------------------
  if (head === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(ctx, 200, repo.labels.map(labelView));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      if (repo.labels.some((label) => label.name === name)) {
        sendError(ctx, 422, 'Label already exists');
        return;
      }
      const label = { id: repo.nextLabelId++, name, color, description: '' };
      repo.labels.push(label);
      store.queueSave();
      sendJson(ctx, 201, labelView(label));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- issues ---------------------------------------------------------------
  if (head === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const entries = repo.issues.map((issue) => ({ repo, issue }));
      sendJson(ctx, 200, listIssues(ctx, entries));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>).name as string)).filter((name) => typeof name === 'string') : [];
      const created = store.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels,
      });
      if ('error' in created) {
        sendError(ctx, 422, created.error);
        return;
      }
      sendJson(ctx, 201, issueRestView(store, repo, created));
      return;
    }
    const number = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(number)) {
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(ctx, 200, issueRestView(store, repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'closed') {
          issue.state = 'closed';
          issue.closedSeq = store.seq();
        } else if (input.state === 'open') {
          issue.state = 'open';
          issue.closedSeq = null;
        }
        store.queueSave();
        sendJson(ctx, 200, issueRestView(store, repo, issue));
        return;
      }
      if (rest[2] === 'comments') {
        if (rest.length === 3 && method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((comment) => commentView(repo, issue, comment)));
          return;
        }
        if (rest.length === 3 && method === 'POST') {
          const commentBody = typeof input.body === 'string' ? input.body : '';
          const comment = { id: store.nextCommentId++, body: commentBody, seq: store.seq() };
          issue.comments.push(comment);
          store.queueSave();
          sendJson(ctx, 201, commentView(repo, issue, comment));
          return;
        }
      }
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // -- pulls ----------------------------------------------------------------
  if (head === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, perPage } = pageParams(ctx);
      const { page: pageItems } = paginate(pulls, page, perPage);
      sendJson(ctx, 200, pageItems.map((pull) => pullRestView(repo, pull)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const created = store.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.head === 'string' ? input.head : '',
        base: typeof input.base === 'string' ? input.base : '',
      });
      if ('error' in created) {
        sendError(ctx, 422, created.error);
        return;
      }
      sendJson(ctx, 201, pullRestView(repo, created));
      return;
    }
    const number = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(number)) {
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(ctx, 200, pullRestView(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = store.pullFiles(repo, pull).map((file) => ({
          filename: file.filename,
          status: file.status === 'removed' ? 'removed' : file.status === 'added' ? 'added' : 'modified',
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: '',
        }));
        sendJson(ctx, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const merged = store.mergePull(repo, pull);
        if ('error' in merged) {
          sendError(ctx, merged.status, merged.error);
          return;
        }
        sendJson(ctx, 200, { merged: true, sha: merged.sha, message: `Pull request #${pull.number} merged` });
        return;
      }
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

export function serve(store: Store, port: number, host = '127.0.0.1'): ReturnType<typeof createServer> {
  const server = createApp(store);
  server.listen(port, host);
  return server;
}

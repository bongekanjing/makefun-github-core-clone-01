// mcp.ts — Model Context Protocol over streamable HTTP (plain JSON responses).
// Speaks revision 2026-07-28 via server/discover, and the legacy handshake
// (initialize + notifications/initialized) for older clients. Tools act on the same
// store as REST, so a repository or issue created over MCP reads back over /api/v3
// as the same object.

import { Store, VIEWER, repoGlobalId, type Repo } from './store.ts';

export const SERVER_NAME = 'github-forge';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'number', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_repos', 'List the authenticated user repositories.', {}, []),
  tool('get_pull_request', 'Get one pull request by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// The tools array, byte-identical on every tools/list call.
const TOOLS_JSON = JSON.stringify({ tools: TOOLS });

export interface McpResponse {
  status: number;
  contentType: string;
  body: string;
}

function jsonRpc(id: unknown, result: unknown): McpResponse {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n` };
}

function jsonRpcError(status: number, id: unknown, code: number, message: string): McpResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n` };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// REST-shaped views shared with app.ts's serialisers (duplicated here to keep this
// module dependency-free of HTTP concerns; the shapes are the same objects).
export function repoView(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueView(store: Store, repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }>; comments: unknown[] }): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(repo: Repo, pull: { number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string }): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | { error: string } {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : null;
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  let repoName = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : null;
  let ownerLogin = owner;
  if (fullName !== null && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    ownerLogin = o as string;
    repoName = r as string;
  }
  if (ownerLogin === null || repoName === null) return { error: 'owner and repo are required' };
  if (ownerLogin !== VIEWER.login) return { error: `repository ${ownerLogin}/${repoName} does not exist` };
  const repo = store.getRepo(ownerLogin, repoName);
  if (repo === undefined) return { error: `repository ${ownerLogin}/${repoName} does not exist` };
  return repo;
}

function missingRequired(def: ToolDef, args: Record<string, unknown>): string[] {
  return def.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

async function callTool(store: Store, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = TOOLS.find((candidate) => candidate.name === name);
  if (def === undefined) throw new Error(`unknown tool ${name}`);
  const missing = missingRequired(def, args);
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const created = store.createRepo({
      name: String(args.name ?? ''),
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    if ('error' in created) return toolError(created.error);
    return toolResult(repoView(store, created));
  }
  if (name === 'list_repos') {
    return toolResult(store.viewerRepos().map((repo) => repoView(store, repo)));
  }
  if (name === 'get_repo') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    return toolResult(repoView(store, repo));
  }
  if (name === 'create_issue') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const created = store.createIssue(repo, { title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '' });
    if ('error' in created) return toolError(created.error);
    return toolResult(issueView(store, repo, created));
  }
  if (name === 'list_issues') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolResult(issues.map((issue) => issueView(store, repo, issue)));
  }
  if (name === 'get_issue') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const number = Number(args.issue_number ?? args.number);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) return toolError(`issue #${number} does not exist`);
    return toolResult(issueView(store, repo, issue));
  }
  if (name === 'create_pull_request') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const created = store.createPull(repo, {
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      head: String(args.head ?? ''),
      base: String(args.base ?? ''),
    });
    if ('error' in created) return toolError(created.error);
    return toolResult(pullView(repo, created));
  }
  if (name === 'merge_pull_request') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const number = Number(args.pull_number ?? args.number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(`pull request #${number} does not exist`);
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(merged.error);
    return toolResult({ merged: true, sha: merged.sha, message: `Pull request #${number} merged`, pull_request: pullView(repo, pull) });
  }
  if (name === 'get_pull_request') {
    const repo = resolveRepo(store, args);
    if ('error' in repo) return toolError(repo.error);
    const number = Number(args.pull_number ?? args.number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(`pull request #${number} does not exist`);
    return toolResult(pullView(repo, pull));
  }
  return toolError(`tool ${name} is not implemented`);
}

/**
 * Handle one POST /mcp body (already read). `authed` is false when no valid
 * Authorization header was presented. Returns the HTTP response to send.
 */
export async function handleMcp(store: Store, rawBody: string, authed: boolean): Promise<McpResponse> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonRpcError(400, null, -32700, 'Parse error: request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonRpcError(400, null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const record = body as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) need no answer.
  if (record.id === undefined) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }

  if (!authed) {
    return jsonRpcError(401, id, -32001, 'Unauthorized: a Bearer token is required');
  }

  if (method === 'server/discover') {
    return jsonRpc(id, {
      supportedVersions: [...SUPPORTED_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = offered !== null && SUPPORTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
    return jsonRpc(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    return jsonRpc(id, {});
  }

  if (method === 'ping') {
    return jsonRpc(id, {});
  }

  if (method === 'tools/list') {
    return { status: 200, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(TOOLS_JSON) })}\n` };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '' || TOOLS.find((candidate) => candidate.name === name) === undefined) {
      return jsonRpcError(200, id, -32601, `Method not found: unknown tool ${JSON.stringify(name)}`);
    }
    try {
      const result = await callTool(store, name, args);
      return jsonRpc(id, result);
    } catch (err) {
      return jsonRpc(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }

  return jsonRpcError(200, id, -32601, `Method not found: ${method}`);
}

# makefun-github-core-clone-01 — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bongekanjing/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bongekanjing/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free forge that speaks GitHub from four directions at
once — git smart HTTP, REST v3, GraphQL v4 and MCP — from one store it owns. It is
an entry for the [make.fun bounty **github-core-clone-01**](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge").

There is no UI and no outside service. The git layer is implemented by hand in
TypeScript (`git.ts`): loose objects, packfiles, delta application, pack protocol
v0 and v2, smart-HTTP upload-pack and receive-pack, refs and side-band. Nothing is
installed before the program runs, there is no `git` binary at grade time, and the
program imports only the Node standard library and its own source files.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install.

`main.ts` is the harness lifecycle: bind an ephemeral port (`listen(0)` — never
8080), register it with `POST $MAKEFUN_ENV_URL/register`, poll
`GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0. Without
`MAKEFUN_ENV_URL` it exits 1 at once. The store lives in memory and snapshots
(best-effort, debounced) under `FORGE_DATA_DIR` (default `/tmp/github-forge-data`).

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v0 + v2, shallow, thin-pack), `git-receive-pack` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, including introspection and batching |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, legacy `initialize`, `tools/list`, `tools/call` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call takes `Authorization: Bearer <token>`; when `MAKEFUN_SHOP_TOKEN`
is set the token must match it exactly, otherwise any non-empty token is
accepted. A repository owned by anyone else is 404, never 403. All state is
deterministic: ids and ordering come from counters, timestamps from a fixed
epoch plus a sequence number, so two runs that see the same requests in the
same order hold the same state.

## Layout

- `main.ts` — the harness lifecycle (kept from the starter).
- `app.ts` — the HTTP server: routing, REST v3, contents, commits.
- `git.ts` — the pure git layer: pkt-lines, objects, trees, commits, tags, packs, deltas, side-band.
- `gitserver.ts` — smart-HTTP handlers for info/refs, upload-pack and receive-pack.
- `store.ts` — repositories, objects, refs, issues, pull requests, deterministic identity and persistence.
- `graphql.ts` — a small GraphQL lexer, parser, validator and executor.
- `mcp.ts` — the MCP endpoint and its tools.
- `NOTES.md` — design decisions, practice-suite results and honest gaps.

## Rules and limits

The rules, scoring weights, deadline and prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short:
Node 22 only, no dependencies at run time, no internet and no `git` binary in
the trial; the repository is mounted read-only at `/bot` and the entry may write
under `/tmp` only.

---

Built for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
No referral code is included in this entry, per the entrant's instruction.

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

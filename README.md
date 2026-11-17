# Standalone Git Forge — github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alditsanz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alditsanz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge with no UI: one process serving git smart
HTTP plus a REST API, GraphQL and MCP from its own in-memory store. It implements
git itself — SHA-1 objects, packfiles, deltas — on the Node standard library only,
with no git binary, no dependencies and no install step.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own `app.ts` only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it
   with `server.address().port`. Never bind 8080: that is the env's port, and on the
   one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`,
   as JSON. The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export is
   written. Poll it with a short backoff; never hold a request open, and never exit
   before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus batched operations and `__type` introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (6 tools) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (v0 + v2 advertisements), `git-upload-pack` (v2 `ls-refs`/`fetch`, v0 fetch), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call arrives with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(`/healthz` takes none); a missing or wrong token is refused with 401.

## How it works (app.ts)

- **Git core.** SHA-1 object hashing, pkt-line framing, packfile read/write
  (v2/v3, OFS_DELTA and REF_DELTA resolution, trailer checksum, `inflateSync`
  with `engine.bytesWritten` to find each stream's end), tree/commit/tag
  build/parse, reachability walks, three-way tree merge with conflict detection.
- **Smart HTTP.** v2 advertisements and `ls-refs` (peel, symrefs, unborn,
  ref-prefix), `fetch` with `want`/`have`/`shallow`/`deepen` (depth-limited
  object selection, shallow/unshallow reporting, sideband pack delivery), and
  `receive-pack` with fast-forward validation (`ng … non-fast-forward`) and a
  sideband report-status stream. The acknowledgments section is sent only when
  the client sent `have` lines — real git rejects it on a fresh fetch.
- **REST v3.** Repositories (create/get/patch/delete, pagination with `Link`
  headers), branches, refs, commits, contents (create/update/delete with sha
  checks, branch auto-creation), labels, issues, comments, pull requests
  (files diff, squash merge).
- **GraphQL.** A small recursive-descent parser for the subset the clients send
  (operations, variables, aliases, inline fragments, fragment spreads) plus an
  executor over the same store, with stable opaque global ids.
- **MCP.** JSON-RPC 2.0 over Streamable HTTP: `server/discover` (2026-07-28),
  `initialize`, `tools/list` (byte-identical every call), `tools/call` for the
  six canonical tools, acting on the same store as REST.
- **Determinism.** No wall clock or randomness reaches any response: creation
  order and commit timestamps come from one monotonic counter, so two runs on
  the same instance leave the same state export byte-for-byte.

## Local verification

Against the kit's sealed suite (`makefun grade-local --driver process`):

- **120/120 conformance** (git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  graphql 20/20, mcp 15/15, protocol 5/5), **200/200 agent**, perf 109–127/200
  (perf varies run to run with host throttling; push/read/write run 2–3.5×
  faster than the house reference, clone at the reference on a good run).
- A real `git` client clones, pushes, shallow-clones and gets non-fast-forward
  rejections from it (verified in a smoke test alongside the suite).

## Layout

- `main.ts`: the lifecycle above. Kept as the starter shipped it.
- `app.ts`: the whole forge. This is the file that grew.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest
page: **https://make.fun/bounty/github-core-clone-01** (its Rules section).
Deadline: Sat 2026-11-21 13:30 WIB. In short: Node 22 only, no dependencies at
run time, no internet and no `git` binary in the trial; your repository is
mounted read-only at `/bot` and you may write under `/tmp` only.

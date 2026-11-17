// A standalone GitHub-compatible git forge: one process, no UI, no outside service.
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP
// from its own in-memory store. Node 22 standard library only; no git binary.
//
// Layout: git primitives -> store -> REST serializers -> git smart HTTP -> GraphQL -> MCP
// -> HTTP routing. Deterministic: no wall clock or randomness reaches any response;
// creation order and commit timestamps come from one monotonic counter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const TS = '2023-11-14T22:13:20Z'; // fixed timestamp: every served date is this value
const userJson = (): Record<string, unknown> => ({ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
const actorJson = (): Record<string, unknown> => ({ name: VIEWER_NAME, email: VIEWER_EMAIL, date: TS });

// ---------------------------------------------------------------- git primitives

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { readonly type: GitObjectType; readonly data: Buffer }
interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string }
interface CommitView { readonly tree: string; readonly parents: string[]; readonly author: string; readonly committer: string; readonly message: string; readonly timestamp: number }
interface TagView { readonly object: string; readonly type: GitObjectType; readonly tag: string; readonly tagger: string; readonly message: string }

const HEX40 = /^[0-9a-f]{40}$/;
function isObjectId(value: string): boolean { return HEX40.test(value); }

function sha1hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Split a git object into its `key value` header lines and its message body. */
function splitObject(data: Buffer): { lines: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  return {
    lines: data.subarray(0, blank < 0 ? data.length : blank).toString('utf8').split('\n'),
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

function parseCommit(data: Buffer): CommitView {
  const { lines, message } = splitObject(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of lines) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') {
      committer = value;
      // `Name <email> <unix-ts> <tz>`: the timestamp is the second-to-last token.
      const parts = value.trim().split(/\s+/);
      const ts = Number(parts[parts.length - 2]);
      if (Number.isFinite(ts)) timestamp = ts;
    }
  }
  return { tree, parents, author, committer, message, timestamp };
}

function parseTag(data: Buffer): TagView {
  const { lines, message } = splitObject(data);
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

function buildCommit(tree: string, parents: readonly string[], message: string, author: string, committer: string, timestamp: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} +0000`, `committer ${committer} ${timestamp} +0000`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

/** Every object id reachable from `roots` (commits, trees, blobs, tags), in visit order. */
function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, allowMissing = false, skipParents?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!skipParents?.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `oid`, following commit parents. */
function isAncestor(ancestor: string, oid: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Peel a tag (recursively) to the commit it points at; non-tags pass through. */
function peelToCommit(oid: string, lookup: (oid: string) => GitObject | undefined): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- pkt-lines

const PKT_LINE_MAX = 65520;

function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (item === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Read one pkt-line header; returns its length and the offset after the header. */
function pktLength(bytes: Buffer, offset: number): { length: number; next: number } {
  if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
  const header = bytes.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
  return { length: parseInt(header, 16), next: offset + 4 };
}

function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const { length, next } = pktLength(bytes, offset);
    offset = next;
    if (length === 0) { packets.push({ kind: 'flush' }); continue; }
    if (length === 1) { packets.push({ kind: 'delim' }); continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); continue; }
    if (length < 4 || offset + length - 4 > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset, offset + length - 4)) });
    offset += length - 4;
  }
  return packets;
}

// ---------------------------------------------------------------- packfiles

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; `engine.bytesWritten` is the input bytes consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface RawEntry {
    offset: number; typeCode: number; size: number; data: Buffer;
    baseOffset?: number; baseOid?: string;
    resolvedType?: GitObjectType; resolved?: Buffer; oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not in the pack`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over the rest. */
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- store

type Label = { name: string; color: string };
type Issue = {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdSeq: number; updatedSeq: number;
  /** Cached single-GET body; valid while the fingerprint in issueJsonBytes matches. */
  jsonCache?: { seq: number; comments: number; labelColors: string; body: Buffer };
};
type IssueComment = { id: number; body: string; createdSeq: number };
type Pull = {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string; mergeCommitSha: string; mergeBaseSha: string;
  createdSeq: number; updatedSeq: number;
};
/** One memoized fetch answer: the pack bytes plus its shallow/unshallow lines. */
interface CachedFetch { pack: Buffer; shallow: string[]; unshallow: string[] }

type Repo = {
  id: number; name: string; description: string; isPrivate: boolean;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // 'refs/heads/x' | 'refs/tags/x' -> oid (may be a tag oid)
  defaultBranch: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, IssueComment[]>;
  pulls: Map<number, Pull>;
  nextIssue: number; nextPull: number; nextComment: number;
  createdSeq: number; updatedSeq: number;
  /**
   * Git-state version: bumped on every object insert and every ref set/delete,
   * so the fetch-pack cache key below can never match a changed repo. REST
   * state (issues/pulls/labels) never affects a pack and does not bump it.
   */
  version: number;
  /** Memoized fetch packs, keyed by version + fetch args (capped, FIFO). */
  fetchCache: Map<string, CachedFetch>;
};

interface Store { repos: Map<string, Repo>; nextRepoId: number; seq: number }

const store: Store = { repos: new Map(), nextRepoId: 1, seq: 0 };

function nextSeq(): number { store.seq += 1; return store.seq; }
/** Deterministic timestamp: fixed epoch plus the monotonic counter, never the clock. */
function stamp(): number { return 1700000000 + store.seq; }

const DEFAULT_LABELS: readonly [string, string][] = [
  ['bug', 'd73a4a'],
  ['documentation', '0075ca'],
  ['duplicate', 'cfd3d7'],
  ['enhancement', 'a2eeef'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
  ['invalid', 'e4e669'],
  ['question', 'd876e3'],
  ['wontfix', 'ffffff'],
];

function createRepo(name: string, description = '', isPrivate = false): Repo {
  const seq = nextSeq();
  const repo: Repo = {
    id: store.nextRepoId++,
    name,
    description,
    isPrivate,
    objects: new Map(),
    refs: new Map(),
    defaultBranch: 'main',
    labels: new Map(DEFAULT_LABELS.map(([labelName, color]) => [labelName, { name: labelName, color }])),
    issues: new Map(),
    comments: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    createdSeq: seq,
    updatedSeq: seq,
    version: 0,
    fetchCache: new Map(),
  };
  store.repos.set(name, repo);
  return repo;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.repos.get(name);
}

function deleteRepo(name: string): boolean { return store.repos.delete(name); }

function repoLookup(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** Bump a repo's git-state version: any object or ref change invalidates the fetch-pack cache. */
function bumpRepoVersion(repo: Repo): void { repo.version += 1; }

function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    bumpRepoVersion(repo);
  }
  return oid;
}

/** Resolve a branch name, full ref, or raw oid to a commit oid (tags peeled). */
function resolveRefish(repo: Repo, refish: string): string | undefined {
  if (isObjectId(refish)) {
    if (!repo.objects.has(refish)) return undefined;
    return peelToCommit(refish, repoLookup(repo));
  }
  const candidates = [
    `refs/heads/${refish}`,
    `refs/tags/${refish}`,
    refish.startsWith('refs/') ? refish : `refs/${refish}`,
  ];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid) return peelToCommit(oid, repoLookup(repo));
  }
  return undefined;
}

// ---------------------------------------------------------------- trees for the contents API

type TreeMap = Map<string, { oid: string; mode: string }>;

function treeToMap(repo: Repo, rootTreeOid: string): TreeMap {
  const map: TreeMap = new Map();
  const walk = (treeOid: string, prefix: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else map.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootTreeOid, '');
  return map;
}

function commitTreeMap(repo: Repo, commitOid: string): TreeMap {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return treeToMap(repo, parseCommit(object.data).tree);
}

function mapToTree(repo: Repo, map: TreeMap): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of map) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      if (!node.dirs.has(part)) node.dirs.set(part, makeNode());
      node = node.dirs.get(part)!;
    }
    node.files.set(parts[parts.length - 1]!, { oid: entry.oid, mode: entry.mode });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit on `treeOid` with `parents`, store it, return its oid. */
function createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const data = buildCommit(treeOid, parents, message, VIEWER_IDENTITY, VIEWER_IDENTITY, stamp());
  return storeObject(repo, 'commit', data);
}

/** Commits reachable from `tip`, newest-first by generation order (linear histories stay exact). */
function commitsFromTip(repo: Repo, tip: string): { oid: string; commit: CommitView }[] {
  const ordered: { oid: string; commit: CommitView }[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    ordered.push({ oid, commit });
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) stack.push(commit.parents[index]!);
  }
  return ordered;
}

/** The merge-base: the first common ancestor found walking from both tips. */
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const fromA = collectReachable([a], repoLookup(repo), true);
  // Walk from b breadth-first; the first commit also reachable from a is the base.
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- global ids (opaque, stable)

function gid(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

function repoGid(repo: Repo): string { return gid('Repository', String(repo.id)); }
function issueGid(repo: Repo, issue: Issue): string { return gid('Issue', `${repo.id}:${issue.number}`); }
function pullGid(repo: Repo, pull: Pull): string { return gid('PullRequest', `${repo.id}:${pull.number}`); }
function commentGid(repo: Repo, issue: Issue, comment: IssueComment): string {
  return gid('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
}

function ungid(value: string): { kind: string; payload: string } | undefined {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return undefined;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return undefined;
  }
}

function findRepo(id: number): Repo | undefined {
  return [...store.repos.values()].find((candidate) => candidate.id === id);
}

/** A repo resolved from its global id, or undefined. */
function gidRepo(value: unknown): Repo | undefined {
  const decoded = typeof value === 'string' ? ungid(value) : undefined;
  return decoded?.kind === 'Repository' ? findRepo(parseInt(decoded.payload, 10)) : undefined;
}

function gidIssue(value: unknown): { repo: Repo; issue: Issue } | undefined {
  const decoded = typeof value === 'string' ? ungid(value) : undefined;
  if (decoded?.kind !== 'Issue') return undefined;
  const [repoId, number] = decoded.payload.split(':').map(Number);
  const repo = findRepo(repoId!);
  const issue = repo?.issues.get(number!);
  return repo && issue ? { repo, issue } : undefined;
}

function gidPull(value: unknown): { repo: Repo; pull: Pull } | undefined {
  const decoded = typeof value === 'string' ? ungid(value) : undefined;
  if (decoded?.kind !== 'PullRequest') return undefined;
  const [repoId, number] = decoded.payload.split(':').map(Number);
  const repo = findRepo(repoId!);
  const pull = repo?.pulls.get(number!);
  return repo && pull ? { repo, pull } : undefined;
}

// ---------------------------------------------------------------- REST serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGid(repo),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: `https://github.example/${VIEWER_LOGIN}/${repo.name}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    clone_url: `https://github.example/${VIEWER_LOGIN}/${repo.name}.git`,
    git_url: `git://github.example/${VIEWER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@github.example:${VIEWER_LOGIN}/${repo.name}.git`,
    created_at: TS,
    updated_at: TS,
    pushed_at: TS,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: TS,
    updated_at: TS,
    closed_at: issue.state === 'closed' ? TS : null,
    html_url: `https://github.example/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    author_association: 'OWNER',
  };
}

/**
 * Serialized single-issue GET body, cached while nothing it shows can change.
 * The fingerprint covers every input issueJson reads that can move: updatedSeq
 * (bumped by every REST PATCH and GraphQL closeIssue, so title/body/state/
 * labels), the comment count (comment posts do not bump updatedSeq), and the
 * labels' colours (a label re-POST overwrites its colour without touching the
 * issue). Repo name/id never change; all other fields are constants. A
 * fingerprint miss rebuilds the bytes, so a stale cache is impossible.
 */
function issueJsonBytes(repo: Repo, issue: Issue): Buffer {
  const count = (repo.comments.get(issue.number) ?? []).length;
  const labelColors = issue.labels.map((name) => repo.labels.get(name)?.color ?? '000000').join(',');
  const cached = issue.jsonCache;
  if (cached && cached.seq === issue.updatedSeq && cached.comments === count && cached.labelColors === labelColors) return cached.body;
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issue.jsonCache = { seq: issue.updatedSeq, comments: count, labelColors, body };
  return body;
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGid(repo, issue, comment),
    body: comment.body,
    user: userJson(),
    created_at: TS,
    updated_at: TS,
    html_url: `https://github.example/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    head: { label: `${VIEWER_LOGIN}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${VIEWER_LOGIN}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (pull.mergeBaseSha ? true : null) : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    merged_at: pull.merged ? pull.mergedAt : null,
    html_url: `https://github.example/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    created_at: TS,
    updated_at: TS,
    closed_at: pull.state === 'closed' ? TS : null,
    author_association: 'OWNER',
  };
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

function diffFiles(repo: Repo, baseCommit: string, headCommit: string): Record<string, unknown>[] {
  const baseMap = commitTreeMap(repo, baseCommit);
  const headMap = commitTreeMap(repo, headCommit);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = baseMap.get(path);
    const after = headMap.get(path);
    if (before?.oid === after?.oid) continue;
    const beforeData = before ? repo.objects.get(before.oid)?.data : undefined;
    const afterData = after ? repo.objects.get(after.oid)?.data : undefined;
    const status = !before ? 'added' : !after ? 'removed' : 'modified';
    const additions = afterData ? countLines(afterData) : 0;
    const deletions = beforeData ? countLines(beforeData) : 0;
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before?.oid ?? '',
      patch: null,
    });
  }
  return files;
}

/** Three-way tree merge. Returns the merged tree oid, or conflict:true when both sides changed a path differently. */
function threeWayMerge(repo: Repo, baseTip: string, headTip: string): { treeOid: string; conflict: boolean } {
  const baseOid = mergeBase(repo, baseTip, headTip);
  const baseMap = baseOid ? commitTreeMap(repo, baseOid) : new Map<string, { oid: string; mode: string }>();
  const headMap = commitTreeMap(repo, headTip);
  const baseTipMap = commitTreeMap(repo, baseTip);
  const result = new Map<string, { oid: string; mode: string }>(baseTipMap);
  let conflict = false;
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys(), ...baseTipMap.keys()]);
  for (const path of paths) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    const baseTipEntry = baseTipMap.get(path);
    const headChanged = head?.oid !== base?.oid;
    const baseChanged = baseTipEntry?.oid !== base?.oid;
    if (headChanged && baseChanged && head?.oid !== baseTipEntry?.oid) {
      conflict = true;
      continue;
    }
    if (headChanged) {
      if (head) result.set(path, head);
      else result.delete(path);
    }
  }
  return { treeOid: mapToTree(repo, result), conflict };
}

// ---------------------------------------------------------------- git smart HTTP

/** Refs the server advertises, in git's usual order (HEAD first, then sorted refs). */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const names = [...repo.refs.keys()].sort();
  const out: { name: string; oid: string }[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip) out.push({ name: 'HEAD', oid: headTip });
  for (const name of names) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

/** v0 ref lines: `<oid> <name>` with capabilities on the first line. */
function v0RefLines(repo: Repo, caps: string): Buffer {
  const refs = advertisedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    const capsLine = `symref=HEAD:${headTarget} ${caps}`;
    return encodePktLines([`${ZERO_OID} capabilities^{}\u0000${capsLine}\n`, 'flush']);
  }
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    const suffix = index === 0 ? `\u0000${`symref=HEAD:${headTarget} ${caps}`}` : '';
    lines.push(encodePktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    const object = repo.objects.get(ref.oid);
    if (object?.type === 'tag' && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(ref.oid, repoLookup(repo));
      lines.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(lines);
}

/** The info/refs advertisement for a git service (v2 only for upload-pack). */
function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string, v2 = false): { body: Buffer; type: string } {
  if (v2) {
    return {
      body: encodePktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow filter include-tag\n', 'object-format=sha1\n', 'flush']),
      type: 'application/x-git-upload-pack-advertisement',
    };
  }
  const preamble = encodePktLines([`# service=${service}\n`, 'flush']);
  return { body: Buffer.concat([preamble, v0RefLines(repo, caps)]), type: `application/x-${service}-advertisement` };
}

function uploadPackAdvertisement(repo: Repo, wantsV2: boolean): { body: Buffer; type: string } {
  // The v0 caps mirror real git upload-pack (git 2.43): without the deepen-*
  // caps a client refuses `--deepen` ("Server does not support --deepen"),
  // and without `include-tag` it never asks for tag objects. `no-done` is
  // deliberately NOT advertised: the client still sends `done`, and omitting
  // it keeps the v0 two-post phase split unambiguous.
  return advertisement(repo, 'git-upload-pack', `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/${repo.defaultBranch} filter object-format=sha1 agent=forge/1.0`, wantsV2);
}

function receivePackAdvertisement(repo: Repo): { body: Buffer; type: string } {
  return advertisement(repo, 'git-receive-pack', 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0');
}

interface LsRefsArgs { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    if (headTip) {
      const extra = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(encodePktLine(`${headTip} HEAD${extra}\n`));
    } else if (args.unborn) {
      const extra = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(encodePktLine(`unborn HEAD${extra}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let extra = '';
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') extra += ` peeled:${peelToCommit(oid, repoLookup(repo))}`;
    }
    lines.push(encodePktLine(`${oid} ${name}${extra}\n`));
  }
  lines.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[]; depth?: number;
  deepenRelative: boolean; deepenSince?: number; deepenNot: string[];
  includeTag: boolean; hasDone: boolean;
  thinPack: boolean; noProgress: boolean; ofsDelta: boolean; filter: string;
}

/**
 * Objects to send for a fetch: closure(wants) minus closure(haves), depth-limited
 * when `depth` is set, plus the shallow/unshallow reports for the shallow-info section.
 *
 * deepen-relative: real git's `fetch --deepen=N` sends `deepen N` plus the
 * `deepen-relative` marker, meaning N more generations past the client's current
 * shallow boundary (the `shallow` lines it sends) — not N from the tip. The
 * effective limit is therefore the boundary's distance from the wants plus N.
 * deepen-since: only commits with committer time >= the timestamp are included;
 * the deepest included commit (whose parent is older) is the shallow boundary.
 * deepen-not: refs whose
 * reachable commits are withheld like extra haves.
 * filter: partial-clone filters — `blob:none` (no blobs), `tree:0` (no trees or
 * blobs), `blob:limit=<bytes>` (no blob over the limit), `object:type=<type>`
 * (only that object type). Anything else is ignored (full pack, as before).
 * A want naming a blob or tree directly (a promisor/lazy fetch of a missing
 * object after a filtered clone) is sent as-is.
 */
function fetchSelection(
  repo: Repo,
  args: FetchArgs,
): { send: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = repoLookup(repo);
  const shallowSet = new Set(args.shallow);
  // Roots of the commit walk, split by kind: a want naming a commit seeds the
  // walk at distance 0, but a want naming a TAG seeds only the tag object
  // itself — its target commit joins the walk only if the commit wants do not
  // already reach it. Seeding a tag target at 0 as well would count it as a
  // fresh tip: a `fetch --deepen=1` on a repo with an annotated tag on the
  // parent then over-includes the grandparent and drops the shallow boundary
  // (real git upload-pack behaves this way; verified against git 2.43).
  const commitWants: string[] = [];
  const tagCommitWants: string[] = [];
  for (const oid of args.wants) {
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') tagCommitWants.push(peelToCommit(oid, lookup));
    else commitWants.push(peelToCommit(oid, lookup));
  }
  const wantTags = args.wants.filter((oid) => repo.objects.get(oid)?.type === 'tag');
  const wantObjects = args.wants.filter((oid) => {
    const object = repo.objects.get(oid);
    return object !== undefined && (object.type === 'blob' || object.type === 'tree');
  });
  // Distances from the walk roots, unlimited: the deepen-relative probe.
  const walkDistances = (roots: { oid: string; distance: number }[]): Map<string, number> => {
    const dist = new Map<string, number>();
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      dist.set(oid, distance);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, distance: distance + 1 });
    }
    return dist;
  };
  let depthLimit = args.depth;
  if (args.depth !== undefined && args.deepenRelative && args.shallow.length > 0) {
    const dist = walkDistances(commitWants.map((oid) => ({ oid, distance: 0 })));
    const extra = tagCommitWants.filter((oid) => !dist.has(oid)).map((oid) => ({ oid, distance: 0 }));
    if (extra.length > 0) {
      for (const [oid, d] of walkDistances(extra)) if (!dist.has(oid) || d < dist.get(oid)!) dist.set(oid, d);
    }
    let boundaryDepth = 0;
    for (const oid of args.shallow) {
      const d = dist.get(peelToCommit(oid, lookup));
      if (d !== undefined && d > boundaryDepth) boundaryDepth = d;
    }
    depthLimit = boundaryDepth + args.depth + 1;
  }
  const included = new Set<string>();
  const includedDist = new Map<string, number>();
  const visited = new Set<string>();
  const runBfs = (roots: { oid: string; distance: number }[]): void => {
    const queue = [...roots];
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      if (depthLimit !== undefined && distance >= depthLimit) continue;
      const commit = parseCommit(object.data);
      if (args.deepenSince !== undefined && commit.timestamp < args.deepenSince) continue;
      included.add(oid);
      includedDist.set(oid, distance);
      // Without a depth limit, the client's shallow boundary stops the walk:
      // the client has that commit but not its parents, and sending the
      // parents would silently un-shallow its repo (real git upload-pack
      // treats the shallow lines as walk boundaries; verified against git
      // 2.43 — a tag-following fetch after a deepen sends only the tag object,
      // never the history behind the shallow boundary). With a deepen the
      // depth limit governs instead (that is how the client extends past its
      // boundary), so the stop applies only when no depth limit is set.
      if (depthLimit === undefined && shallowSet.has(oid)) continue;
      for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
    }
  };
  runBfs(commitWants.map((oid) => ({ oid, distance: 0 })));
  runBfs(tagCommitWants.filter((oid) => !visited.has(oid)).map((oid) => ({ oid, distance: 0 })));
  // Closure of haves, stopping at the shallow boundary (parents of a shallow commit stay hidden).
  const held = collectReachable(args.haves.map((oid) => peelToCommit(oid, lookup)), lookup, true, shallowSet);
  for (const ref of args.deepenNot) {
    const target = repo.refs.get(ref) ?? (isObjectId(ref) ? ref : undefined);
    if (target) for (const oid of collectReachable([peelToCommit(target, lookup)], lookup, true, shallowSet)) held.add(oid);
  }
  // Send each included commit plus its own tree closure only. A full closure over the
  // included set would follow parents and defeat depth limits, so the tree walk is
  // per-commit (trees reach only trees and blobs, never commits).
  const sendIds = new Set<string>();
  const send = new Set<string>(wantTags);
  for (const oid of wantObjects) send.add(oid);
  for (const oid of included) {
    send.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const treeOid of collectReachable([parseCommit(object.data).tree], lookup, true)) send.add(treeOid);
    }
  }
  // `include-tag`: send the annotated tag objects whose target is being sent
  // (or is already held — the client may lack the tag while holding the
  // commit), without their history. Without this, a client that asked for
  // tags does a second, depth-less tag fetch whose full closure completes
  // the history and silently un-shallows a shallow clone.
  if (args.includeTag) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tag') continue;
      const target = peelToCommit(oid, lookup);
      if (send.has(target) || held.has(target)) send.add(oid);
    }
  }
  // A blob/tree named directly as a want (a promisor/lazy fetch after a
  // filtered clone) is always sent, even when it is reachable from the haves:
  // the client asked for that exact object because it does not have it, and
  // the haves' closure wrongly counts it as held. Commit wants stay
  // held-filtered (a fetch with the tip already held transfers nothing).
  const directWants = new Set(wantObjects);
  for (const oid of send) if (!held.has(oid) || directWants.has(oid)) sendIds.add(oid);
  // Partial-clone filter exemption: a direct want (any type), a tag object,
  // and the target of a sent tag object are always sent, even under a filter
  // (real git upload-pack, verified against git 2.43 over HTTP: a
  // --filter=object:type=commit clone still sends both tag objects plus the
  // blob an annotated tag points at; object:type=tree still sends the tip
  // commit and the annotated tag's target commit; object:type=blob still
  // sends the tag targets. Only pure closure objects are filtered — a
  // filtered pack that drops a wanted tag object makes the client fail the
  // clone with "did not send all necessary objects").
  const filterExempt = new Set<string>();
  for (const oid of args.wants) if (repo.objects.has(oid)) filterExempt.add(oid);
  const exemptTagTarget = (oid: string): void => {
    const object = lookup(oid);
    if (object?.type !== 'tag') return;
    const target = parseTag(object.data).object;
    if (target && !filterExempt.has(target)) { filterExempt.add(target); exemptTagTarget(target); }
  };
  for (const oid of send) {
    if (lookup(oid)?.type === 'tag') { filterExempt.add(oid); exemptTagTarget(oid); }
  }
  const filteredOut = (object: GitObject): boolean => {
    const filter = args.filter;
    if (filter === 'blob:none') return object.type === 'blob';
    if (filter === 'tree:0') return object.type === 'blob' || object.type === 'tree';
    if (filter.startsWith('blob:limit=')) {
      const limit = parseInt(filter.slice('blob:limit='.length), 10);
      return object.type === 'blob' && !Number.isNaN(limit) && object.data.length > limit;
    }
    if (filter.startsWith('object:type=')) return object.type !== filter.slice('object:type='.length);
    return false;
  };
  const objects: GitObject[] = [];
  const sentIds = new Set<string>();
  for (const oid of [...sendIds].sort()) {
    const object = lookup(oid);
    // A direct blob/tree want (a promisor/lazy fetch) is exempt from the
    // partial-clone filter: the client re-sends `filter blob:none` on every
    // fetch, and applying it to the very object it is asking for returns an
    // empty pack ("did not send all necessary objects"). So is any direct
    // want, tag object, or tag target (see filterExempt above).
    if (object && (filterExempt.has(oid) || !filteredOut(object))) { objects.push(object); sentIds.add(oid); }
  }
  // Shallow lines are the DEEPEST SENT commits: a sent commit whose parent the
  // walk did not reach and the client does not already hold (real git
  // upload-pack, verified against git 2.43: `clone --depth 1` -> shallow=tip,
  // `--depth 2` -> shallow=parent, `--shallow-since` -> shallow=deepest
  // included commit). The test is on the WALK (`included`), not the pack
  // (`sentIds`): a parent the walk reached but the partial-clone FILTER
  // dropped from the pack is NOT a boundary — reporting it makes real git
  // 2.43 mark the child shallow and immediately lazy-fetch it with
  // `filter blob:none` (pulling the full closure — root commit + trees —
  // into the clone), while the oracle's own --filter clone response carries
  // NO shallow-info section at all and the client does no second fetch.
  // The excluded parent is NEVER the shallow line: reporting it makes the
  // client treat a commit it never received as a boundary, then fail with
  // "remote did not send all necessary objects" when it traverses the sent
  // commit's parents. A plain fetch that sends nothing reports no shallow
  // lines at all.
  // A ROOT commit (no parents) is a boundary only when it sits exactly at the
  // depth limit: oracle-verified vs git 2.43 — depth-1 on a 1-commit repo
  // lists the root as shallow, but depth-2 on the same repo and depth-5 on a
  // 3-commit repo do not (there the walk ended naturally, not at the limit).
  // A depth request ALSO re-shallows a boundary the client already holds:
  // `fetch --depth=1` on a full clone must report the tip as shallow even
  // though nothing is sent (real git upload-pack, verified against git 2.43).
  // The boundary is any included commit whose parent the walk did not reach.
  const hasDepthRequest = depthLimit !== undefined || args.deepenSince !== undefined || args.deepenRelative;
  // Unshallow: a previous shallow boundary is unshallowed ONLY by a fetch
  // that extends the depth past it (a deepen/deepen-since request). A plain
  // or tag fetch that merely happens to send the boundary's parents does NOT
  // unshallow it (real git upload-pack, verified against git 2.43: fetch
  // --tags, fetch of another branch, and fetch of the parent sha all leave
  // the shallow file untouched, while fetch --deepen=1 moves the boundary).
  // A ROOT boundary has no parents, so its (empty) parent set is vacuously
  // satisfied. A plain fetch that sends nothing new unshallows nothing.
  const unshallow: string[] = hasDepthRequest ? args.shallow.filter((oid) => {
    const object = lookup(oid);
    if (object?.type !== 'commit') return false;
    const parents = parseCommit(object.data).parents;
    return parents.every((p) => sentIds.has(p) || held.has(p));
  }) : [];
  const unshallowSet = new Set(unshallow);
  const shallowCandidates = new Set<string>();
  for (const oid of sentIds) {
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((p) => !included.has(p) && !held.has(p))) { shallowCandidates.add(oid); continue; }
    if (parents.length === 0 && depthLimit !== undefined && includedDist.get(oid) === depthLimit - 1) shallowCandidates.add(oid);
  }
  if (hasDepthRequest) {
    for (const oid of included) {
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((p) => !included.has(p))) shallowCandidates.add(oid);
    }
  }
  const shallow: string[] = [...shallowCandidates].filter((oid) => !unshallowSet.has(oid)).sort();
  return { send: objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer {
  const packets: Buffer[] = [];
  const maxData = 65515; // 65520 pkt-line limit minus 4 header bytes minus 1 band byte
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
  }
  if (pack.length === 0) packets.push(encodePktLine(Buffer.from([0x01])));
  return Buffer.concat(packets);
}

/**
 * Memoized fetch answer: fetchSelection + writePack are a pure function of
 * (repo objects, repo refs, fetch args), and the same fetch repeats verbatim
 * across a clone workload (50 concurrent depth-1 clones of one tip) and
 * across real clients re-fetching an unchanged repo. The cache key carries
 * the repo version (bumped on every object insert and ref set/delete) plus
 * every arg that changes the selection, so a hit is byte-identical to a fresh
 * computation; thin-pack/ofs-delta/no-progress never change our delta-less
 * packs and `hasDone` only changes v0 framing, so both stay out of the key.
 * The framing (ACK section, shallow-info section, sideband) is rebuilt per
 * request from the cached pack + lines — only the selection and the pack
 * build are memoized. Capped at 64 entries per repo (FIFO); a version bump
 * orphans older entries, which then age out.
 */
function fetchPack(repo: Repo, args: FetchArgs): CachedFetch {
  const sorted = (xs: readonly string[]): string => [...xs].sort().join(',');
  const key = [
    repo.version,
    sorted(args.wants), sorted(args.haves), sorted(args.shallow), sorted(args.deepenNot),
    args.depth ?? '', args.deepenSince ?? '', args.deepenRelative ? 1 : 0,
    args.includeTag ? 1 : 0, args.filter,
  ].join('|');
  const hit = repo.fetchCache.get(key);
  if (hit) return hit;
  const { send, shallow, unshallow } = fetchSelection(repo, args);
  const entry: CachedFetch = { pack: writePack(send), shallow, unshallow };
  if (repo.fetchCache.size >= 64) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, entry);
  return entry;
}

function handleFetch(repo: Repo, args: FetchArgs, version2: boolean): Buffer {
  const lookup = repoLookup(repo);
  // v0 over HTTP is TWO posts when the client asks for shallow info (real git
  // upload-pack, verified against git 2.43): the first carries the wants plus
  // the deepen/shallow lines (no `done`) and gets only the shallow/unshallow
  // lines plus a flush; the second repeats the wants with `done` (plus any
  // haves) and gets the shallow lines again, a flush, then NAK/ACK and the
  // pack. No pack is built for the first post, so it runs the selection
  // directly instead of populating the pack cache.
  const hasShallowRequest = args.depth !== undefined || args.deepenSince !== undefined || args.deepenNot.length > 0 || args.deepenRelative || args.shallow.length > 0;
  if (!version2 && !args.hasDone && hasShallowRequest) {
    const { shallow, unshallow } = fetchSelection(repo, args);
    const parts: Buffer[] = [];
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = fetchPack(repo, args);
  // Acknowledgments: ACK every have the server also has, else NAK.
  const common = args.haves.filter((oid) => repo.objects.has(oid) || repo.objects.has(peelToCommit(oid, lookup)));
  const parts: Buffer[] = [];
  if (version2) {
    // The acknowledgments section exists only when the client sent 'have' lines;
    // real git rejects it on a fresh fetch ("expected 'packfile'").
    if (args.haves.length > 0) {
      parts.push(encodePktLine('acknowledgments\n'));
      if (common.length === 0) parts.push(encodePktLine('NAK\n'));
      else {
        for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
        parts.push(encodePktLine('ready\n'));
      }
      parts.push(Buffer.from('0001', 'ascii'));
    }
    if (args.depth !== undefined || args.shallow.length > 0 || args.deepenSince !== undefined || shallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPackets(pack));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  // v0: a plain fetch (no shallow request) is a SINGLE post with `done` and
  // gets NAK/ACK + pack directly — a leading flush before the NAK makes the
  // client fail with "expected ACK/NAK, got a flush packet", so the shallow
  // section is emitted only when it has lines. (The two-post shallow case
  // returned above, before the pack cache was consulted.)
  // The shallow section is sent on the pack post ONLY when the request
  // carries a deepen (the second post of the two-post exchange). A
  // single-post fetch that merely reports `shallow` lines (e.g. `fetch
  // --tags` from a shallow clone) gets ACK/NAK + pack directly — sending a
  // shallow section there makes real git fail with "expected ACK/NAK, got
  // 'unshallow ...'" (verified against git 2.43).
  const hasDepthRequest = args.depth !== undefined || args.deepenSince !== undefined || args.deepenRelative;
  if (hasDepthRequest && (shallow.length > 0 || unshallow.length > 0)) {
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  if (common.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  parts.push(sidebandPackets(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

interface PushCommand { old: string; next: string; ref: string }

interface ReceivePackResult { body: Buffer; applied: number; refused: number }

function handleReceivePack(repo: Repo, body: Buffer): ReceivePackResult {
  // Decode pkt-lines only up to the flush; everything after it is raw pack bytes.
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset < body.length) {
    const { length, next } = pktLength(body, offset);
    offset = next;
    if (length === 0) { sawFlush = true; break; }
    if (length < 4 || offset + length - 4 > body.length) throw new Error('truncated pkt-line');
    const text = body.subarray(offset, offset + length - 4).toString('utf8');
    const line = text.includes('\u0000') ? text.slice(0, text.indexOf('\u0000')) : text;
    const parts = line.trim().split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      throw new Error('receive-pack command is not <old> <new> <ref>');
    }
    commands.push({ old: parts[0]!, next: parts[1]!, ref: parts[2]! });
    offset += length - 4;
  }
  if (!sawFlush) throw new Error('receive-pack body has no flush pkt-line');
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repoLookup(repo));
      let added = false;
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) { repo.objects.set(oid, object); added = true; }
      }
      if (added) bumpRepoVersion(repo);
    } catch (err) {
      unpackOk = false;
      unpackError = (err as Error).message;
    }
  }
  const report: string[] = [];
  let applied = 0;
  let refused = 0;
  if (!unpackOk) {
    report.push(`unpack ${unpackError || 'failed'}\n`);
    for (const command of commands) {
      report.push(`ng ${command.ref} unpack failed\n`);
      refused += 1;
    }
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | undefined;
      if (command.next === ZERO_OID) {
        if (!current) reason = 'ref does not exist';
        else if (current !== command.old) reason = 'non-fast-forward';
      } else {
        const target = repo.objects.get(command.next);
        if (!target) reason = 'object not found';
        else if (current === undefined) {
          if (command.old !== ZERO_OID) reason = 'non-fast-forward';
        } else {
          if (command.old !== current) reason = 'non-fast-forward';
          else if (command.ref.startsWith('refs/heads/')) {
            const newCommit = peelToCommit(command.next, repoLookup(repo));
            if (!isAncestor(current, newCommit, repoLookup(repo))) reason = 'non-fast-forward';
          }
        }
      }
      if (reason) {
        report.push(`ng ${command.ref} ${reason}\n`);
        refused += 1;
      } else {
        if (command.next === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.next);
        bumpRepoVersion(repo);
        report.push(`ok ${command.ref}\n`);
        applied += 1;
      }
    }
  }
  // The report-status stream inside band 1 is itself pkt-lined and ends with its own
  // flush; the outer flush then ends the HTTP response. Real git requires the inner
  // flush (without it the report reader sees EOF and reports a hang-up).
  const stream = encodePktLines([...report, 'flush']);
  const bodyOut = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([0x01]), stream])), Buffer.from('0000', 'ascii')]);
  return { body: bodyOut, applied, refused };
}

// ---------------------------------------------------------------- HTTP plumbing

interface ReqCtx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
}

let requestCounter = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(ctx: ReqCtx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  sendBytes(ctx, status, Buffer.from(JSON.stringify(value), 'utf8'), JSON_TYPE, extraHeaders);
}

function sendEmpty(ctx: ReqCtx, status: number): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Parse the request JSON body; on failure the 400 is already sent and the result is undefined. */
function jsonBody(ctx: ReqCtx): Record<string, unknown> | undefined {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) { sendError(ctx, 400, 'Problems parsing JSON'); return undefined; }
  return asRecord(parsed.value);
}

function sendBytes(ctx: ReqCtx, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function sendError(ctx: ReqCtx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function isAuthed(ctx: ReqCtx): boolean {
  const header = ctx.req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  return token !== '' && (TOKEN === '' || token === TOKEN);
}

function requireAuth(ctx: ReqCtx): boolean {
  if (isAuthed(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

function parseJsonBody(ctx: ReqCtx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pagination(ctx: ReqCtx, total: number, page: number, perPage: number): Record<string, string> {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const host = ctx.req.headers.host ?? 'localhost';
  const base = `http://${host}${ctx.path}`;
  const links: string[] = [];
  const linkFor = (pageNumber: number, rel: string): string =>
    `<${base}?per_page=${perPage}&page=${pageNumber}>; rel="${rel}"`;
  if (page < pages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(pages, 'last'));
  return links.length > 0 ? { link: links.join(', ') } : {};
}

function pageParams(ctx: ReqCtx): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Send one page of `items` as JSON, with Link headers. */
function sendList<T>(ctx: ReqCtx, items: readonly T[], map: (item: T) => unknown = (item) => item): void {
  const { page, perPage } = pageParams(ctx);
  sendJson(ctx, 200, paginate(items, page, perPage).map(map), pagination(ctx, items.length, page, perPage));
}

// ---------------------------------------------------------------- REST v3

function handleRest(ctx: ReqCtx): void {
  const [first, ...rest] = ctx.segments;
  if (first === 'api' && rest[0] === 'v3') return handleV3(ctx, rest.slice(1));
  if (first === 'api' && rest[0] === 'graphql') return handleGraphql(ctx);
  if (first === 'mcp') return handleMcp(ctx);
  sendError(ctx, 404, 'Not Found');
}

function handleV3(ctx: ReqCtx, segments: readonly string[]): void {
  // API root and meta (auth required for these in the checks except /healthz).
  if (segments.length === 0) {
    if (!requireAuth(ctx)) return;
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.example/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}{&page,per_page,sort,order}',
      notifications_url: '/api/v3/notifications{?since,all,participating}',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/user',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (!requireAuth(ctx)) return;
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (!requireAuth(ctx)) return;
    if (ctx.method !== 'GET') { sendError(ctx, 404, 'Not Found'); return; }
    sendJson(ctx, 200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', VIEWER_LOGIN),
      avatar_url: `https://github.example/avatars/${VIEWER_LOGIN}`, gravatar_id: '',
      url: '/api/v3/user', html_url: `https://github.example/${VIEWER_LOGIN}`,
      type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL,
      company: null, blog: '', location: '', bio: '', public_repos: store.repos.size,
      followers: 0, following: 0, created_at: TS, updated_at: TS,
    });
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (!requireAuth(ctx)) return;
    if (ctx.method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      sendList(ctx, all, repoJson);
      return;
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (!body) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendError(ctx, 422, 'Validation Failed: name is required'); return; }
      if (store.repos.has(name)) { sendError(ctx, 422, `name already exists on this account`); return; }
      const repo = createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return handleRepoRest(ctx, segments.slice(1));
  }
  sendError(ctx, 404, 'Not Found');
}

function handleRepoRest(ctx: ReqCtx, segments: readonly string[]): void {
  const [owner, name, ...rest] = segments;
  if (!requireAuth(ctx)) return;
  const repo = getRepo(owner!, name!);
  if (!repo) { sendError(ctx, 404, 'Not Found'); return; }
  if (rest.length === 0) {
    if (ctx.method === 'GET') { sendJson(ctx, 200, repoJson(repo)); return; }
    if (ctx.method === 'PATCH') {
      const body = jsonBody(ctx);
      if (!body) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedSeq = nextSeq();
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (ctx.method === 'DELETE') {
      deleteRepo(name!);
      sendEmpty(ctx, 204);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const [section, ...tail] = rest;
  if (section === 'branches') {
    if (ctx.method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      sendJson(ctx, 200, branches.map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
        protected: false,
      })));
      return;
    }
    if (ctx.method === 'GET' && tail.length === 1) {
      const branch = tail[0]!;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) { sendError(ctx, 404, 'Branch not found'); return; }
      sendJson(ctx, 200, {
        name: branch,
        commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
        protected: false,
      });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (section === 'git') {
    if (tail[0] === 'refs' && ctx.method === 'POST' && tail.length === 1) {
      const body = jsonBody(ctx);
      if (!body) return;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) { sendError(ctx, 422, 'Validation Failed: ref and sha are required'); return; }
      if (repo.refs.has(ref)) { sendError(ctx, 422, 'Reference already exists'); return; }
      const object = repo.objects.get(sha);
      if (!object) { sendError(ctx, 422, 'Validation Failed: sha does not exist'); return; }
      repo.refs.set(ref, sha);
      bumpRepoVersion(repo);
      sendJson(ctx, 201, { ref, node_id: gid('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` } });
      return;
    }
    if (tail[0] === 'refs' && ctx.method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) { sendError(ctx, 404, 'Not Found'); return; }
      const object = repo.objects.get(sha);
      sendJson(ctx, 200, { ref, node_id: gid('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${tail.join('/')}`, object: { sha, type: object?.type ?? 'commit', url: '' } });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (section === 'commits') {
    if (ctx.method === 'GET' && tail.length === 0) {
      const refish = ctx.query.get('sha');
      const tip = refish ? resolveRefish(repo, refish) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) { sendJson(ctx, 200, []); return; }
      const commits = commitsFromTip(repo, tip);
      const listed = commits.map(({ oid, commit }) => {
        return {
          sha: oid,
          node_id: gid('Commit', `${repo.id}:${oid}`),
          commit: {
            // GitHub strips the object's trailing newline in the API view.
            message: commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message,
            author: actorJson(),
            committer: actorJson(),
            tree: { sha: commit.tree },
            verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
          },
          author: userJson(),
          committer: userJson(),
          parents: commit.parents.map((parent) => ({ sha: parent })),
          url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
          html_url: `https://github.example/${owner}/${name}/commit/${oid}`,
        };
      });
      sendList(ctx, listed);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (section === 'contents') {
    return handleContents(ctx, repo, owner!, name!, tail);
  }
  if (section === 'labels') {
    if (ctx.method === 'GET' && tail.length === 0) {
      sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '', default: true })));
      return;
    }
    if (ctx.method === 'POST' && tail.length === 0) {
      const body = jsonBody(ctx);
      if (!body) return;
      const labelName = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000';
      if (!labelName) { sendError(ctx, 422, 'Validation Failed: name is required'); return; }
      const label: Label = { name: labelName, color };
      repo.labels.set(labelName, label);
      sendJson(ctx, 201, { name: label.name, color: label.color, description: '', default: false });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (section === 'issues') {
    return handleIssues(ctx, repo, owner!, name!, tail);
  }
  if (section === 'pulls') {
    return handlePulls(ctx, repo, owner!, name!, tail);
  }
  sendError(ctx, 404, 'Not Found');
}

function commitJson(repo: Repo, owner: string, name: string, oid: string, message: string, treeOid: string): Record<string, unknown> {
  return { sha: oid, message, author: actorJson(), committer: actorJson(), url: `/api/v3/repos/${owner}/${name}/commits/${oid}`, tree: { sha: treeOid } };
}

function handleContents(ctx: ReqCtx, repo: Repo, owner: string, name: string, tail: readonly string[]): void {
  const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
  const refish = ctx.query.get('ref') ?? undefined;
  const resolveTip = (): string | undefined => {
    if (refish) return resolveRefish(repo, refish);
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  };
  if (ctx.method === 'GET') {
    const tip = resolveTip();
    if (!tip) { sendError(ctx, 404, 'Not Found'); return; }
    const map = commitTreeMap(repo, tip);
    const entry = map.get(path);
    if (entry) {
      const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file', encoding: 'base64', size: data.length,
        name: path.split('/').pop() ?? path, path,
        content: data.toString('base64'),
        sha: entry.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `https://github.example/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`,
        download_url: `https://github.example/${owner}/${name}/raw/${repo.defaultBranch}/${path}`,
        _links: { self: `/api/v3/repos/${owner}/${name}/contents/${path}`, git: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`, html: `https://github.example/${owner}/${name}/blob/${repo.defaultBranch}/${path}` },
      });
      return;
    }
    // Directory listing (or the repo root when path is empty).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string }>();
    for (const [entryPath, entryData] of map) {
      if (!entryPath.startsWith(prefix)) continue;
      const rest = entryPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { name: rest, path: entryPath, type: 'file', sha: entryData.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) children.set(dir, { name: dir, path: `${prefix}${dir}`, type: 'dir', sha: '' });
      }
    }
    if (children.size === 0) { sendError(ctx, 404, 'Not Found'); return; }
    sendJson(ctx, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((child) => ({
      type: child.type, size: child.type === 'file' ? (repo.objects.get(child.sha)?.data.length ?? 0) : 0,
      name: child.name, path: child.path, sha: child.sha,
      url: `/api/v3/repos/${owner}/${name}/contents/${child.path}`,
      html_url: `https://github.example/${owner}/${name}/${child.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${child.path}`,
      git_url: child.type === 'file' ? `/api/v3/repos/${owner}/${name}/git/blobs/${child.sha}` : null,
      download_url: child.type === 'file' ? `https://github.example/${owner}/${name}/raw/${repo.defaultBranch}/${child.path}` : null,
    })));
    return;
  }
  if (ctx.method === 'PUT') {
    const body = jsonBody(ctx);
    if (!body) return;
    const message = typeof body.message === 'string' && body.message ? body.message : `Update ${path}`;
    const contentBase64 = typeof body.content === 'string' ? body.content : '';
    let content: Buffer;
    try { content = Buffer.from(contentBase64, 'base64'); } catch { sendError(ctx, 422, 'Validation Failed: content must be base64'); return; }
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) {
      // Create the branch from the default-branch tip, then commit on it.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      if (defaultTip) bumpRepoVersion(repo);
      tip = defaultTip;
    }
    const map = tip ? commitTreeMap(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = map.get(path);
    if (expectedSha && existing && existing.oid !== expectedSha) { sendError(ctx, 409, 'sha does not match'); return; }
    if (expectedSha && !existing) { sendError(ctx, 409, 'sha does not match'); return; }
    const isCreate = !existing;
    const blobOid = storeObject(repo, 'blob', content);
    map.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = mapToTree(repo, map);
    const parents = tip ? [tip] : [];
    const commitOid = createCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    bumpRepoVersion(repo);
    sendJson(ctx, isCreate ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, url: `/api/v3/repos/${owner}/${name}/contents/${path}`, html_url: `https://github.example/${owner}/${name}/blob/${branch}/${path}`, git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`, download_url: `https://github.example/${owner}/${name}/raw/${branch}/${path}`, type: 'file', encoding: 'base64' },
      commit: commitJson(repo, owner, name, commitOid, message, treeOid),
    });
    return;
  }
  if (ctx.method === 'DELETE') {
    const body = jsonBody(ctx);
    if (!body) return;
    const message = typeof body.message === 'string' && body.message ? body.message : `Delete ${path}`;
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) { sendError(ctx, 404, 'Not Found'); return; }
    const map = commitTreeMap(repo, tip);
    const existing = map.get(path);
    if (!existing) { sendError(ctx, 404, 'Not Found'); return; }
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (expectedSha && existing.oid !== expectedSha) { sendError(ctx, 409, 'sha does not match'); return; }
    map.delete(path);
    const treeOid = mapToTree(repo, map);
    const commitOid = createCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    bumpRepoVersion(repo);
    sendJson(ctx, 200, {
      commit: commitJson(repo, owner, name, commitOid, message, treeOid),
    });
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function createIssueInternal(repo: Repo, title: string, body: string, labels: string[]): { issue?: Issue; error?: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `label "${label}" does not exist` };
  }
  const seq = nextSeq();
  const issue: Issue = {
    id: repo.id * 1000000 + repo.nextIssue,
    number: repo.nextIssue++,
    title, body, state: 'open', labels: [...labels],
    createdSeq: seq, updatedSeq: seq,
  };
  repo.issues.set(issue.number, issue);
  repo.comments.set(issue.number, []);
  return { issue };
}

function handleIssues(ctx: ReqCtx, repo: Repo, owner: string, name: string, tail: readonly string[]): void {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') {
        list.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
      }
      sendList(ctx, list, (issue) => issueJson(repo, issue));
      return;
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (!body) return;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) { sendError(ctx, 422, 'Validation Failed: title is required'); return; }
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const created = createIssueInternal(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      if (created.error) { sendError(ctx, 422, created.error); return; }
      sendJson(ctx, 201, issueJson(repo, created.issue!));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const number = parseInt(tail[0] ?? '', 10);
  if (!Number.isInteger(number)) { sendError(ctx, 404, 'Not Found'); return; }
  const issue = repo.issues.get(number);
  if (!issue) { sendError(ctx, 404, 'Not Found'); return; }
  if (tail.length === 1) {
    if (ctx.method === 'GET') { sendBytes(ctx, 200, issueJsonBytes(repo, issue), JSON_TYPE); return; }
    if (ctx.method === 'PATCH') {
      const body = jsonBody(ctx);
      if (!body) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) if (!repo.labels.has(label)) { sendError(ctx, 422, `label "${label}" does not exist`); return; }
        issue.labels = labels;
      }
      issue.updatedSeq = nextSeq();
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (ctx.method === 'GET') {
      const all = repo.comments.get(number) ?? [];
      sendList(ctx, all, (comment) => commentJson(repo, issue, comment));
      return;
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (!body) return;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (!commentBody) { sendError(ctx, 422, 'Validation Failed: body is required'); return; }
      const comment: IssueComment = { id: repo.nextComment++, body: commentBody, createdSeq: nextSeq() };
      (repo.comments.get(number) ?? []).push(comment);
      sendJson(ctx, 201, commentJson(repo, issue, comment));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function createPullInternal(repo: Repo, headRef: string, baseRef: string, title: string, body: string): { pull?: Pull; error?: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) return { error: `head branch "${headRef}" does not exist` };
  if (!baseSha) return { error: `base branch "${baseRef}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: 'A pull request already exists for this branch' };
    }
  }
  const seq = nextSeq();
  const base = mergeBase(repo, headSha, baseSha);
  const pull: Pull = {
    id: repo.id * 1000000 + repo.nextPull,
    number: repo.nextPull++,
    title, body, state: 'open',
    headRef, baseRef,
    headSha: peelToCommit(headSha, repoLookup(repo)),
    baseSha: peelToCommit(baseSha, repoLookup(repo)),
    merged: false, mergedAt: '', mergeCommitSha: '',
    mergeBaseSha: base ?? '',
    createdSeq: seq, updatedSeq: seq,
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

function mergePullInternal(repo: Repo, pull: Pull, method: string): { sha?: string; error?: string; status?: number } {
  if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { error: 'Pull request branch is missing', status: 404 };
  const { treeOid, conflict } = threeWayMerge(repo, baseTip, headTip);
  if (conflict) return { error: 'Merge conflict', status: 405 };
  const message = method === 'squash'
    ? `${pull.title} (#${pull.number})\n\n${pull.body}`
    : `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}`;
  const mergeCommit = createCommit(repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  bumpRepoVersion(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TS;
  pull.mergeCommitSha = mergeCommit;
  pull.updatedSeq = nextSeq();
  return { sha: mergeCommit };
}

function handlePulls(ctx: ReqCtx, repo: Repo, owner: string, name: string, tail: readonly string[]): void {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      sendList(ctx, list, (pull) => pullJson(repo, pull));
      return;
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (!body) return;
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      if (!head || !base || !title) { sendError(ctx, 422, 'Validation Failed: head, base and title are required'); return; }
      const created = createPullInternal(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
      if (created.error) { sendError(ctx, 422, created.error); return; }
      sendJson(ctx, 201, pullJson(repo, created.pull!));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const number = parseInt(tail[0] ?? '', 10);
  if (!Number.isInteger(number)) { sendError(ctx, 404, 'Not Found'); return; }
  const pull = repo.pulls.get(number);
  if (!pull) { sendError(ctx, 404, 'Not Found'); return; }
  if (tail.length === 1) {
    if (ctx.method === 'GET') { sendJson(ctx, 200, pullJson(repo, pull)); return; }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, diffFiles(repo, pull.mergeBaseSha || pull.baseSha, pull.headSha));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (ctx.method === 'PUT') {
      const body = jsonBody(ctx);
      if (!body) return;
      const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      const merged = mergePullInternal(repo, pull, method);
      if (merged.error) { sendError(ctx, merged.status ?? 405, merged.error); return; }
      sendJson(ctx, 200, {
        sha: merged.sha, merged: true,
        message: `Pull Request successfully merged`,
      });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };
interface GqlField {
  alias: string; name: string;
  args: Record<string, GqlValue>;
  children: GqlField[]; fragments: { type: string; fields: GqlField[] }[];
}
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | undefined;
  variables: Record<string, GqlValue>;
  fields: GqlField[];
}

class GqlParser {
  private pos = 0;
  private readonly text: string;
  // Variables actually supplied with the request. Per operation, `variables`
  // is reset to the supplied variables overlaid on that operation's variable
  // defaults (a supplied value — even explicit null — wins over its default).
  private readonly providedVariables: Record<string, GqlValue>;
  private variables: Record<string, GqlValue>;
  constructor(text: string, variables: Record<string, GqlValue>) {
    this.text = text;
    this.providedVariables = variables;
    this.variables = variables;
  }

  private skipWhitespace(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string { this.skipWhitespace(); return this.text[this.pos] ?? ''; }

  private expect(char: string): void {
    this.skipWhitespace();
    if (this.text[this.pos] !== char) throw new Error(`expected "${char}" at offset ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWhitespace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new Error(`expected a name at offset ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipWhitespace();
    if (this.text[this.pos] === '"') {
      if (this.text.startsWith('"""', this.pos)) {
        const end = this.text.indexOf('"""', this.pos + 3);
        if (end < 0) throw new Error('unterminated block string');
        const value = this.text.slice(this.pos + 3, end);
        this.pos = end + 3;
        return value;
      }
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length) {
        const char = this.text[this.pos++]!;
        if (char === '"') return out;
        if (char === '\\') {
          const escape = this.text[this.pos++] ?? '';
          const table: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (escape === 'u') { out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16)); this.pos += 4; }
          else out += table[escape] ?? escape;
        } else out += char;
      }
      throw new Error('unterminated string');
    }
    throw new Error(`expected a string at offset ${this.pos}`);
  }

  private readValue(): GqlValue {
    this.skipWhitespace();
    const char = this.text[this.pos] ?? '';
    if (char === '"') return this.readString();
    if (char === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return items;
    }
    if (char === '{') {
      this.pos += 1;
      const object: { [key: string]: GqlValue } = {};
      while (this.peek() !== '}') {
        const key = this.readName();
        this.expect(':');
        object[key] = this.readValue();
      }
      this.expect('}');
      return object;
    }
    if (char === '$') {
      this.pos += 1;
      const name = this.readName();
      return this.variables[name] ?? null;
    }
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (match) {
      this.pos += match[0].length;
      const num = Number(match[0]);
      return num;
    }
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name; // enum value, kept as its name
  }

  /**
   * Read directives after a field, fragment or operation, and say whether the
   * item is included. @skip(if: true) drops it, @include(if: false) drops it;
   * both may appear (either one excluding wins) and unknown directives are
   * ignored. `if` may be a literal or a $variable (already resolved by
   * readValue). Items are still fully parsed when excluded, so the parser
   * position stays correct — only the built field is dropped.
   */
  private readDirectives(): boolean {
    let include = true;
    while (this.peek() === '@') {
      this.pos += 1;
      const name = this.readName();
      const args = this.peek() === '(' ? this.readArguments() : {};
      if (name === 'skip' && args['if'] === true) include = false;
      else if (name === 'include' && args['if'] !== true) include = false;
    }
    return include;
  }

  /** Skip directives where inclusion is meaningless (operations, fragment definitions). */
  private skipDirectives(): void {
    this.readDirectives();
  }

  private readArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    this.expect(')');
    return args;
  }

  /**
   * Parse a variable definition list `($name: Type = default, ...)` and
   * return the defaults it declares (types are not enforced by this forge).
   * A default is a literal value read by readValue (string/number/boolean/
   * null/enum/list/object). Without a default the variable resolves to null
   * when not supplied, as before.
   */
  private skipVariableDefinitions(): Record<string, GqlValue> {
    const defaults: Record<string, GqlValue> = {};
    this.skipWhitespace();
    if (this.text[this.pos] !== '(') return defaults;
    this.pos += 1;
    for (;;) {
      this.skipWhitespace();
      const char = this.text[this.pos] ?? '';
      if (char === ')') { this.pos += 1; return defaults; }
      if (char === '') return defaults;
      if (char === '$') {
        this.pos += 1;
        const name = this.readName();
        this.skipWhitespace();
        if (this.text[this.pos] === ':') this.pos += 1;
        // Skip the type: names, `!`, and nested `[` `]` — until `=`, `,` or
        // `)` at bracket depth 0.
        let depth = 0;
        while (this.pos < this.text.length) {
          const c = this.text[this.pos]!;
          if (c === '[') depth += 1;
          else if (c === ']') depth -= 1;
          else if (depth === 0 && (c === '=' || c === ',' || c === ')')) break;
          this.pos += 1;
        }
        if (this.text[this.pos] === '=') {
          this.pos += 1;
          this.skipWhitespace();
          defaults[name] = this.readValue();
        }
        continue;
      }
      this.pos += 1;
    }
  }

  private readSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWhitespace();
        if (this.text.startsWith('on', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 2] ?? ' ')) {
          this.pos += 2;
          const typeName = this.readName();
          const include = this.readDirectives();
          const children = this.readSelectionSet();
          if (include) fields.push({ alias: '', name: '', args: {}, children, fragments: [{ type: typeName, fields: children }] });
        } else {
          // Fragment spread: name only; definitions are expanded by the caller.
          const spreadName = this.readName();
          const include = this.readDirectives();
          if (include) fields.push({ alias: '', name: '', args: {}, children: [], fragments: [{ type: `...${spreadName}`, fields: [] }] });
        }
        continue;
      }
      const first = this.readName();
      let alias = first;
      let name = first;
      if (this.peek() === ':') {
        this.pos += 1;
        name = this.readName();
      }
      const args = this.peek() === '(' ? this.readArguments() : {};
      const include = this.readDirectives();
      const children = this.peek() === '{' ? this.readSelectionSet() : [];
      if (include) fields.push({ alias, name, args, children, fragments: [] });
    }
    this.expect('}');
    return fields;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlField[]>();
    while (this.peek() !== '') {
      if (this.text.startsWith('fragment', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 8] ?? ' ')) {
        this.pos += 'fragment'.length;
        const name = this.readName();
        this.skipWhitespace();
        if (this.text.startsWith('on', this.pos)) this.pos += 2;
        this.readName();
        this.skipDirectives();
        fragments.set(name, this.readSelectionSet());
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      if (this.text.startsWith('mutation', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 8] ?? ' ')) {
        kind = 'mutation';
        this.pos += 'mutation'.length;
      } else if (this.text.startsWith('query', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 5] ?? ' ')) {
        this.pos += 'query'.length;
      }
      let name: string | undefined;
      this.skipWhitespace();
      if (/[A-Za-z_]/.test(this.text[this.pos] ?? '')) name = this.readName();
      const defaults = this.skipVariableDefinitions();
      // Effective variables for this operation: its defaults, with any
      // supplied value (even explicit null) winning. The selection set is
      // read after this assignment, so `$var` references in its arguments
      // and directives resolve against the merged set.
      this.variables = { ...defaults, ...this.providedVariables };
      this.skipDirectives();
      operations.push({ kind, name, variables: this.variables, fields: this.readSelectionSet() });
    }
    // Expand fragment spreads in place.
    const expand = (fields: GqlField[]): GqlField[] => {
      const out: GqlField[] = [];
      for (const field of fields) {
        for (const fragment of field.fragments) {
          if (fragment.type.startsWith('...')) {
            const body = fragments.get(fragment.type.slice(3));
            if (body) out.push(...expand(body));
          }
        }
        if (field.name) out.push({ ...field, children: expand(field.children) });
        else if (field.fragments.length > 0 && !field.fragments[0]!.type.startsWith('...')) {
          out.push({ ...field, children: expand(field.children) });
        }
      }
      return out;
    };
    for (const operation of operations) operation.fields = expand(operation.fields);
    return operations;
  }
}

// ---------------------------------------------------------------- GraphQL schema surface

/** Allowed field names per GraphQL type (validation + introspection). */
const S = (...names: string[]): Set<string> => new Set(names);
const SCHEMA_FIELDS: Record<string, Set<string>> = {
  Query: S('viewer', 'repository', 'node', '__type', '__schema', 'search'),
  Mutation: S('createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'),
  User: S('login', 'id', 'name', 'email', 'url'),
  Repository: S('id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'),
  Issue: S('id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'labels', 'comments'),
  PullRequest: S('id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'mergedAt', 'url'),
  IssueConnection: S('nodes', 'pageInfo', 'totalCount', 'edges'),
  PullRequestConnection: S('nodes', 'pageInfo', 'totalCount', 'edges'),
  PullRequestChangedFileConnection: S('nodes', 'pageInfo', 'totalCount', 'edges'),
  PullRequestChangedFile: S('path', 'filename', 'additions', 'deletions', 'changes', 'status'),
  PageInfo: S('hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'),
  IssueComment: S('id', 'body', 'createdAt'),
  __Type: S('name', 'kind', 'fields', 'enumValues', 'description'),
  __Field: S('name', 'description', 'type'),
  __EnumValue: S('name', 'description'),
  BranchRef: S('name', 'prefix', 'target'),
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MILESTONE'];
const ISSUE_STATE_VALUES = ['OPEN', 'CLOSED'];
const PR_STATE_VALUES = ['OPEN', 'CLOSED', 'MERGED'];

interface GqlCtx { errors: { message: string }[] }

/** Expand inline-fragment wrappers (`... on Repository { ... }`) for the current type. */
function flattenFields(fields: GqlField[], typeName: string): GqlField[] {
  const out: GqlField[] = [];
  for (const field of fields) {
    if (field.name === '') {
      for (const fragment of field.fragments) {
        if (!fragment.type.startsWith('...') && fragment.type === typeName) {
          out.push(...flattenFields(field.children, typeName));
        }
      }
      continue;
    }
    out.push(field);
  }
  return out;
}

function cursorOf(number: number): string { return Buffer.from(`cursor:${number}`, 'utf8').toString('base64'); }
function cursorNumber(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : undefined;
  } catch { return undefined; }
}

/** Resolve a GraphQL object's requested fields from a name -> thunk table. */
function gqlOut(fields: GqlField[], typeName: string, values: Record<string, (field: GqlField) => unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of flattenFields(fields, typeName)) {
    if (field.name === '__typename') { out[field.alias] = typeName; continue; }
    const value = values[field.name];
    if (value) out[field.alias] = value(field);
  }
  return out;
}

function gqlIssue(repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  return gqlOut(fields, 'Issue', {
    id: () => issueGid(repo, issue),
    number: () => issue.number,
    title: () => issue.title,
    body: () => issue.body,
    state: () => (issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: () => TS,
    updatedAt: () => TS,
    url: () => `https://github.example/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    labels: () => ({ nodes: issue.labels.map((name) => ({ name })) }),
    comments: (field) => ({ nodes: (repo.comments.get(issue.number) ?? []).map((comment) => gqlComment(repo, issue, comment, field.children)) }),
  });
}

function gqlComment(repo: Repo, issue: Issue, comment: IssueComment, fields: GqlField[]): Record<string, unknown> {
  return gqlOut(fields, 'IssueComment', {
    id: () => commentGid(repo, issue, comment),
    body: () => comment.body,
    createdAt: () => TS,
  });
}

function gqlPull(repo: Repo, pull: Pull, fields: GqlField[]): Record<string, unknown> {
  return gqlOut(fields, 'PullRequest', {
    id: () => pullGid(repo, pull),
    number: () => pull.number,
    title: () => pull.title,
    body: () => pull.body,
    state: () => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: () => pull.merged,
    headRefName: () => pull.headRef,
    baseRefName: () => pull.baseRef,
    mergeable: () => {
      if (pull.state !== 'open') return 'UNKNOWN';
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (!headTip || !baseTip) return 'UNKNOWN';
      return threeWayMerge(repo, baseTip, headTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (field) => {
      const files = diffFiles(repo, pull.mergeBaseSha || pull.baseSha, pull.headSha);
      const first = typeof field.args.first === 'number' ? field.args.first : files.length;
      const nodes = files.slice(0, first).map((file) => {
        const node: Record<string, unknown> = {};
        for (const child of connectionNodes(field.children)) {
          if (child.name === 'path' || child.name === 'filename') node[child.alias] = file.filename;
          else if (child.name === 'additions') node[child.alias] = file.additions;
          else if (child.name === 'deletions') node[child.alias] = file.deletions;
          else if (child.name === 'changes') node[child.alias] = file.changes;
          else if (child.name === 'status') node[child.alias] = file.status;
        }
        return node;
      });
      return { nodes, pageInfo: { hasNextPage: files.length > first, endCursor: null } };
    },
    createdAt: () => TS,
    mergedAt: () => (pull.merged ? pull.mergedAt : null),
    url: () => `https://github.example/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
  });
}

/** A GraphQL connection page over items with a numeric cursor (`number`). */
function gqlConn<T extends { number: number }>(items: readonly T[], first: number, after: number | undefined, map: (item: T) => unknown): Record<string, unknown> {
  let list = [...items];
  if (after !== undefined) {
    const index = list.findIndex((item) => item.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = list.slice(0, first);
  return {
    nodes: page.map(map),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: list.length > first,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
      startCursor: page.length > 0 ? cursorOf(page[0]!.number) : null,
    },
  };
}

function gqlRepo(repo: Repo, fields: GqlField[]): Record<string, unknown> {
  return gqlOut(fields, 'Repository', {
    id: () => repoGid(repo),
    databaseId: () => repo.id,
    name: () => repo.name,
    nameWithOwner: () => `${VIEWER_LOGIN}/${repo.name}`,
    owner: (field) => gqlUser(field.children),
    defaultBranchRef: () => ({ name: repo.defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: () => repo.description,
    private: () => repo.isPrivate,
    createdAt: () => TS,
    updatedAt: () => TS,
    url: () => `https://github.example/${VIEWER_LOGIN}/${repo.name}`,
    issue: (field) => {
      const number = field.args.number;
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue ? gqlIssue(repo, issue, field.children) : null;
    },
    issues: (field) => {
      const states = Array.isArray(field.args.states) ? field.args.states.map(String) : [];
      const orderBy = asRecord(field.args.orderBy);
      const first = typeof field.args.first === 'number' ? field.args.first : 100;
      const after = typeof field.args.after === 'string' ? cursorNumber(field.args.after) : undefined;
      let list = [...repo.issues.values()];
      if (states.length > 0) {
        list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const direction = orderBy.direction === 'DESC' ? -1 : 1;
      if (orderBy.field === 'CREATED_AT') {
        list.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
      } else {
        list.sort((a, b) => (a.number - b.number) * direction);
      }
      return gqlConn(list, first, after, (issue) => gqlIssue(repo, issue, connectionNodes(field.children)));
    },
    pullRequests: (field) => {
      const first = typeof field.args.first === 'number' ? field.args.first : 100;
      const after = typeof field.args.after === 'string' ? cursorNumber(field.args.after) : undefined;
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      return gqlConn(list, first, after, (pull) => gqlPull(repo, pull, connectionNodes(field.children)));
    },
    pullRequest: (field) => {
      const number = field.args.number;
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull ? gqlPull(repo, pull, field.children) : null;
    },
  });
}

function connectionNodes(children: GqlField[]): GqlField[] {
  for (const child of children) {
    if (child.name === 'nodes') return child.children;
    if (child.name === 'edges') {
      for (const edge of child.children) if (edge.name === 'node') return edge.children;
    }
  }
  return children;
}

function gqlUser(fields: GqlField[]): Record<string, unknown> {
  return gqlOut(fields, 'User', {
    login: () => VIEWER_LOGIN,
    id: () => gid('User', VIEWER_LOGIN),
    name: () => VIEWER_NAME,
    email: () => VIEWER_EMAIL,
    url: () => `https://github.example/${VIEWER_LOGIN}`,
  });
}

/** Introspection `name`/`description` nodes for a list of names. */
function nameNodes(children: GqlField[], names: readonly string[]): Record<string, unknown>[] {
  return names.map((valueName) => {
    const node: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'name') node[child.alias] = valueName;
      else if (child.name === 'description') node[child.alias] = null;
    }
    return node;
  });
}

function gqlTypeInfo(name: string, fields: GqlField[]): Record<string, unknown> {
  const fieldSet = SCHEMA_FIELDS[name];
  const enumValues = name === 'SearchType' ? SEARCH_TYPE_VALUES : name === 'IssueState' ? ISSUE_STATE_VALUES : name === 'PullRequestState' ? PR_STATE_VALUES : undefined;
  return gqlOut(fields, '__Type', {
    name: () => name,
    kind: () => (enumValues ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (field) => nameNodes(field.children, fieldSet ? [...fieldSet].sort() : []),
    enumValues: (field) => nameNodes(field.children, enumValues ?? []),
  });
}

/** Child object type each field's selection set is validated against. */
const GQL_CHILD_TYPE: Record<string, string> = {
  repository: 'Repository', issue: 'Issue', pullRequest: 'PullRequest', node: 'Repository',
  viewer: 'User', owner: 'User', defaultBranchRef: 'BranchRef', __type: '__Type',
};
const GQL_CHILD_CONNECTION: Record<string, string> = { issues: 'Issue', pullRequests: 'PullRequest', files: 'PullRequestChangedFile' };

/** Validate the operation's fields against the schema surface; collect "Cannot query field" errors. */
function validateFields(fields: GqlField[], typeName: string, errors: { message: string }[]): void {
  const allowed = SCHEMA_FIELDS[typeName];
  for (const field of fields) {
    if (field.name === '__typename') continue;
    if (field.name === '') {
      // Inline fragment.
      for (const fragment of field.fragments) {
        if (!fragment.type.startsWith('...')) validateFields(fragment.fields, fragment.type, errors);
      }
      continue;
    }
    if (!allowed?.has(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    const childType = GQL_CHILD_TYPE[field.name];
    if (childType) validateFields(field.children, childType, errors);
    else {
      const connType = GQL_CHILD_CONNECTION[field.name];
      if (connType) validateFields(connectionNodes(field.children), connType, errors);
    }
  }
}

/** Query root fields, by name. Mutations never reach these (see executeOperation). */
const QUERY_HANDLERS: Record<string, (field: GqlField) => unknown> = {
  viewer: (field) => gqlUser(field.children),
  repository: (field) => {
    const owner = field.args.owner;
    const name = field.args.name;
    const repo = typeof owner === 'string' && typeof name === 'string' ? getRepo(owner, name) : undefined;
    return repo ? gqlRepo(repo, field.children) : null;
  },
  node: (field) => {
    const id = typeof field.args.id === 'string' ? field.args.id : undefined;
    const decoded = id ? ungid(id) : undefined;
    if (decoded?.kind === 'Repository') {
      const repo = findRepo(parseInt(decoded.payload, 10));
      return repo ? gqlRepo(repo, field.children) : null;
    }
    if (decoded?.kind === 'Issue') {
      const found = gidIssue(id);
      return found ? gqlIssue(found.repo, found.issue, field.children) : null;
    }
    if (decoded?.kind === 'PullRequest') {
      const found = gidPull(id);
      return found ? gqlPull(found.repo, found.pull, field.children) : null;
    }
    return null;
  },
  __type: (field) => {
    const name = typeof field.args.name === 'string' ? field.args.name : '';
    return SCHEMA_FIELDS[name] || name === 'SearchType' || name === 'IssueState' || name === 'PullRequestState'
      ? gqlTypeInfo(name, field.children)
      : null;
  },
  __schema: () => ({ queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }),
};

function executeOperation(operation: GqlOperation, errors: { message: string }[]): Record<string, unknown> | null {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateFields(operation.fields, rootType, errors);
  if (errors.length > 0) return null;
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    if (field.name === '__typename') { data[field.alias] = rootType; continue; }
    // Validation already rejected any field outside the operation's own type,
    // so a mutation field can go straight to the mutation executor.
    if (operation.kind === 'mutation') { data[field.alias] = executeMutation(field, errors); continue; }
    const handler = QUERY_HANDLERS[field.name];
    data[field.alias] = handler ? handler(field) : null;
  }
  return data;
}

function executeMutation(field: GqlField, errors: { message: string }[]): Record<string, unknown> | null {
  const input = asRecord(field.args.input);
  const pick = (children: GqlField[], value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === '__typename') { out[child.alias] = value.__typename ?? null; continue; }
      const nested = value[child.name];
      if (nested && typeof nested === 'object' && !Array.isArray(nested) && child.children.length > 0) {
        out[child.alias] = pick(child.children, nested as Record<string, unknown>);
      } else if (child.name in value) {
        out[child.alias] = value[child.name];
      }
    }
    return out;
  };
  if (field.name === 'createIssue') {
    const repo = gidRepo(input.repositoryId);
    if (!repo) { errors.push({ message: 'Could not resolve to a Repository with the global id provided.' }); return null; }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const created = createIssueInternal(repo, title, body, []);
    if (created.error) { errors.push({ message: created.error }); return null; }
    const issue = created.issue!;
    return pick(field.children, { issue: { number: issue.number, id: issueGid(repo, issue), __typename: 'Issue' }, __typename: 'CreateIssuePayload' });
  }
  if (field.name === 'closeIssue') {
    const found = gidIssue(input.issueId);
    if (!found) { errors.push({ message: 'Could not resolve to an Issue with the global id provided.' }); return null; }
    const { repo, issue } = found;
    issue.state = 'closed';
    issue.updatedSeq = nextSeq();
    return pick(field.children, { issue: { number: issue.number, id: issueGid(repo, issue), state: 'CLOSED', __typename: 'Issue' }, __typename: 'CloseIssuePayload' });
  }
  if (field.name === 'createPullRequest') {
    const repo = gidRepo(input.repositoryId);
    if (!repo) { errors.push({ message: 'Could not resolve to a Repository with the global id provided.' }); return null; }
    const created = createPullInternal(
      repo,
      typeof input.headRefName === 'string' ? input.headRefName : '',
      typeof input.baseRefName === 'string' ? input.baseRefName : '',
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
    );
    if (created.error) { errors.push({ message: created.error }); return null; }
    const pull = created.pull!;
    return pick(field.children, {
      pullRequest: {
        number: pull.number, id: pullGid(repo, pull), state: 'OPEN',
        headRefName: pull.headRef, baseRefName: pull.baseRef, __typename: 'PullRequest',
      },
      __typename: 'CreatePullRequestPayload',
    });
  }
  if (field.name === 'mergePullRequest') {
    const found = gidPull(input.pullRequestId);
    if (!found) { errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' }); return null; }
    const { repo, pull } = found;
    const merged = mergePullInternal(repo, pull, 'squash');
    if (merged.error) { errors.push({ message: merged.error }); return null; }
    return pick(field.children, {
      pullRequest: {
        number: pull.number, id: pullGid(repo, pull), state: 'MERGED', merged: true, __typename: 'PullRequest',
      },
      __typename: 'MergePullRequestPayload',
    });
  }
  if (field.name === 'addComment') {
    const found = gidIssue(input.subjectId);
    if (!found) { errors.push({ message: 'Could not resolve to an Issue with the global id provided.' }); return null; }
    const { repo, issue } = found;
    const body = typeof input.body === 'string' ? input.body : '';
    const comment: IssueComment = { id: repo.nextComment++, body, createdSeq: nextSeq() };
    (repo.comments.get(issue.number) ?? []).push(comment);
    const node = { id: commentGid(repo, issue, comment), body, __typename: 'IssueComment' };
    return pick(field.children, { commentEdge: { node, __typename: 'IssueCommentEdge' }, __typename: 'AddCommentPayload' });
  }
  errors.push({ message: `Unknown mutation "${field.name}".` });
  return null;
}

function handleGraphql(ctx: ReqCtx): void {
  if (!requireAuth(ctx)) return;
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) { sendError(ctx, 400, 'Problems parsing JSON'); return; }
  const runOne = (body: unknown): { data: Record<string, unknown> | null; errors?: { message: string }[] } => {
    const record = asRecord(body);
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = asRecord(record.variables);
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    if (!query) return { data: null, errors: [{ message: 'A query is required.' }] };
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(query, variables as Record<string, GqlValue>).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
    }
    // Operation selection (GraphQL spec): a named operation runs when
    // operationName names it; several operations without a name are an
    // error; an unknown name is an error. Previously operations[0] always
    // ran, so `operationName` was silently ignored.
    let operation: GqlOperation | undefined;
    if (operationName !== undefined) {
      operation = operations.find((op) => op.name === operationName);
      if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    } else {
      if (operations.length > 1) return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
      operation = operations[0];
    }
    if (!operation) return { data: null, errors: [{ message: 'A query is required.' }] };
    const errors: { message: string }[] = [];
    const data = executeOperation(operation, errors);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(parsed.value)) {
    sendJson(ctx, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

/** Build one tool definition; key order matches the canonical tools/list shape. */
const tool = (name: string, description: string, props: readonly [string, string, string][], required: string[]): McpToolDef => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(props.map(([key, type, desc]) => [key, { type, description: desc }])),
    required,
  },
});

const MCP_TOOLS: McpToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', [['name', 'string', 'The name of the repository.'], ['description', 'string', 'A short description of the repository.'], ['private', 'boolean', 'Whether the repository is private.']], ['name']),
  tool('get_repo', 'Get a repository by owner and name.', [['owner', 'string', 'The repository owner login.'], ['repo', 'string', 'The repository name.']], ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', [['owner', 'string', 'The repository owner login.'], ['repo', 'string', 'The repository name.'], ['title', 'string', 'The issue title.'], ['body', 'string', 'The issue body.']], ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', [['owner', 'string', 'The repository owner login.'], ['repo', 'string', 'The repository name.'], ['state', 'string', 'Issue state filter: open, closed, or all.']], ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request between two branches.', [['owner', 'string', 'The repository owner login.'], ['repo', 'string', 'The repository name.'], ['title', 'string', 'The pull request title.'], ['body', 'string', 'The pull request body.'], ['head', 'string', 'The head branch name.'], ['base', 'string', 'The base branch name.']], ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request.', [['owner', 'string', 'The repository owner login.'], ['repo', 'string', 'The repository name.'], ['pull_number', 'integer', 'The pull request number.']], ['owner', 'repo', 'pull_number']),
];

const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };

function mcpResult(ctx: ReqCtx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
}

function mcpError(ctx: ReqCtx, status: number, id: unknown, code: number, message: string): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function callMcpTool(name: string, args: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; message: string } {
  const tool = MCP_TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!tool) return { ok: false, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, message: `Missing required argument: ${required}` };
    }
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (store.repos.has(repoName)) return { ok: false, message: `Repository ${repoName} already exists` };
    const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return { ok: true, value: repoJson(repo) };
  }
  const owner = str(args.owner);
  const repoName = str(args.repo);
  const repo = getRepo(owner, repoName);
  if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
  if (name === 'get_repo') return { ok: true, value: repoJson(repo) };
  if (name === 'create_issue') {
    const created = createIssueInternal(repo, str(args.title), typeof args.body === 'string' ? args.body : '', []);
    if (created.error) return { ok: false, message: created.error };
    return { ok: true, value: issueJson(repo, created.issue!) };
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => a.createdSeq - b.createdSeq);
    return { ok: true, value: list.map((issue) => issueJson(repo, issue)) };
  }
  if (name === 'create_pull_request') {
    const created = createPullInternal(repo, str(args.head), str(args.base), str(args.title), typeof args.body === 'string' ? args.body : '');
    if (created.error) return { ok: false, message: created.error };
    return { ok: true, value: pullJson(repo, created.pull!) };
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (!pull) return { ok: false, message: `Pull request #${number} not found` };
    const merged = mergePullInternal(repo, pull, 'squash');
    if (merged.error) return { ok: false, message: merged.error };
    return { ok: true, value: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged', pull: pullJson(repo, pull) } };
  }
  return { ok: false, message: `Unknown tool: ${name}` };
}

function handleMcp(ctx: ReqCtx): void {
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx, 204);
    return;
  }
  if (ctx.method !== 'POST') { sendError(ctx, 404, 'Not Found'); return; }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const record = asRecord(body);
  const id = 'id' in record ? record.id : null;
  if (!isAuthed(ctx)) {
    mcpError(ctx, 401, id ?? null, -32001, 'Unauthorized');
    return;
  }
  if (!('id' in record)) {
    // A notification: acknowledge and stop (202, empty body).
    sendEmpty(ctx, 202);
    return;
  }
  const method = typeof record.method === 'string' ? record.method : '';
  const params = asRecord(record.params);
  if (method === 'server/discover') {
    mcpResult(ctx, id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      instructions: 'A standalone git forge exposing repositories, issues and pull requests as tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
    return;
  }
  if (method === 'initialize') {
    mcpResult(ctx, id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    sendEmpty(ctx, 202);
    return;
  }
  if (method === 'ping') { mcpResult(ctx, id, {}); return; }
  if (method === 'tools/list') {
    mcpResult(ctx, id, { tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments);
    const called = callMcpTool(toolName, args);
    if (!called.ok) {
      // Unknown tool or missing argument: a JSON-RPC error, never an HTTP 500.
      mcpError(ctx, 200, id, -32602, called.message);
      return;
    }
    const value = called.value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    mcpResult(ctx, id, {
      content: [{ type: 'text', text }],
      structuredContent: value,
      isError: false,
    });
    return;
  }
  mcpError(ctx, 200, id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- git HTTP routing

function handleGit(ctx: ReqCtx, owner: string, repoName: string): void {
  const repo = getRepo(owner, repoName);
  const [service, action] = ctx.segments.slice(2);
  if (!requireAuth(ctx)) return;
  if (!repo) { sendError(ctx, 404, 'Not Found'); return; }
  if (ctx.method === 'GET' && service === 'info' && action === 'refs') {
    const serviceParam = ctx.query.get('service') ?? '';
    if (serviceParam === 'git-upload-pack') {
      const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
      const { body, type } = uploadPackAdvertisement(repo, wantsV2);
      sendBytes(ctx, 200, body, type);
      return;
    }
    if (serviceParam === 'git-receive-pack') {
      const { body, type } = receivePackAdvertisement(repo);
      sendBytes(ctx, 200, body, type);
      return;
    }
    sendError(ctx, 400, 'service parameter is required');
    return;
  }
  if (ctx.method === 'POST' && service === 'git-upload-pack') {
    let packets: Pkt[];
    try {
      packets = decodePktLines(ctx.body);
    } catch {
      sendError(ctx, 400, 'malformed pkt-line');
      return;
    }
    const lines = packets.filter((packet): packet is { kind: 'data'; payload: Buffer } => packet.kind === 'data');
    const first = lines[0]?.payload.toString('utf8').trim() ?? '';
    const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
    if (first.startsWith('command=ls-refs')) {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const packet of lines.slice(1)) {
        const text = packet.payload.toString('utf8').trim();
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text === 'unborn') args.unborn = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      sendBytes(ctx, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (first.startsWith('command=fetch')) {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenRelative: false, deepenNot: [], includeTag: false, hasDone: false, thinPack: false, noProgress: false, ofsDelta: false, filter: '' };
      for (const packet of lines.slice(1)) {
        const text = packet.payload.toString('utf8').trim();
        if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7).trim(), 10);
        else if (text === 'deepen-relative') args.deepenRelative = true;
        else if (text.startsWith('deepen-since ')) args.deepenSince = parseInt(text.slice('deepen-since '.length).trim(), 10);
        else if (text.startsWith('deepen-not ')) args.deepenNot.push(text.slice('deepen-not '.length).trim());
        else if (text === 'include-tag') args.includeTag = true;
        else if (text === 'thin-pack') args.thinPack = true;
        else if (text === 'no-progress') args.noProgress = true;
        else if (text === 'ofs-delta') args.ofsDelta = true;
        else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
        else if (text === 'done') { args.hasDone = true; break; }
      }
      // Real git upload-pack (2.43) dies on any `deepen-not` line
      // ("ambiguous deepen-not") — `--shallow-exclude` always fails against
      // it, on every transport and protocol version. Mirror that instead of
      // treating the excluded refs as extra haves (which only fails the
      // clone by accident when the excluded commit is on the fetched path).
      if (args.deepenNot.length > 0) { sendError(ctx, 500, `ambiguous deepen-not: deepen-not ${args.deepenNot[0]}`); return; }
      sendBytes(ctx, 200, handleFetch(repo, args, wantsV2), 'application/x-git-upload-pack-result');
      return;
    }
    if (first.startsWith('want ')) {
      // Protocol v0 fetch: `want <oid>[\\0caps]` lines, shallow/deepen lines, a
      // flush, then `have` lines and `done`, a flush. v0 has no command= line;
      // without this branch every v0 client (old git, protocol.version=0) got 400.
      const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenRelative: false, deepenNot: [], includeTag: false, hasDone: false, thinPack: false, noProgress: false, ofsDelta: false, filter: '' };
      let afterFlush = false;
      for (const packet of packets) {
        if (packet.kind === 'flush' || packet.kind === 'delim') { afterFlush = true; continue; }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8').trim();
        if (afterFlush) {
          if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
          else if (text === 'done') args.hasDone = true;
          continue;
        }
        // The first want line carries the capabilities after a SPACE (v0 puts
        // them on the first want line, unlike receive-pack's NUL separator).
        const line = text;
        if (line.startsWith('want ')) {
          const tokens = line.slice(5).trim().split(/\s+/);
          args.wants.push(tokens[0]!);
          // The first want line carries the client's capabilities after the
          // oid. In v0 `deepen-relative` and `include-tag` are conveyed ONLY
          // there (there is no separate line, unlike v2) — a `fetch
          // --deepen=1` from a shallow clone sends `deepen 1` plus the
          // `deepen-relative` cap, and missing it makes the server treat the
          // deepen as absolute depth 1 (wrong shallow list, client dies with
          // "expected shallow list").
          if (tokens.slice(1).includes('include-tag')) args.includeTag = true;
          if (tokens.slice(1).includes('deepen-relative')) args.deepenRelative = true;
        }
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
        else if (line === 'deepen-relative') args.deepenRelative = true;
        else if (line.startsWith('deepen-since ')) args.deepenSince = parseInt(line.slice('deepen-since '.length).trim(), 10);
        else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice('deepen-not '.length).trim());
        else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
      }
      // See the v2 branch: real git upload-pack dies on any `deepen-not`.
      if (args.deepenNot.length > 0) { sendError(ctx, 500, `ambiguous deepen-not: deepen-not ${args.deepenNot[0]}`); return; }
      sendBytes(ctx, 200, handleFetch(repo, args, false), 'application/x-git-upload-pack-result');
      return;
    }
    sendError(ctx, 400, 'unknown upload-pack command');
    return;
  }
  if (ctx.method === 'POST' && service === 'git-receive-pack') {
    let result: ReceivePackResult;
    try {
      result = handleReceivePack(repo, ctx.body);
    } catch {
      sendError(ctx, 400, 'malformed pkt-line');
      return;
    }
    sendBytes(ctx, 200, result.body, 'application/x-git-receive-pack-result');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- app

export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // No Date header: the suite never reads one, and skipping it saves a
    // per-response date format plus ~30 header bytes on every reply.
    res.sendDate = false;
    requestCounter += 1;
    const requestId = `req-${requestCounter.toString(16).padStart(8, '0')}`;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const segments = path.split('/').filter((segment) => segment !== '').map((segment) => {
        try { return decodeURIComponent(segment); } catch { return segment; }
      });
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const ctx: ReqCtx = { req, res, method, path, segments, query: url.searchParams, body, requestId };
      if (path === '/healthz') {
        if (method === 'GET') { sendJson(ctx, 200, { ok: true }); return; }
        sendError(ctx, 404, 'Not Found');
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        const owner = segments[0]!;
        const repoName = segments[1]!.slice(0, -'.git'.length);
        ctx.segments = segments;
        handleGit(ctx, owner, repoName);
        return;
      }
      if (segments[0] === 'api' || segments[0] === 'mcp') {
        handleRest(ctx);
        return;
      }
      sendError(ctx, 404, 'Not Found');
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: (err as Error).message || 'Internal Server Error' }));
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  });
  return server;
}

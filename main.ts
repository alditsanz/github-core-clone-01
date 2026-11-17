// Entry point for the standalone git forge.
//
// Two ways to run it:
//
//   1. Trial mode — when MAKEFUN_ENV_URL is set. The forge binds an ephemeral
//      port, tells the trial environment which port it picked, then stays up
//      until the environment reports the trial is finished, and exits 0.
//      The environment owns the lifecycle here; this file only obeys it.
//
//   2. Standalone mode — when MAKEFUN_ENV_URL is absent. The forge binds the
//      configured host and port (defaults 127.0.0.1:8080, overridable with
//      --port / --host / FORGE_PORT / FORGE_HOST) and serves until it is
//      stopped with SIGINT or SIGTERM, which shuts it down cleanly.
//
// Either way the forge itself is created by app.ts; this file only owns the
// process around it: configuration, the data directory, the startup banner,
// the trial handshake, and a graceful shutdown.

import { createApp } from './app.ts';
import type { Server } from 'node:http';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = readPackageVersion();
const PROGRAM = 'github-core-clone-01 forge';
const USAGE = [
  `${PROGRAM} ${VERSION}`,
  '',
  'usage: node --experimental-strip-types main.ts [options]',
  '',
  'options:',
  '  --port <n>       TCP port to listen on in standalone mode (default 8080;',
  '                   0 picks an ephemeral port). Ignored in trial mode,',
  '                   where the kernel always picks the port.',
  '  --host <addr>    Address to bind in standalone mode (default 127.0.0.1).',
  '  --data-dir <dir> Directory for runtime state (default ./.forge-data).',
  '                   Created when missing; a plain file there is an error.',
  '  --help           Print this text and exit.',
  '  --version        Print the version and exit.',
  '',
  'environment:',
  '  MAKEFUN_ENV_URL  Trial environment origin: enables trial mode.',
  '  FORGE_PORT       Standalone port (same as --port; the flag wins).',
  '  FORGE_HOST       Standalone host (same as --host; the flag wins).',
  '  FORGE_DATA_DIR   Data directory (same as --data-dir; the flag wins).',
].join('\n');

/** Read the version out of this repo's package.json; fall back when unreadable. */
function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function log(message: string): void {
  process.stdout.write(`[forge] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[forge] error: ${message}\n`);
  process.exit(1);
}

interface Options {
  port: number;
  host: string;
  dataDir: string;
  help: boolean;
  version: boolean;
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`invalid port ${JSON.stringify(raw)} from ${source}: expected an integer from 0 to 65535`);
  }
  return port;
}

function envPort(): number | undefined {
  const raw = process.env.FORGE_PORT ?? process.env.PORT;
  return raw === undefined || raw === '' ? undefined : parsePort(raw, 'FORGE_PORT/PORT');
}

function envHost(): string | undefined {
  const raw = process.env.FORGE_HOST ?? process.env.HOST;
  return raw === undefined || raw === '' ? undefined : raw;
}

function envDataDir(): string | undefined {
  const raw = process.env.FORGE_DATA_DIR ?? process.env.DATA_DIR;
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Parse argv into options. Unknown flags and missing values are usage errors. */
function parseArgs(argv: string[]): Options {
  const opts: Options = {
    port: envPort() ?? 8080,
    host: envHost() ?? '127.0.0.1',
    dataDir: envDataDir() ?? './.forge-data',
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--version' || arg === '-V') {
      opts.version = true;
    } else if (arg === '--port') {
      const value = argv[i + 1];
      if (value === undefined) fail('--port needs a value');
      i += 1;
      opts.port = parsePort(value, '--port');
    } else if (arg.startsWith('--port=')) {
      opts.port = parsePort(arg.slice('--port='.length), '--port');
    } else if (arg === '--host') {
      const value = argv[i + 1];
      if (value === undefined) fail('--host needs a value');
      i += 1;
      opts.host = value;
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    } else if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined) fail('--data-dir needs a value');
      i += 1;
      opts.dataDir = value;
    } else if (arg.startsWith('--data-dir=')) {
      opts.dataDir = arg.slice('--data-dir='.length);
    } else {
      process.stderr.write(`[forge] error: unknown argument ${JSON.stringify(arg)}\n\n${USAGE}\n`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Make sure the data directory exists and really is a directory, then return
 * its absolute path. A file sitting where the directory should be is a hard
 * error: silently writing elsewhere would hide a misconfiguration.
 */
function prepareDataDir(requested: string): string {
  const dir = resolve(requested);
  let existing: ReturnType<typeof statSync> | undefined;
  try {
    existing = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== undefined) {
    if (!existing.isDirectory()) fail(`data directory ${dir} exists and is not a directory`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface RuntimeStatus {
  pid: number;
  mode: 'trial' | 'standalone';
  host: string;
  port: number;
  dataDir: string;
  startedAt: string;
}

/** Write a small status file so scripts can find the running forge; remove it on exit. */
function writeStatusFile(dir: string, status: RuntimeStatus): string {
  const path = resolve(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return path;
}

function removeStatusFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort only: a stale status file is harmless, a crash here is not.
  }
}

/** Start listening; resolves with the bound address once the socket is live. */
function listen(server: Server, port: number, host?: string): Promise<{ port: number; host: string }> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    const onListening = (): void => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectListen(new Error('the server did not bind a TCP port'));
        return;
      }
      resolveListen({ port: address.port, host: host ?? '0.0.0.0' });
    };
    if (host === undefined) server.listen(port, onListening);
    else server.listen(port, host, onListening);
  });
}

/** Close the server, dropping idle keep-alive connections first so close can finish. */
async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    // Never hang shutdown on a client that will not go away.
    setTimeout(resolveClose, 5_000).unref();
  });
}

/**
 * Run `attempt` until it reports success, with exponential backoff between
 * failures. An attempt that throws a fatal error ends the process at once;
 * anything else is retried forever — the environment may still be starting.
 */
async function retryForever<T>(label: string, attempt: (n: number) => Promise<T | 'retry'>): Promise<T> {
  const firstWaitMs = 250;
  const maxWaitMs = 2_000;
  for (let n = 0; ; n += 1) {
    try {
      const outcome = await attempt(n);
      if (outcome !== 'retry') return outcome;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      process.stderr.write(`[forge] ${label} attempt ${n + 1} failed (${err instanceof Error ? err.message : String(err)}); retrying\n`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(maxWaitMs, firstWaitMs * 2 ** Math.min(n, 8))));
  }
}

class FatalError extends Error {}

/**
 * Tell the trial environment which port this process bound. A 200 means the
 * registration landed; a 409 means another entry registered first, which this
 * process cannot fix, so it waits like any other. 400/405 are contract
 * errors and end the program; anything else is retried.
 */
async function registerWithEnv(envUrl: string, port: number): Promise<void> {
  await retryForever('register', async () => {
    const res = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200 || res.status === 409) return undefined;
    if (res.status === 400 || res.status === 405) {
      throw new FatalError(`register answered HTTP ${res.status}: ${await res.text()}`);
    }
    return 'retry';
  });
}

/** Ask the environment whether the trial is over; return only once it says so. */
async function waitForEnvDone(envUrl: string): Promise<void> {
  await retryForever('done poll', async () => {
    const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) {
      const body = (await res.json()) as { done?: unknown };
      if (body.done === true) return undefined;
    }
    return 'retry';
  });
}

/**
 * Trial mode: bind an ephemeral port, register it, wait for the environment
 * to declare the trial done, then shut down and exit 0.
 */
async function runTrial(envUrl: string, dataDir: string | undefined): Promise<void> {
  const server = createApp();
  const bound = await listen(server, 0);
  log(`listening on http://127.0.0.1:${bound.port} (trial mode, store in-memory)`);
  const statusPath = dataDir === undefined ? undefined : writeStatusFile(dataDir, {
    pid: process.pid,
    mode: 'trial',
    host: '127.0.0.1',
    port: bound.port,
    dataDir,
    startedAt: new Date().toISOString(),
  });
  let shuttingDown = false;
  const stop = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}; shutting down`);
    if (statusPath !== undefined) removeStatusFile(statusPath);
    await closeServer(server);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  await registerWithEnv(envUrl, bound.port);
  log('registered with the trial environment; waiting for it to finish');
  await waitForEnvDone(envUrl);
  if (statusPath !== undefined) removeStatusFile(statusPath);
  await closeServer(server);
  log('trial finished');
}

/**
 * Standalone mode: bind the configured host and port and serve until stopped.
 * SIGINT/SIGTERM close the server and exit 0.
 */
async function runStandalone(opts: Options, dataDir: string): Promise<void> {
  const server = createApp();
  const bound = await listen(server, opts.port, opts.host);
  const statusPath = writeStatusFile(dataDir, {
    pid: process.pid,
    mode: 'standalone',
    host: bound.host,
    port: bound.port,
    dataDir,
    startedAt: new Date().toISOString(),
  });
  log(`listening on http://${bound.host}:${bound.port} (standalone, store in-memory, data-dir ${dataDir})`);
  let shuttingDown = false;
  const stop = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}; shutting down`);
    removeStatusFile(statusPath);
    await closeServer(server);
    log('stopped');
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  // Keep the process alive until a signal arrives.
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${PROGRAM} ${VERSION}\n`);
    return;
  }
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl !== '') {
    // Trial mode owns the port (ephemeral) and the lifecycle; the data
    // directory is only used for the status file when one is configured.
    const dataDir = process.env.FORGE_DATA_DIR !== undefined || process.env.DATA_DIR !== undefined
      ? prepareDataDir(opts.dataDir)
      : undefined;
    await runTrial(envUrl, dataDir);
    return;
  }
  const dataDir = prepareDataDir(opts.dataDir);
  await runStandalone(opts, dataDir);
}

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`[forge] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exit(1);
});

try {
  await main();
  process.exit(0);
} catch (err) {
  if (err instanceof FatalError) {
    process.stderr.write(`[forge] ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// main.ts — the entrypoint: it wires the app server (app.ts) to the trial
// env and keeps the process alive until the env says the trial is over.
//
// The lifecycle, in order:
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to register with, so the process exits 1 immediately.
//   2. The server binds an ephemeral port (listen(0)); the kernel picks a
//      free one. It must never be 8080 — the env owns that port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      address the request came from plus N as this entry's base URL. The
//      first register wins; a 409 means another entry already registered,
//      which is not this process's problem, so it carries on waiting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with
//      a short exponential backoff; the process never exits before done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest wait. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed tries: exponential from RETRY_FIRST_MS, capped at RETRY_CAP_MS. */
function delayFor(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Run `tryOnce` until it returns a value; `undefined` means "not yet, try
 * again", and a throw means the same unless the step itself decides the
 * error is fatal by rethrowing a marked error. Retries run forever with an
 * exponential backoff, because the env may still be starting and the only
 * way out of this process is the env saying done.
 */
async function retryForever<T>(tryOnce: (attempt: number) => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const value = await tryOnce(attempt);
    if (value !== undefined) return value;
    await sleep(delayFor(attempt));
  }
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to
 * fix. 400 and 405 are contract errors and end the program; a network error
 * or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  await retryForever(async () => {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      // A contract error (400/405) is fatal; anything else is retried.
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    return undefined;
  });
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  await retryForever(async () => {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return true;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    return undefined;
  });
}

/** Bind the server to an ephemeral port and return the port it got. */
async function bindServer(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const store = new Store();
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const { server, port } = await bindServer();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

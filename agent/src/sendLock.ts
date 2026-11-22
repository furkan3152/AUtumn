/**
 * Serialises the direct submitter's sends per agent EOA, so two ticks that
 * share the EOA never sign two transactions with the same account nonce.
 *
 * The lock covers: reading the EOA's pending nonce, signing and broadcasting
 * with that explicit nonce, and waiting until the RPC counts the transaction
 * (direct.ts). The next holder therefore reads the next nonce.
 *
 * - `inProcessSendLock`: one queue per EOA in this process (the default).
 * - `pgSendLock`: a Postgres transaction-level advisory lock per EOA, for
 *   overlapping cron instances sharing one database. Transaction-level, so
 *   it also works through a transaction-mode pooler (Neon's pooled URL).
 */
import type pg from "pg";
import { keccak256, toBytes, type Address } from "viem";

/** Runs `fn` while holding the send lock of `submitter`. */
export type SendLock = <T>(submitter: Address, fn: () => Promise<T>) => Promise<T>;

/** The lock could not be taken, or the nonce not read: nothing was sent. */
export class SendLockError extends Error {
  override readonly name = "SendLockError";
}

const queues = new Map<string, Promise<unknown>>();

/** One send at a time per EOA within this process (shared by every executor in it). */
export const inProcessSendLock: SendLock = (submitter, fn) => {
  const key = submitter.toLowerCase();
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
};

/** The advisory lock key of an EOA: the first 8 bytes of keccak256("autumn/direct-submit/" ‖ address), as int64. */
export function sendLockKey(submitter: Address): bigint {
  const h = keccak256(toBytes(`autumn/direct-submit/${submitter.toLowerCase()}`));
  return BigInt.asIntN(64, BigInt(h.slice(0, 18)));
}

/**
 * A Postgres advisory lock per EOA, held for one transaction on its own
 * connection. Waits up to `waitMs` (default 60 s) for another holder, then
 * gives up with SendLockError (before anything is sent). `fn`'s own result or
 * error is returned unchanged; a failure to release after `fn` is ignored
 * (the lock ends with the transaction or the connection either way).
 */
export function pgSendLock(pool: pg.Pool, opts: { waitMs?: number } = {}): SendLock {
  const waitMs = opts.waitMs ?? 60_000;
  if (!Number.isInteger(waitMs) || waitMs < 1) throw new Error("waitMs must be a positive integer");
  // Waiters queue in this process first, so at most one pooled connection per EOA is held for the lock here: with
  // several plans sending at once they would otherwise each hold a connection while waiting, and starve the storage
  // queries (and, under Node, the web requests) that share the pool.
  return (submitter, fn) => inProcessSendLock(submitter, () => locked(submitter, fn));
  async function locked<T>(submitter: Address, fn: () => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      throw new SendLockError(`Could not reach Postgres for the send lock: ${(err as Error).message}`);
    }
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${waitMs}ms'`);
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [sendLockKey(submitter).toString()]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release(true);
      throw new SendLockError(`Could not take the send lock of ${submitter}: ${(err as Error).message}`);
    }
    try {
      return await fn();
    } finally {
      const committed = await client.query("COMMIT").then(
        () => true,
        () => false,
      );
      client.release(!committed);
    }
  }
}

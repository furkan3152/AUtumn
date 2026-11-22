import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { getAddress, type Address, type Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import type { PlanPeriod } from "@autumn/core";
import type { Attempt, AttemptSlot, AttemptStatus, EncryptedKey, NewAttempt, PlanRecord, RunLogEntry, RunLogKind } from "../types.js";
import type { NewPlan, Storage } from "./types.js";

/**
 * agent/migrations, found from this module's own location at run time (not a bundler-visible asset URL).
 * Resolved only when called: in a bundled Worker `import.meta.url` is not a file URL, and migrations
 * are applied out of band (`autumn-agent migrate`), never from the app.
 */
export function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

/** Applies migrations/*.sql in name order, once each, inside a transaction per file. */
export async function migrate(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(/*turbopackIgnore: true*/ dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const f of files) {
      await client.query("BEGIN");
      try {
        await client.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
        const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
        if (done.rowCount === 0) {
          await client.query(await readFile(/*turbopackIgnore: true*/ path.join(dir, f), "utf8"));
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
          applied.push(f);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

type PlanRow = {
  id: string;
  owner_id: string;
  wallet_address: string;
  amount_per_buy: string;
  period: PlanPeriod;
  fee_allowance_per_buy: string;
  dip_buy: boolean;
  day_of_week: number;
  hour_utc: number;
  expires_at: string;
  status: PlanRecord["status"];
  stopped_reason: string | null;
  session_public_key: string;
  session: SerializedSession | null;
  created_at: string;
  created_block: string | null;
  grant_tx_hash: string | null;
  stop_tx_hash: string | null;
  stopped_at: string | null;
};

function planFromRow(r: PlanRow): PlanRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    walletAddress: getAddress(r.wallet_address),
    amountPerBuy: BigInt(r.amount_per_buy),
    period: r.period,
    feeAllowancePerBuy: BigInt(r.fee_allowance_per_buy),
    dipBuy: r.dip_buy,
    dayOfWeek: r.day_of_week,
    hourUtc: r.hour_utc,
    expiresAt: Number(r.expires_at),
    status: r.status,
    ...(r.stopped_reason ? { stoppedReason: r.stopped_reason } : {}),
    sessionPublicKey: r.session_public_key as Hex,
    ...(r.session ? { session: r.session } : {}),
    createdAt: Number(r.created_at),
    ...(r.created_block !== null ? { createdBlock: BigInt(r.created_block) } : {}),
    ...(r.grant_tx_hash ? { grantTxHash: r.grant_tx_hash as Hex } : {}),
    ...(r.stop_tx_hash ? { stopTxHash: r.stop_tx_hash as Hex } : {}),
    ...(r.stopped_at !== null ? { stoppedAt: Number(r.stopped_at) } : {}),
  };
}

type AttemptRow = {
  id: string;
  plan_id: string;
  period_id: string;
  slot: AttemptSlot;
  status: AttemptStatus;
  started_at: string;
  amount_in: string;
  min_out: string;
  calls_id: string | null;
  tx_hash: string | null;
  out_amount: string | null;
  reason: string | null;
};

function attemptFromRow(r: AttemptRow): Attempt {
  return {
    id: String(r.id),
    planId: r.plan_id,
    periodId: r.period_id,
    slot: r.slot,
    status: r.status,
    startedAt: Number(r.started_at),
    amountIn: BigInt(r.amount_in),
    minOut: BigInt(r.min_out),
    ...(r.calls_id ? { callsId: r.calls_id as Hex } : {}),
    ...(r.tx_hash ? { txHash: r.tx_hash as Hex } : {}),
    ...(r.out_amount !== null ? { out: BigInt(r.out_amount) } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

type RunLogRow = {
  plan_id: string;
  period_id: string;
  at: string;
  outcome: RunLogEntry["outcome"];
  reason: string;
  tx_hash: string | null;
  amount_in: string | null;
  out_amount: string | null;
  kind: RunLogKind | null;
};

function runLogFromRow(x: RunLogRow): RunLogEntry {
  return {
    planId: x.plan_id,
    periodId: x.period_id,
    at: Number(x.at),
    outcome: x.outcome,
    reason: x.reason,
    ...(x.tx_hash ? { txHash: x.tx_hash as Hex } : {}),
    ...(x.amount_in !== null ? { amountIn: BigInt(x.amount_in) } : {}),
    ...(x.out_amount !== null ? { out: BigInt(x.out_amount) } : {}),
    ...(x.kind ? { kind: x.kind } : {}),
  };
}

const ATTEMPT_COLS =
  "id, plan_id, to_char(period_id, 'YYYY-MM-DD') AS period_id, slot, status, started_at, amount_in, min_out, calls_id, tx_hash, out_amount, reason";
const RUN_LOG_COLS =
  "plan_id, to_char(period_id, 'YYYY-MM-DD') AS period_id, at, outcome, reason, tx_hash, amount_in, out_amount, kind";

/** Postgres storage over plain `pg`. Run `migrate(pool)` once before use. */
export class PgStorage implements Storage {
  constructor(private readonly pool: pg.Pool) {}

  async upsertOwner(walletAddress: Address): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO owners (wallet_address) VALUES ($1)
       ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
       RETURNING id`,
      [walletAddress.toLowerCase()],
    );
    return r.rows[0]!.id;
  }

  async createPlan(plan: NewPlan, key: EncryptedKey): Promise<PlanRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ id: string }>(
        `INSERT INTO owners (wallet_address) VALUES ($1)
         ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address RETURNING id`,
        [plan.walletAddress.toLowerCase()],
      );
      const r = await client.query<PlanRow>(
        `INSERT INTO plans (id, owner_id, wallet_address, amount_per_buy, period, fee_allowance_per_buy, dip_buy, day_of_week,
                            hour_utc, expires_at, session_public_key, created_at, created_block)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [
          plan.id,
          owner.rows[0]!.id,
          plan.walletAddress.toLowerCase(),
          plan.amountPerBuy.toString(),
          plan.period,
          plan.feeAllowancePerBuy.toString(),
          plan.dipBuy,
          plan.dayOfWeek,
          plan.hourUtc,
          plan.expiresAt,
          plan.sessionPublicKey.toLowerCase(),
          plan.createdAt,
          plan.createdBlock?.toString() ?? null,
        ],
      );
      await client.query(
        "INSERT INTO session_keys (plan_id, ciphertext, iv, auth_tag, key_version) VALUES ($1, $2, $3, $4, $5)",
        [r.rows[0]!.id, Buffer.from(key.ciphertext), Buffer.from(key.iv), Buffer.from(key.authTag), key.keyVersion],
      );
      await client.query("COMMIT");
      return planFromRow(r.rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    if (!UUID.test(planId)) return null;
    const r = await this.pool.query<PlanRow>("SELECT * FROM plans WHERE id = $1", [planId]);
    return r.rows[0] ? planFromRow(r.rows[0]) : null;
  }

  async listActivePlans(): Promise<PlanRecord[]> {
    const r = await this.pool.query<PlanRow>("SELECT * FROM plans WHERE status = 'active' ORDER BY created_at");
    return r.rows.map(planFromRow);
  }

  async listPlansForWallet(walletAddress: Address): Promise<PlanRecord[]> {
    const r = await this.pool.query<PlanRow>("SELECT * FROM plans WHERE wallet_address = $1 ORDER BY created_at DESC, id", [
      walletAddress.toLowerCase(),
    ]);
    return r.rows.map(planFromRow);
  }

  async countPendingPlans(walletAddress: Address, since: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM plans WHERE wallet_address = $1 AND status = 'pending_grant' AND created_at >= $2",
      [walletAddress.toLowerCase(), since],
    );
    return Number(r.rows[0]!.n);
  }

  async deletePendingPlan(planId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM plans p WHERE p.id = $1 AND p.status = 'pending_grant'
         AND NOT EXISTS (SELECT 1 FROM purchase_attempts a WHERE a.plan_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM run_log l WHERE l.plan_id = p.id)`,
      [planId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async deletePendingPlansBefore(walletAddress: Address, before: number): Promise<number> {
    // session_keys rows go with their plan (ON DELETE CASCADE). A pending plan has no attempts or run log.
    const r = await this.pool.query(
      `DELETE FROM plans p WHERE p.wallet_address = $1 AND p.status = 'pending_grant' AND p.created_at < $2
         AND NOT EXISTS (SELECT 1 FROM purchase_attempts a WHERE a.plan_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM run_log l WHERE l.plan_id = p.id)`,
      [walletAddress.toLowerCase(), before],
    );
    return r.rowCount ?? 0;
  }

  async countPlans(walletAddress: Address): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM plans WHERE wallet_address = $1", [walletAddress.toLowerCase()]);
    return Number(r.rows[0]!.n);
  }

  async activatePlan(planId: string, session: SerializedSession, grantTxHash?: Hex): Promise<void> {
    const r = await this.pool.query(
      `UPDATE plans SET status = 'active', session = $2, grant_tx_hash = $3, updated_at = now()
       WHERE id = $1 AND status = 'pending_grant'`,
      [planId, JSON.stringify(session), grantTxHash?.toLowerCase() ?? null],
    );
    if (r.rowCount !== 1) throw new Error("plan is not waiting for a grant");
  }

  async stopPlan(planId: string, reason: string, at?: number, txHash?: Hex): Promise<void> {
    const r = await this.pool.query(
      `UPDATE plans SET status = 'stopped', stopped_reason = $2, stopped_at = $3, stop_tx_hash = $4, updated_at = now()
       WHERE id = $1 AND status <> 'stopped'`,
      [planId, reason, at ?? null, txHash?.toLowerCase() ?? null],
    );
    if (r.rowCount === 1) return;
    const exists = await this.pool.query("SELECT 1 FROM plans WHERE id = $1", [planId]);
    if (exists.rowCount !== 1) throw new Error("no such plan");
  }

  async getEncryptedSessionKey(planId: string): Promise<EncryptedKey | null> {
    const r = await this.pool.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }>(
      "SELECT ciphertext, iv, auth_tag, key_version FROM session_keys WHERE plan_id = $1",
      [planId],
    );
    const row = r.rows[0];
    return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version } : null;
  }

  async claimAttempt(a: NewAttempt): Promise<Attempt | null> {
    const r = await this.pool.query<AttemptRow>(
      `INSERT INTO purchase_attempts (plan_id, period_id, slot, status, started_at, amount_in, min_out)
       VALUES ($1, $2, $3, 'submitting', $4, $5, $6)
       ON CONFLICT (plan_id, period_id, slot) WHERE status IN ('submitting', 'ambiguous', 'bought') DO NOTHING
       RETURNING ${ATTEMPT_COLS}`,
      [a.planId, a.periodId, a.slot, a.startedAt, a.amountIn.toString(), a.minOut.toString()],
    );
    return r.rows[0] ? attemptFromRow(r.rows[0]) : null;
  }

  async updateAttempt(id: string, patch: Partial<Pick<Attempt, "status" | "callsId" | "txHash" | "out" | "reason">>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.callsId !== undefined) add("calls_id", patch.callsId);
    if (patch.txHash !== undefined) add("tx_hash", patch.txHash.toLowerCase());
    if (patch.out !== undefined) add("out_amount", patch.out.toString());
    if (patch.reason !== undefined) add("reason", patch.reason);
    if (sets.length === 0) return;
    const r = await this.pool.query(`UPDATE purchase_attempts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    if (r.rowCount !== 1) throw new Error("no such attempt");
  }

  async openAttempts(planId: string): Promise<Attempt[]> {
    const r = await this.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLS} FROM purchase_attempts WHERE plan_id = $1 AND status IN ('submitting', 'ambiguous') ORDER BY id`,
      [planId],
    );
    return r.rows.map(attemptFromRow);
  }

  async countAttempts(planId: string, periodId: string, slot: AttemptSlot, status: AttemptStatus): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM purchase_attempts WHERE plan_id = $1 AND period_id = $2 AND slot = $3 AND status = $4",
      [planId, periodId, slot, status],
    );
    return Number(r.rows[0]!.n);
  }

  async creditedTxHashes(planId: string): Promise<Set<string>> {
    const r = await this.pool.query<{ tx_hash: string }>(
      "SELECT tx_hash FROM purchase_attempts WHERE plan_id = $1 AND status = 'bought' AND tx_hash IS NOT NULL",
      [planId],
    );
    return new Set(r.rows.map((x) => x.tx_hash.toLowerCase()));
  }

  async appendRunLog(e: RunLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_log (plan_id, period_id, at, outcome, reason, tx_hash, amount_in, out_amount, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.planId,
        e.periodId,
        e.at,
        e.outcome,
        e.reason,
        e.txHash?.toLowerCase() ?? null,
        e.amountIn?.toString() ?? null,
        e.out?.toString() ?? null,
        e.kind ?? null,
      ],
    );
  }

  async lastRunLog(planId: string): Promise<RunLogEntry | null> {
    const r = await this.pool.query<RunLogRow>(`SELECT ${RUN_LOG_COLS} FROM run_log WHERE plan_id = $1 ORDER BY id DESC LIMIT 1`, [planId]);
    return r.rows[0] ? runLogFromRow(r.rows[0]) : null;
  }

  async listRunLog(planIds: readonly string[], limit: number): Promise<RunLogEntry[]> {
    if (planIds.length === 0) return [];
    const r = await this.pool.query<RunLogRow>(
      `SELECT ${RUN_LOG_COLS} FROM run_log WHERE plan_id = ANY($1::uuid[]) ORDER BY id DESC LIMIT $2`,
      [planIds, limit],
    );
    return r.rows.map(runLogFromRow);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

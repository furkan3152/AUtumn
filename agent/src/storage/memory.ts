import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import type { Attempt, AttemptSlot, AttemptStatus, EncryptedKey, NewAttempt, PlanRecord, RunLogEntry } from "../types.js";
import type { NewPlan, Storage } from "./types.js";

const OPEN: readonly AttemptStatus[] = ["submitting", "ambiguous"];
const BLOCKING: readonly AttemptStatus[] = ["submitting", "ambiguous", "bought"];

/** In-process storage with the same semantics as PgStorage. For tests and local runs. */
export class MemoryStorage implements Storage {
  readonly owners = new Map<string, string>(); // wallet(lower) -> id
  readonly plans = new Map<string, PlanRecord>();
  readonly keys = new Map<string, EncryptedKey>();
  readonly attempts: Attempt[] = [];
  readonly runLog: RunLogEntry[] = [];
  private seq = 0;

  async upsertOwner(walletAddress: Address): Promise<string> {
    const k = walletAddress.toLowerCase();
    let id = this.owners.get(k);
    if (!id) {
      id = randomUUID();
      this.owners.set(k, id);
    }
    return id;
  }

  async createPlan(plan: NewPlan, key: EncryptedKey): Promise<PlanRecord> {
    const ownerId = await this.upsertOwner(plan.walletAddress);
    if ([...this.plans.values()].some((p) => p.sessionPublicKey.toLowerCase() === plan.sessionPublicKey.toLowerCase())) {
      throw new Error("session public key already used by another plan");
    }
    if (this.plans.has(plan.id)) throw new Error("plan id already exists");
    const rec: PlanRecord = { ...plan, ownerId, status: "pending_grant" };
    this.plans.set(rec.id, rec);
    this.keys.set(rec.id, key);
    return structuredClone(rec);
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    const p = this.plans.get(planId);
    return p ? structuredClone(p) : null;
  }

  async listActivePlans(): Promise<PlanRecord[]> {
    return [...this.plans.values()].filter((p) => p.status === "active").map((p) => structuredClone(p));
  }

  async activatePlan(planId: string, session: SerializedSession): Promise<void> {
    const p = this.plans.get(planId);
    if (!p || p.status !== "pending_grant") throw new Error("plan is not waiting for a grant");
    p.status = "active";
    p.session = structuredClone(session);
  }

  async stopPlan(planId: string, reason: string): Promise<void> {
    const p = this.plans.get(planId);
    if (!p) throw new Error("no such plan");
    p.status = "stopped";
    p.stoppedReason = reason;
  }

  async getEncryptedSessionKey(planId: string): Promise<EncryptedKey | null> {
    return this.keys.get(planId) ?? null;
  }

  async claimAttempt(a: NewAttempt): Promise<Attempt | null> {
    const taken = this.attempts.some(
      (x) => x.planId === a.planId && x.weekId === a.weekId && x.slot === a.slot && BLOCKING.includes(x.status),
    );
    if (taken) return null;
    const rec: Attempt = { ...a, id: String(++this.seq), status: "submitting" };
    this.attempts.push(rec);
    return { ...rec };
  }

  async updateAttempt(id: string, patch: Partial<Pick<Attempt, "status" | "callsId" | "txHash" | "out" | "reason">>): Promise<void> {
    const a = this.attempts.find((x) => x.id === id);
    if (!a) throw new Error("no such attempt");
    Object.assign(a, patch);
  }

  async openAttempts(planId: string): Promise<Attempt[]> {
    return this.attempts.filter((x) => x.planId === planId && OPEN.includes(x.status)).map((x) => ({ ...x }));
  }

  async countAttempts(planId: string, weekId: string, slot: AttemptSlot, status: AttemptStatus): Promise<number> {
    return this.attempts.filter((x) => x.planId === planId && x.weekId === weekId && x.slot === slot && x.status === status).length;
  }

  async creditedTxHashes(planId: string): Promise<Set<string>> {
    return new Set(
      this.attempts.filter((x) => x.planId === planId && x.status === "bought" && x.txHash).map((x) => x.txHash!.toLowerCase()),
    );
  }

  async appendRunLog(entry: RunLogEntry): Promise<void> {
    this.runLog.push({ ...entry });
  }

  async lastRunLog(planId: string): Promise<RunLogEntry | null> {
    for (let i = this.runLog.length - 1; i >= 0; i--) if (this.runLog[i]!.planId === planId) return { ...this.runLog[i]! };
    return null;
  }
}

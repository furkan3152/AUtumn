/**
 * The direct submitter's send lock. The in-process lock always runs; the
 * Postgres advisory lock runs when TEST_DATABASE_URL is set, with two
 * separate pools standing in for two overlapping cron instances.
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import type { Address } from "viem";
import { inProcessSendLock, pgSendLock, sendLockKey, SendLockError, type SendLock } from "../src/sendLock.js";

const EOA = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER = "0x00000000000000000000000000000000000000b2" as Address;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `n` overlapping holders on `locks[i % locks.length]` and records whether any two were inside at once. */
async function overlap(locks: SendLock[], n: number, who: Address = EOA) {
  let inside = 0;
  let max = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      locks[i % locks.length]!(who, async () => {
        inside++;
        max = Math.max(max, inside);
        await sleep(30);
        order.push(i);
        inside--;
      }),
    ),
  );
  return { max, order };
}

describe("inProcessSendLock", () => {
  it("lets one holder per EOA in at a time, and does not block other EOAs", async () => {
    expect((await overlap([inProcessSendLock], 5)).max).toBe(1);
    let both = false;
    let a = false;
    await Promise.all([
      inProcessSendLock(EOA, async () => {
        a = true;
        await sleep(40);
      }),
      inProcessSendLock(OTHER, async () => {
        await sleep(10);
        both = a;
      }),
    ]);
    expect(both).toBe(true);
  });

  it("keeps going after a holder throws, and returns each holder's own result", async () => {
    await expect(inProcessSendLock(EOA, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await inProcessSendLock(EOA, async () => 7)).toBe(7);
  });
});

describe("sendLockKey", () => {
  it("is a stable int64 per address, case-insensitive", () => {
    const k = sendLockKey(EOA);
    expect(k).toBe(sendLockKey(EOA.toUpperCase().replace("0X", "0x") as Address));
    expect(k).not.toBe(sendLockKey(OTHER));
    expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true);
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("pgSendLock (Postgres)", () => {
  it("serialises holders across two pools (two processes sharing one EOA)", async () => {
    const a = new pg.Pool({ connectionString: url, max: 4 });
    const b = new pg.Pool({ connectionString: url, max: 4 });
    try {
      const r = await overlap([pgSendLock(a), pgSendLock(b)], 6);
      expect(r.max).toBe(1);
      expect(r.order).toHaveLength(6);
      // A holder's error is returned as is, and the lock is free afterwards.
      await expect(pgSendLock(a)(EOA, async () => Promise.reject(new Error("send failed")))).rejects.toThrow("send failed");
      expect(await pgSendLock(b)(EOA, async () => "ok")).toBe("ok");
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("gives up with SendLockError (nothing sent) when another process holds the lock too long", async () => {
    const a = new pg.Pool({ connectionString: url, max: 2 });
    const b = new pg.Pool({ connectionString: url, max: 2 });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const holder = pgSendLock(a)(EOA, async () => {
        entered();
        await held;
      });
      await inside;
      let ran = false;
      await expect(
        pgSendLock(b, { waitMs: 200 })(EOA, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(SendLockError);
      expect(ran).toBe(false);
      // Another EOA is not blocked.
      expect(await pgSendLock(b, { waitMs: 200 })(OTHER, async () => 1)).toBe(1);
      release();
      await holder;
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });
});

describe("pgSendLock pool use", () => {
  it("holds at most one pooled connection per EOA in a process, however many sends wait", async () => {
    let held = 0;
    let maxHeld = 0;
    const fakePool = {
      async connect() {
        held++;
        maxHeld = Math.max(maxHeld, held);
        return {
          query: async () => ({ rows: [] }),
          release: () => {
            held--;
          },
        };
      },
    } as unknown as pg.Pool;
    const r = await overlap([pgSendLock(fakePool)], 6);
    expect(r.max).toBe(1);
    expect(maxHeld).toBe(1);
  });
});

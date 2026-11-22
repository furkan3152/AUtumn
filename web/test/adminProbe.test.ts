import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin probe route: authorisation and request validation. The server
 * glue (@/server/autumn, which needs a database) is replaced by stand-ins
 * that record whether a pool was ever opened; the probe itself is stubbed so
 * no chain or relay is reached.
 */
const calls = vi.hoisted(() => ({ withPool: 0, probe: [] as unknown[] }));

vi.mock("@/server/autumn", async () => {
  const { HttpError } = await import("@autumn/agent");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), { status, headers: { "content-type": "application/json" } });
  return {
    json,
    notAllowed: (...allow: string[]) => () => json({ error: `this endpoint accepts ${allow.join(", ")} only` }, 405),
    async handle(fn: () => Promise<unknown>) {
      try {
        return json(await fn());
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        return json({ error: "the Autumn server could not complete this request" }, 500);
      }
    },
    async readBody(req: Request) {
      try {
        return await req.json();
      } catch {
        throw new HttpError(400, "the request body must be JSON");
      }
    },
    async withPool<T>(fn: (pool: unknown) => Promise<T>) {
      calls.withPool++;
      return fn({});
    },
  };
});

vi.mock("@autumn/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@autumn/agent")>();
  return {
    ...real,
    serverConfigFromEnv: () => ({ live: true }),
    createProductionService: () => ({ deps: {} }),
    createExecutor: () => ({}),
    runAdminProbe: async (_deps: unknown, body: unknown) => {
      calls.probe.push(body);
      const { planId, kind } = real.parseProbeRequest(body);
      return { planId, kind, outcome: "not_attempted", onchain: { txHash: null } };
    },
  };
});

const { POST } = await import("../src/app/api/admin/probe/route");

const SECRET = "a-long-enough-cron-secret";
const PLAN = "0b0b4e0e-4a49-4c1c-9a3c-8a3f4f1c2d3e";
const req = (body: unknown, auth?: string) =>
  new Request("http://localhost/api/admin/probe", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth !== undefined ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  calls.withPool = 0;
  calls.probe = [];
  process.env.CRON_SECRET = SECRET;
  delete process.env.AUTUMN_CRON_SECRET;
});

describe("POST /api/admin/probe authorisation", () => {
  it("answers 401 without the exact bearer secret, before reading the body or opening a pool", async () => {
    for (const auth of [undefined, "", SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      const res = await POST(req("not json at all", auth));
      expect(res.status, String(auth)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(calls.withPool).toBe(0);
    expect(calls.probe).toHaveLength(0);
  });

  it("refuses everything when the server's secret is missing or shorter than 16 characters", async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(req({ planId: PLAN, kind: "status" }, "Bearer "))).status).toBe(401);
    process.env.CRON_SECRET = "short";
    expect((await POST(req({ planId: PLAN, kind: "status" }, "Bearer short"))).status).toBe(401);
    expect(calls.withPool).toBe(0);
  });

  it("accepts AUTUMN_CRON_SECRET as the secret's name, like the cron route", async () => {
    delete process.env.CRON_SECRET;
    process.env.AUTUMN_CRON_SECRET = SECRET;
    const res = await POST(req({ planId: PLAN, kind: "status" }, `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/probe validation", () => {
  const auth = `Bearer ${SECRET}`;
  it("answers 400 for a body that is not { planId, kind }, without opening a pool", async () => {
    const bad = [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ planId: PLAN }),
      JSON.stringify({ planId: "abc", kind: "status" }),
      JSON.stringify({ planId: PLAN, kind: "drain" }),
      JSON.stringify({ planId: PLAN, kind: "over-cap", amount: "5000000" }),
      JSON.stringify({ planId: PLAN, kind: "outside-allowlist", calls: [{ to: "0x0", data: "0x" }] }),
    ];
    for (const b of bad) {
      const res = await POST(req(b, auth));
      expect(res.status, b).toBe(400);
    }
    expect(calls.withPool).toBe(0);
    expect(calls.probe).toHaveLength(0);
  });

  it("passes a valid request to the probe", async () => {
    const res = await POST(req({ planId: PLAN, kind: "over-cap" }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId: PLAN, kind: "over-cap" });
    expect(calls.withPool).toBe(1);
  });
});

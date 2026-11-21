/**
 * Server-only glue between the Next.js route handlers and @autumn/agent.
 * One Postgres pool per server instance, created on first use from env.
 */
import "server-only";
import pg from "pg";
import { NextResponse } from "next/server";
import { HttpError, createProductionService, createRateLimiter, serverConfigFromEnv, toJson, type ServiceDeps } from "@autumn/agent";

type Holder = { pool?: pg.Pool; deps?: ServiceDeps; live?: boolean };
const g = globalThis as unknown as { __autumn?: Holder };
const holder: Holder = (g.__autumn ??= {});

export function serverConfigured(): { configured: boolean; live: boolean; problem?: string } {
  try {
    const c = serverConfigFromEnv(process.env);
    return { configured: true, live: c.live };
  } catch (e) {
    return { configured: false, live: false, problem: (e as Error).message };
  }
}

export function pool(): pg.Pool {
  if (!holder.pool) {
    const c = serverConfigFromEnv(process.env);
    holder.pool = new pg.Pool({ connectionString: c.databaseUrl, max: 3 });
  }
  return holder.pool;
}

export function service(): ServiceDeps {
  if (!holder.deps) {
    const { deps, live } = createProductionService(process.env, pool());
    // Per server instance: at most 10 new plans per client address per 10 minutes.
    holder.deps = { ...deps, createLimiter: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }) };
    holder.live = live;
  }
  return holder.deps;
}

export function json(body: unknown, status = 200): NextResponse {
  return new NextResponse(toJson(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Runs a handler and maps errors: HttpError keeps its status, configuration and unexpected errors are 500/503. */
export async function handle(fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    const msg = (e as Error).message ?? "unexpected error";
    if (/is not set|is missing|must be 32 bytes/.test(msg)) return json({ error: "the Autumn server is not configured" }, 503);
    console.error(JSON.stringify({ msg: "request failed", error: msg }));
    return json({ error: "the Autumn server could not complete this request" }, 500);
  }
}

/** The client's address as the platform reports it (Vercel sets x-forwarded-for; the first entry is the client). */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "the request body must be JSON");
  }
}

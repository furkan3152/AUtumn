/**
 * Server-only glue between the Next.js route handlers and @autumn/agent.
 *
 * Under Node (`next dev`, `next start`) one Postgres pool per server instance
 * is created on first use and shared by every request. In Cloudflare Workers
 * a socket opened by one request cannot be used by another ("Cannot perform
 * I/O on behalf of a different request"), so there each request gets its own
 * pool, closed when the request's work is done.
 */
import "server-only";
import pg from "pg";
import { NextResponse } from "next/server";
import {
  HttpError,
  createProductionService,
  createRateLimiter,
  serverConfigFromEnv,
  tickOnce,
  toJson,
  type RateLimiter,
  type ServiceDeps,
} from "@autumn/agent";

type Holder = { pool?: pg.Pool; deps?: ServiceDeps; limiter?: RateLimiter };
const g = globalThis as unknown as { __autumn?: Holder };
const holder: Holder = (g.__autumn ??= {});

/** True inside workerd (Cloudflare Workers and `wrangler dev`). */
export const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

export function serverConfigured(): { configured: boolean; live: boolean; problem?: string } {
  try {
    const c = serverConfigFromEnv(process.env);
    return { configured: true, live: c.live };
  } catch (e) {
    return { configured: false, live: false, problem: (e as Error).message };
  }
}

function newPool(): pg.Pool {
  const c = serverConfigFromEnv(process.env);
  return new pg.Pool({ connectionString: c.databaseUrl, max: 3 });
}

/** Per server instance (per isolate on Workers): at most 10 new plans per client address per 10 minutes. */
function limiter(): RateLimiter {
  return (holder.limiter ??= createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }));
}

/** Runs `fn` with a pool: the shared one under Node, a fresh one closed afterwards on Workers. */
export async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  if (!onWorkers) return fn((holder.pool ??= newPool()));
  const p = newPool();
  try {
    return await fn(p);
  } finally {
    await p.end().catch(() => undefined);
  }
}

/** Runs `fn` with the owner-facing service's dependencies (cached under Node, per request on Workers). */
export async function withService<T>(fn: (deps: ServiceDeps) => Promise<T>): Promise<T> {
  if (!onWorkers) {
    if (!holder.deps) {
      const { deps } = createProductionService(process.env, (holder.pool ??= newPool()));
      holder.deps = { ...deps, createLimiter: limiter() };
    }
    return fn(holder.deps);
  }
  return withPool((p) => fn({ ...createProductionService(process.env, p).deps, createLimiter: limiter() }));
}

/**
 * One runner pass (the cron), over the shared pool under Node or a pool of its own on Workers. The pool is
 * always made here, never inside @autumn/agent, so the Workers bundle uses one `pg` (the app's).
 */
export function tick() {
  return withPool((p) => tickOnce(process.env, p));
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

/**
 * The client's address as the platform reports it. On Workers, cf-connecting-ip (set by Cloudflare's edge,
 * which overwrites any client value); elsewhere the first x-forwarded-for entry.
 */
export function clientIp(req: Request): string | null {
  if (onWorkers) return req.headers.get("cf-connecting-ip")?.trim() || null;
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

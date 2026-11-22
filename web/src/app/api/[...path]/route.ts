import { notFound } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unknown /api paths answer in JSON, like every other endpoint. */
export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;

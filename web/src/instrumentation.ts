/** Starts the in-process scheduler when the app runs as a Node server and AUTUMN_SCHEDULER=internal. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.AUTUMN_SCHEDULER !== "internal") return;
  const { startScheduler } = await import("./server/scheduler");
  startScheduler();
}

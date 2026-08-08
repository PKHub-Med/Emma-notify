import type { IncrementalStore } from "./incremental-store.js";

export async function runWatchdog(
  store: IncrementalStore,
  now: Date,
  log?: (message: string) => void,
): Promise<number> {
  const buffersReady = await store.markExpiredBuffersReady(now);
  if (buffersReady > 0) log?.(`[watchdog] buffersReady=${buffersReady}`);
  return buffersReady;
}

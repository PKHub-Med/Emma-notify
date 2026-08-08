import type { DigestCreationResult, DigestStore } from "./digest-store.js";

export type DigestLoopStats = {
  readyBuffersFound: number;
  digestsCreated: number;
  digestItemsCreated: number;
  alreadyExisting: number;
};

export async function createDigestFromBuffer(
  store: DigestStore,
  bufferId: string,
  emailMode: "TEST" | "PRODUCTION",
): Promise<DigestCreationResult> {
  return store.createDigestFromBuffer(bufferId, emailMode);
}

export async function runDigestLoop(input: {
  store: DigestStore;
  emailMode: "TEST" | "PRODUCTION";
  limit?: number;
  log?: (message: string) => void;
}): Promise<DigestLoopStats> {
  const bufferIds = await input.store.findReadyBufferIds(input.limit ?? 25);
  const stats: DigestLoopStats = {
    readyBuffersFound: bufferIds.length,
    digestsCreated: 0,
    digestItemsCreated: 0,
    alreadyExisting: 0,
  };

  for (const bufferId of bufferIds) {
    try {
      const result = await createDigestFromBuffer(
        input.store,
        bufferId,
        input.emailMode,
      );
      if (result.outcome === "CREATED") {
        stats.digestsCreated += 1;
        stats.digestItemsCreated += result.itemsCount;
      } else if (result.outcome === "ALREADY_EXISTS") {
        stats.alreadyExisting += 1;
      }
    } catch {
      input.log?.(`[digest] bufferId=${bufferId} failed; READY buffer will retry`);
    }
  }

  if (stats.digestsCreated > 0 || stats.alreadyExisting > 0) {
    input.log?.(
      `[digest] created=${stats.digestsCreated} items=${stats.digestItemsCreated} existing=${stats.alreadyExisting}`,
    );
  }
  return stats;
}

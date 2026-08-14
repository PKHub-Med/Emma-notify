import { describe, expect, it } from "vitest";
import type { Prisma } from "../generated/prisma/client.js";
import {
  synchronizeCaseDeviceRelations,
} from "./baseline-store.js";

describe("TrackedCaseDevice synchronization", () => {
  it("stores a 3-device inspection idempotently and replaces stale links", async () => {
    const harness = relationHarness();
    await sync(harness.transaction, ["recA", "recB", "recC"]);
    await sync(harness.transaction, ["recA", "recB", "recC"]);
    expect([...harness.links].sort()).toEqual(["recA", "recB", "recC"]);
    await sync(harness.transaction, ["recB", "recD"]);
    expect([...harness.links].sort()).toEqual(["recB", "recD"]);
  });

  it("does not derive tenant scope from any of the linked Devices", async () => {
    const harness = relationHarness();
    await sync(harness.transaction, ["device-H2-A", "device-H3-B", "device-H4-C"]);
    expect([...harness.links]).toHaveLength(3);
    expect("trackedDevice" in harness.transaction).toBe(false);
  });
});

async function sync(transaction: Prisma.TransactionClient, ids: string[]) {
  return synchronizeCaseDeviceRelations(transaction, {
    trackedCaseId: "case-1",
    deviceAirtableIds: ids,
  });
}

function relationHarness() {
  const links = new Set<string>();
  const transaction = {
    trackedCaseDevice: {
      deleteMany: async ({ where }: { where: { deviceAirtableId?: { notIn: string[] } } }) => {
        const keep = where.deviceAirtableId?.notIn ?? [];
        for (const id of [...links]) if (!keep.includes(id)) links.delete(id);
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Array<{ deviceAirtableId: string }> }) => {
        for (const item of data) links.add(item.deviceAirtableId);
        return { count: data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { transaction, links };
}

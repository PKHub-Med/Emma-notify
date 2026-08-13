import { describe, expect, it } from "vitest";
import {
  runCommunicationDeliveryCleanup,
  type CommunicationDeliveryCleanupStore,
  type DeliveryCleanupStats,
} from "./communication-delivery-cleanup.js";

describe("legacy communication delivery cleanup", () => {
  it("cancels the backlog once and persists an activation-specific checkpoint", async () => {
    const store = new MemoryCleanupStore({
      scanned: 67,
      cancelledIds: ["delivery-1", "delivery-2"],
      alreadyTerminal: 65,
    });
    const activation = new Date("2026-08-13T16:54:00Z");
    const logs: string[] = [];
    const first = await runCommunicationDeliveryCleanup({
      store, activation, now: () => activation, log: (message) => logs.push(message),
    });
    const second = await runCommunicationDeliveryCleanup({ store, activation });
    expect(first?.cancelledIds).toEqual(["delivery-1", "delivery-2"]);
    expect(second).toBeNull();
    expect(store.scans).toBe(1);
    expect(logs).toContain(
      "COMMUNICATION_DELIVERY_CLEANUP scanned=67 cancelled=2 alreadyTerminal=65 durationMs=0",
    );
    expect(logs.filter((message) =>
      message.includes("reason=MISSING_HOSPITAL_SCOPE_LEGACY"))).toHaveLength(2);
  });

  it("does not scan without a valid activation barrier", async () => {
    const store = new MemoryCleanupStore({ scanned: 0, cancelledIds: [], alreadyTerminal: 0 });
    await expect(runCommunicationDeliveryCleanup({ store, activation: null })).resolves.toBeNull();
    expect(store.scans).toBe(0);
  });
});

class MemoryCleanupStore implements CommunicationDeliveryCleanupStore {
  scans = 0;
  private checkpoint: string | null = null;
  constructor(private readonly result: DeliveryCleanupStats) {}
  async cleanupOnce(input: { checkpointKey: string }) {
    if (this.checkpoint === input.checkpointKey) return null;
    this.checkpoint = input.checkpointKey;
    this.scans += 1;
    return this.result;
  }
}

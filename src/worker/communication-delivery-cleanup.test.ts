import { describe, expect, it } from "vitest";
import {
  runCommunicationDeliveryCleanup,
  type CommunicationDeliveryCleanupStore,
  type DeliveryCleanupStats,
} from "./communication-delivery-cleanup.js";

describe("legacy communication delivery cleanup", () => {
  it("cancels a 67-delivery backlog with the sender disabled and checkpoints once", async () => {
    const communicationEmailsEnabled = false;
    const deliveryIds = Array.from({ length: 67 }, (_, index) => `delivery-${index + 1}`);
    const store = new MemoryCleanupStore({
      scanned: 67,
      cancelledIds: deliveryIds,
      alreadyTerminal: 0,
    });
    const activation = new Date("2026-08-13T16:54:00Z");
    const logs: string[] = [];
    const first = await runCommunicationDeliveryCleanup({
      store, activation, now: () => activation, log: (message) => logs.push(message),
    });
    const second = await runCommunicationDeliveryCleanup({
      store, activation, log: (message) => logs.push(message),
    });
    expect(communicationEmailsEnabled).toBe(false);
    expect(first?.cancelledIds).toEqual(deliveryIds);
    expect(second).toBeNull();
    expect(store.scans).toBe(1);
    expect(logs).toContain(
      "COMMUNICATION_DELIVERY_CLEANUP scanned=67 cancelled=67 alreadyTerminal=0 durationMs=0",
    );
    expect(logs).toContain(
      "COMMUNICATION_DELIVERY_CLEANUP skipped reason=already_completed",
    );
    expect(logs.filter((message) =>
      message.includes("reason=MISSING_HOSPITAL_SCOPE_LEGACY"))).toHaveLength(67);
  });

  it("does not scan without a valid activation barrier", async () => {
    const store = new MemoryCleanupStore({ scanned: 0, cancelledIds: [], alreadyTerminal: 0 });
    const logs: string[] = [];
    await expect(runCommunicationDeliveryCleanup({
      store,
      activation: null,
      log: (message) => logs.push(message),
    })).resolves.toBeNull();
    expect(store.scans).toBe(0);
    expect(logs).toEqual([
      "COMMUNICATION_DELIVERY_CLEANUP skipped reason=send_not_before_missing",
    ]);
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

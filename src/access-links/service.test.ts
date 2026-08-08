import { describe, expect, it } from "vitest";
import {
  AccessLinkService,
  type AccessLinkRecord,
  type AccessLinkStore,
} from "./service.js";
import { parseAccessLinkToken, verifyAccessLinkToken } from "./token.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
const now = new Date("2026-08-08T18:00:00.000Z");

class MemoryAccessLinkStore implements AccessLinkStore {
  readonly records: AccessLinkRecord[] = [];

  async findByDigestId(digestId: string): Promise<AccessLinkRecord | null> {
    return this.records.find((record) => record.digestId === digestId) ?? null;
  }

  async create(input: AccessLinkRecord): Promise<AccessLinkRecord> {
    if (this.records.some((record) =>
      record.digestId === input.digestId || record.publicId === input.publicId)) {
      throw new Error("ACCESS_LINK_UNIQUE_CONFLICT");
    }
    this.records.push(input);
    return input;
  }
}

describe("AccessLinkService", () => {
  it("creates one stable AccessLink and URL for repeated calls", async () => {
    const store = new MemoryAccessLinkStore();
    const service = createService(store);

    const first = await service.getOrCreateDigestAccessLink("digest-1", now);
    const second = await service.getOrCreateDigestAccessLink(
      "digest-1",
      new Date(now.getTime() + 60_000),
    );

    expect(store.records).toHaveLength(1);
    expect(first).toBe(second);
    expect(store.records[0]?.expiresAt).toEqual(
      new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    );
  });

  it("detects a one-character signature change", async () => {
    const store = new MemoryAccessLinkStore();
    const url = await createService(store).getOrCreateDigestAccessLink("digest-1", now);
    const token = new URL(url).pathname.split("/").at(-1) ?? "";
    const parsed = parseAccessLinkToken(token);
    const record = store.records[0];
    expect(parsed).not.toBeNull();
    expect(record).toBeDefined();
    expect(verifyAccessLinkToken(token, record!, secret)).toBe(true);
    const replacement = token.endsWith("A") ? "B" : "A";
    const tampered = token.slice(0, -1) + replacement;
    expect(verifyAccessLinkToken(tampered, record!, secret)).toBe(false);
  });
});

function createService(store: AccessLinkStore): AccessLinkService {
  return new AccessLinkService(store, {
    signingSecret: secret,
    publicBaseUrl: "https://notify.example.org/",
    ttlDays: 30,
    generatePublicId: () => "abcdefghijklmnopqrstuvwx",
  });
}

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  PublicAccessLinkService,
  type PublicAccessLinkRecord,
  type PublicAccessLinkStore,
} from "../access-links/public-page.js";
import { signAccessLink } from "../access-links/token.js";
import { createApp } from "./app.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe("public API", () => {
  it("keeps /health independent from Airtable configuration", async () => {
    const { baseUrl } = await startApp(new MemoryStore(null));
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("serves /d/:token publicly with privacy and indexing headers", async () => {
    const record = accessRecord();
    const { baseUrl } = await startApp(new MemoryStore(record));
    const token = signAccessLink(record, secret);
    const response = await fetch(`${baseUrl}/d/${token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
  });
});

class MemoryStore implements PublicAccessLinkStore {
  constructor(private readonly record: PublicAccessLinkRecord | null) {}

  async findByPublicId(publicId: string): Promise<PublicAccessLinkRecord | null> {
    return this.record?.publicId === publicId ? this.record : null;
  }

  async recordValidOpen(): Promise<boolean> { return true; }
}

async function startApp(store: PublicAccessLinkStore): Promise<{ baseUrl: string }> {
  const prisma = {
    $queryRaw: async () => [{ ok: 1 }],
  } as unknown as PrismaClient;
  const app = createApp(prisma, new PublicAccessLinkService(store, secret));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function accessRecord(): PublicAccessLinkRecord {
  return {
    id: "link-id",
    publicId: "abcdefghijklmnopqrstuvwx",
    digestId: "digest-id",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    digest: {
      items: [{
        trackedCase: {
          caseType: "SERVICE_ORDER",
          businessNumber: "20905",
          deviceName: "Aparat USG",
          manufacturer: null,
          model: null,
          serialNumber: null,
          inventoryNumber: null,
          currentStatus: "Naprawa zakończona",
          faultDescription: null,
          inspectionDueDate: null,
          inspectionScheduledDate: null,
          inspectionBookingStatus: null,
          events: [],
        },
      }],
    },
  };
}

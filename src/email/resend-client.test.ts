import { describe, expect, it } from "vitest";
import {
  PRODUCTION_EMAIL_BCC,
  withProductionBcc,
  type EmailProvider,
  type ProviderEmailRequest,
} from "./resend-client.js";

describe("production provider recipient policy", () => {
  it("adds the mandatory BCC centrally to template and raw HTML requests", async () => {
    const requests: ProviderEmailRequest[] = [];
    const provider: EmailProvider = {
      async send(request) {
        requests.push(request);
        return { ok: true, id: "message-1" };
      },
    };
    const production = withProductionBcc(provider);

    await production.send(request("client@example.com"));
    await production.send({
      ...request("other@example.com"),
      from: "Tiemed <sender@example.com>",
      subject: "Raw message",
      html: "<p>Raw message</p>",
    });

    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.bcc?.includes(PRODUCTION_EMAIL_BCC))).toBe(true);
  });

  it("deduplicates TO, CC and BCC case-insensitively", async () => {
    const requests: ProviderEmailRequest[] = [];
    const production = withProductionBcc({
      async send(request) {
        requests.push(request);
        return { ok: true, id: "message-1" };
      },
    });

    await production.send({
      ...request("Client@Example.com"),
      cc: ["client@example.com", "copy@example.com", "COPY@example.com"],
      bcc: [PRODUCTION_EMAIL_BCC.toUpperCase()],
    });

    expect(requests[0]).toMatchObject({
      to: "client@example.com",
      cc: ["copy@example.com"],
      bcc: [PRODUCTION_EMAIL_BCC],
    });
  });
});

function request(to: string): ProviderEmailRequest {
  return {
    to,
    template: { id: "template", variables: {} },
    idempotencyKey: `key-${to}`,
  };
}

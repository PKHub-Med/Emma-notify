import { Resend } from "resend";

export type ProviderEmailRequest = {
  from?: string;
  to: string;
  replyTo?: string;
  subject?: string;
  template: {
    id: string;
    variables: Record<string, string>;
  };
  idempotencyKey: string;
};

export type ProviderEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: { name: string; statusCode: number | null } };

export interface EmailProvider {
  send(request: ProviderEmailRequest): Promise<ProviderEmailResult>;
}

export function createResendClient(apiKey: string | null): EmailProvider {
  const resend = new Resend(apiKey ?? "");
  return {
    async send(request) {
      const response = await resend.emails.send(
        {
          to: request.to,
          ...(request.from ? { from: request.from } : {}),
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          ...(request.subject ? { subject: request.subject } : {}),
          template: request.template,
        },
        { idempotencyKey: request.idempotencyKey },
      );
      if (response.error) {
        return {
          ok: false,
          error: {
            name: response.error.name,
            statusCode: response.error.statusCode,
          },
        };
      }
      return { ok: true, id: response.data.id };
    },
  };
}

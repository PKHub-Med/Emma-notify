import { Resend } from "resend";
import { normalizeEmail } from "../shared/normalize-email.js";

export const PRODUCTION_EMAIL_BCC = "isf.cobra@gmail.com";

export type TemplateVariableValue = string | number;

export type ProviderEmailRequest = {
  from?: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  template: {
    id: string;
    variables: Record<string, TemplateVariableValue>;
  };
  html?: string;
  text?: string;
  idempotencyKey: string;
};

export type ProviderEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: { name: string; statusCode: number | null } };

export interface EmailProvider {
  send(request: ProviderEmailRequest): Promise<ProviderEmailResult>;
}

/** Enforces the production audit copy at the single provider boundary. */
export function withProductionBcc(provider: EmailProvider): EmailProvider {
  return {
    send(request) {
      return provider.send(withDeduplicatedRecipients({
        ...request,
        bcc: [...recipientList(request.bcc), PRODUCTION_EMAIL_BCC],
      }));
    },
  };
}

export function withDeduplicatedRecipients(
  request: ProviderEmailRequest,
): ProviderEmailRequest {
  const seen = new Set<string>();
  const unique = (values: readonly string[]) => values.flatMap((value) => {
    const normalized = normalizeEmail(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
  const to = unique([request.to]);
  const cc = unique(recipientList(request.cc));
  const bcc = unique(recipientList(request.bcc));
  if (to.length !== 1) throw new Error("EMAIL_TO_INVALID");
  const { cc: _cc, bcc: _bcc, ...base } = request;
  return {
    ...base,
    to: to[0]!,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
  };
}

export function createResendClient(apiKey: string | null): EmailProvider {
  const resend = new Resend(apiKey ?? "");
  return {
    async send(request) {
      if (request.html && (!request.from || !request.subject)) {
        throw new Error("Raw HTML email requires from and subject");
      }
      const recipients = withDeduplicatedRecipients(request);
      const message = request.html
        ? {
          from: request.from!,
          to: recipients.to,
          ...(recipients.cc ? { cc: recipients.cc } : {}),
          ...(recipients.bcc ? { bcc: recipients.bcc } : {}),
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          subject: request.subject!,
          html: request.html,
          ...(request.text ? { text: request.text } : {}),
        }
        : {
          to: recipients.to,
          ...(recipients.cc ? { cc: recipients.cc } : {}),
          ...(recipients.bcc ? { bcc: recipients.bcc } : {}),
          ...(request.from ? { from: request.from } : {}),
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          ...(request.subject ? { subject: request.subject } : {}),
          template: request.template,
        };
      const response = await resend.emails.send(
        message,
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

function recipientList(value: string | readonly string[] | undefined): string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : [...value];
}

import { z } from "zod";

export const accessLinkSigningSecretSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") >= 32,
  { message: "must contain at least 32 bytes" },
);

export const publicBaseUrlSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    context.addIssue({ code: "custom", message: "must be a public HTTPS URL" });
    return z.NEVER;
  }
  return value.replace(/\/+$/, "");
});

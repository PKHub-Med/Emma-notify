import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiKey = process.env.RESEND_API_KEY?.trim();
if (!apiKey) {
  console.error("RESEND_API_KEY is required.");
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templateDir = join(root, "resend-templates");
const from = "Tiemed <powiadomienia@emmamed.com>";

const templates = [
  {
    alias: "emma-repair-received",
    file: "emma-repair-received.html",
    subject: "{{{EMAIL_TITLE}}}",
    numberVariables: ["REPAIR_COUNT"],
    extraVariables: [
      "REPAIR_COUNT", "CASE_NUMBER", "CLIENT_ORDER_NUMBER", "REPORTED_AT",
      "COMPLETED_AT", "DEVICE_NAME", "MANUFACTURER_MODEL", "SERIAL_NUMBER",
      "INVENTORY_NUMBER", "REPAIR_STATUS", "DEVICE_STATUS",
    ],
  },
  {
    alias: "emma-repair-completed",
    file: "emma-repair-completed.html",
    subject: "{{{EMAIL_TITLE}}}",
    numberVariables: ["REPAIR_COUNT"],
    extraVariables: [
      "REPAIR_COUNT", "CASE_NUMBER", "CLIENT_ORDER_NUMBER", "REPORTED_AT",
      "COMPLETED_AT", "DEVICE_NAME", "MANUFACTURER_MODEL", "SERIAL_NUMBER",
      "INVENTORY_NUMBER", "REPAIR_STATUS", "DEVICE_STATUS",
    ],
  },
  {
    alias: "emma-repair-delayed-parts-phase1",
    file: "emma-repair-delayed-parts-phase1.html",
    subject: "Oczekiwanie na części · Sprawa {{{CASE_NUMBER}}}",
  },
  {
    alias: "emma-inspection-confirmed",
    file: "emma-inspection-confirmed.html",
    subject: "Potwierdzony termin wizyty · {{{VISIT_DATE}}}",
    numberVariables: ["DEVICE_COUNT"],
  },
  {
    alias: "emma-inspection-proposed",
    file: "emma-inspection-proposed.html",
    subject: "Proponowany termin wizyty · {{{VISIT_DATE}}}",
    numberVariables: ["DEVICE_COUNT"],
  },
  {
    alias: "emma-inspection-reminder",
    file: "emma-inspection-reminder.html",
    subject: "Przypomnienie o zaplanowanym przeglądzie · {{{VISIT_DATE}}}",
    numberVariables: ["DEVICE_COUNT"],
  },
  {
    alias: "emma-inspection-summary",
    file: "emma-inspection-summary.html",
    subject: "Podsumowanie przeglądów · {{{VISIT_DATE}}}",
  },
];

const variablePattern = /\{\{\{([A-Z0-9_]+)\}\}\}/g;
const MAX_TEMPLATE_VARIABLES = 50;

function variablesFor(template, html) {
  const keys = new Set(template.extraVariables ?? []);
  for (const source of [html, template.subject]) {
    for (const match of source.matchAll(variablePattern)) keys.add(match[1]);
  }
  const numberVariables = new Set(template.numberVariables ?? []);
  return [...keys].sort().map((key) => ({
    key,
    type: numberVariables.has(key) ? "number" : "string",
  }));
}

async function resend(path, init = {}) {
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
  }
  return body;
}

for (const template of templates) {
  const html = await readFile(join(templateDir, template.file), "utf8");
  const variables = variablesFor(template, html);
  if (variables.length > MAX_TEMPLATE_VARIABLES) {
    throw new Error(`${template.alias} uses ${variables.length} variables; Resend allows ${MAX_TEMPLATE_VARIABLES}`);
  }
  console.info(`[resend] update ${template.alias} (${variables.length} vars)`);
  await resend(`/templates/${encodeURIComponent(template.alias)}`, {
    method: "PATCH",
    body: JSON.stringify({ html, subject: template.subject, from, variables }),
  });
  console.info(`[resend] publish ${template.alias}`);
  await resend(`/templates/${encodeURIComponent(template.alias)}/publish`, {
    method: "POST",
  });
}

console.info(`[resend] synced and published ${templates.length} templates`);

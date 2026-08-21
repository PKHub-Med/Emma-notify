param(
    [ValidateRange(1, 365)]
    [int]$Days = 30,

    [switch]$Apply
)

$ErrorActionPreference = "Continue"
$RepoPath = "C:\Users\pawel\Documents\GitHub\Emma-notify"

if (-not (Test-Path $RepoPath)) {
    Write-Host "ERROR: Nie znaleziono repo: $RepoPath" -ForegroundColor Red
    exit 1
}

Set-Location $RepoPath

$mode = if ($Apply) { "apply" } else { "dry-run" }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " EMMA - TARGETED INSPECTION DURATION BACKFILL" -ForegroundColor Cyan
Write-Host " MODE: $mode | LAST $Days DAYS" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Zakres zapisu: TYLKO TrackedCase.sourceSnapshot.estimatedDurationSeconds" -ForegroundColor Green
Write-Host "Typ rekordu: TYLKO INSPECTION" -ForegroundColor Green
Write-Host "Airtable: READ ONLY, tylko pole estimatedDuration" -ForegroundColor Green
Write-Host "Zdjecia/attachmenty/dokumenty: NIE SA POBIERANE" -ForegroundColor Green
Write-Host "CommunicationEvent/delivery/task/device: NIE SA MODYFIKOWANE" -ForegroundColor Green
Write-Host ""

$script = @'
const cwd = process.cwd();

const { createPrismaClient } = await import(
  "file://" + cwd + "/dist/db/prisma.js"
);
const { AirtableClient } = await import(
  "file://" + cwd + "/dist/airtable/client.js"
);
const {
  AIRTABLE_TABLE_IDS,
  INSPECTION_FIELDS
} = await import(
  "file://" + cwd + "/dist/airtable/field-ids.js"
);

const mode = process.argv[2] ?? "dry-run";
const days = Number(process.argv[3] ?? 30);

if (!["dry-run", "apply"].includes(mode)) {
  throw new Error(`INVALID_MODE:${mode}`);
}
if (!Number.isInteger(days) || days < 1 || days > 365) {
  throw new Error(`INVALID_DAYS:${process.argv[3]}`);
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}
if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_PAT) {
  throw new Error("AIRTABLE_BASE_ID / AIRTABLE_PAT missing");
}

const prisma = createPrismaClient(process.env.DATABASE_URL);
const airtable = new AirtableClient({
  baseId: process.env.AIRTABLE_BASE_ID,
  personalAccessToken: process.env.AIRTABLE_PAT
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function existingDuration(snapshot) {
  return parseDuration(obj(snapshot).estimatedDurationSeconds);
}

async function fetchDuration(recordId) {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // fetchRecord receives an explicit list containing ONLY the one field.
      // No attachment/photo/document fields are requested.
      const record = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.inspections,
        recordId,
        [INSPECTION_FIELDS.estimatedDuration]
      );

      return {
        ok: true,
        value: parseDuration(
          record.fields[INSPECTION_FIELDS.estimatedDuration]
        )
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const retryable =
        text.includes("429") ||
        text.includes("RATE_LIMIT") ||
        text.includes("503") ||
        text.includes("502") ||
        text.includes("504");

      if (!retryable || attempt === MAX_ATTEMPTS) {
        return { ok: false, error: text };
      }

      await sleep(500 * attempt);
    }
  }

  return { ok: false, error: "UNKNOWN_FETCH_ERROR" };
}

const stats = {
  mode,
  days,
  cutoff: cutoff.toISOString(),
  recentInDatabase: 0,
  alreadyHasDuration: 0,
  needsAirtableRead: 0,
  sourcePresent: 0,
  sourceMissing: 0,
  wouldUpdate: 0,
  updated: 0,
  unchanged: 0,
  failedReads: 0,
  failedWrites: 0
};

try {
  const rows = await prisma.trackedCase.findMany({
    where: {
      caseType: "INSPECTION",
      sourceModifiedAt: { gte: cutoff }
    },
    select: {
      airtableRecordId: true,
      sourceModifiedAt: true,
      sourceSnapshot: true
    },
    orderBy: [
      { sourceModifiedAt: "asc" },
      { airtableRecordId: "asc" }
    ]
  });

  stats.recentInDatabase = rows.length;

  const missing = [];

  for (const row of rows) {
    if (existingDuration(row.sourceSnapshot) !== null) {
      stats.alreadyHasDuration++;
    } else {
      missing.push(row);
    }
  }

  stats.needsAirtableRead = missing.length;

  console.log("");
  console.log("=== PREFLIGHT ===");
  console.log("Mode:", mode);
  console.log("Days:", days);
  console.log("Cutoff:", cutoff.toISOString());
  console.log("Recent INSPECTION in DB:", stats.recentInDatabase);
  console.log("Already has duration:", stats.alreadyHasDuration);
  console.log("Needs Airtable read:", stats.needsAirtableRead);
  console.log("");

  for (let index = 0; index < missing.length; index++) {
    const row = missing[index];

    // Stay below Airtable's normal per-base request rate.
    if (index > 0) {
      await sleep(240);
    }

    const result = await fetchDuration(row.airtableRecordId);

    if (!result.ok) {
      stats.failedReads++;
      console.log(
        `READ_FAIL ${row.airtableRecordId} ${result.error}`
      );
      continue;
    }

    if (result.value === null) {
      stats.sourceMissing++;
      console.log(
        `SOURCE_MISSING ${row.airtableRecordId}`
      );
      continue;
    }

    stats.sourcePresent++;
    stats.wouldUpdate++;

    if (mode === "dry-run") {
      console.log(
        `WOULD_UPDATE ${row.airtableRecordId} duration=${result.value}`
      );
      continue;
    }

    const snapshot = obj(row.sourceSnapshot);

    try {
      await prisma.trackedCase.update({
        where: {
          caseType_airtableRecordId: {
            caseType: "INSPECTION",
            airtableRecordId: row.airtableRecordId
          }
        },
        data: {
          sourceSnapshot: {
            ...snapshot,
            estimatedDurationSeconds: result.value
          }
        }
      });

      stats.updated++;
      console.log(
        `UPDATED ${row.airtableRecordId} duration=${result.value}`
      );
    } catch (error) {
      stats.failedWrites++;
      console.log(
        `WRITE_FAIL ${row.airtableRecordId} ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(stats, null, 2));

  if (stats.failedWrites > 0) {
    process.exitCode = 2;
  } else if (stats.failedReads > 0) {
    process.exitCode = 3;
  }
} finally {
  await prisma.$disconnect();
}
'@

$b64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($script)
)

$remote = "'echo $b64 | base64 -d > /tmp/emma-duration-backfill.mjs && /mise/shims/node /tmp/emma-duration-backfill.mjs $mode $Days'"

railway ssh -- sh -lc $remote
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "KONIEC: $mode zakonczony bez bledow." -ForegroundColor Green
} else {
    Write-Host "KONIEC: $mode zakonczony z exit code $exitCode." -ForegroundColor Yellow
}

exit $exitCode

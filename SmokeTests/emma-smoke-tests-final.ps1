param(
    [ValidateRange(1, 365)]
    [int]$WindowDays = 30
)

# Railway CLI writes informational SSH messages to stderr on Windows.
# Keep native stderr non-terminating and inspect exit codes explicitly.
$ErrorActionPreference = "Continue"

$RepoPath = "C:\Users\pawel\Documents\GitHub\Emma-notify"

if (-not (Test-Path $RepoPath)) {
    Write-Host "ERROR: Nie znaleziono repo: $RepoPath" -ForegroundColor Red
    exit 1
}

Set-Location $RepoPath

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " EMMA - FINAL SMOKE TESTS" -ForegroundColor Cyan
Write-Host " RANDOM WINDOW: LAST $WindowDays DAYS" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

function Get-RailwayEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = railway ssh -- printenv $Name 2>$null | Select-Object -Last 1
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        Write-Host "STOP: Nie udalo sie odczytac $Name z Railway (exit=$code)." -ForegroundColor Red
        exit $code
    }

    if ($null -eq $value) {
        return ""
    }

    return ([string]$value).Trim()
}

# ---------------------------------------------------------------------------
# SAFETY PREFLIGHT
# ---------------------------------------------------------------------------

$emailMode = Get-RailwayEnvValue "EMAIL_MODE"
$emailsEnabled = Get-RailwayEnvValue "COMMUNICATION_EMAILS_ENABLED"
$testEmail = Get-RailwayEnvValue "TEST_EMAIL"

Write-Host "EMAIL_MODE: $emailMode"
Write-Host "COMMUNICATION_EMAILS_ENABLED: $emailsEnabled"
Write-Host "TEST_EMAIL: $testEmail"
Write-Host "WINDOW_DAYS: $WindowDays"
Write-Host ""

if ($emailMode -ne "TEST") {
    Write-Host "STOP: EMAIL_MODE nie jest TEST." -ForegroundColor Red
    exit 1
}

if ($emailsEnabled -ne "true") {
    Write-Host "STOP: COMMUNICATION_EMAILS_ENABLED nie jest true." -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($testEmail)) {
    Write-Host "STOP: TEST_EMAIL nie jest ustawiony." -ForegroundColor Red
    exit 1
}

Write-Host "Safety check OK." -ForegroundColor Green
Write-Host "Wiadomosci powinny byc przekierowane przez EMAIL_MODE=TEST na TEST_EMAIL." -ForegroundColor Green
Write-Host "Tester NIE zapisuje nic do Airtable." -ForegroundColor Green
Write-Host "Tester NIE uzupelnia sztucznie estimatedDurationSeconds." -ForegroundColor Green
Write-Host "Kazdy scenariusz jest probowany niezaleznie od wyniku poprzedniego." -ForegroundColor Green
Write-Host ""
Write-Host "Dobor kandydatow:" -ForegroundColor DarkGray
Write-Host " - naprawy: SERVICE_ORDER.sourceModifiedAt >= cutoff" -ForegroundColor DarkGray
Write-Host " - przeglady: linked INSPECTION.sourceModifiedAt >= cutoff" -ForegroundColor DarkGray
Write-Host " - fallback dla taskow: TASK.firstSeenAt >= cutoff" -ForegroundColor DarkGray
Write-Host " - najpierw exact business state/template, potem bezpieczny generic fallback" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------
# REMOTE NODE RUNNER
# ---------------------------------------------------------------------------

$script = @'
const { createPrismaClient } = await import(
  "file://" + process.cwd() + "/dist/db/prisma.js"
);

if (process.env.EMAIL_MODE !== "TEST") {
  throw new Error("STOP: EMAIL_MODE != TEST");
}
if (process.env.COMMUNICATION_EMAILS_ENABLED !== "true") {
  throw new Error("STOP: COMMUNICATION_EMAILS_ENABLED != true");
}
if (!process.env.TEST_EMAIL) {
  throw new Error("STOP: TEST_EMAIL missing");
}

const scenario = process.argv[2];
const WINDOW_DAYS = Number(process.argv[3] ?? 30);

if (!Number.isInteger(WINDOW_DAYS) || WINDOW_DAYS < 1 || WINDOW_DAYS > 365) {
  throw new Error(`INVALID_WINDOW_DAYS:${process.argv[3]}`);
}

const CONFIG = {
  REPAIR_RECEIVED: {
    source: "SERVICE_ORDER",
    state: "Diagnostyka",
    template: "Naprawa-zmiana_stanu"
  },
  REPAIR_DELAYED_PARTS: {
    source: "SERVICE_ORDER",
    state: "Oczekiwanie na części",
    template: "Naprawa-zmiana_stanu"
  },
  REPAIR_COMPLETED: {
    source: "SERVICE_ORDER",
    state: "Naprawa zakończona",
    template: "Naprawa-zmiana_stanu"
  },
  INSPECTION_DATE_PROPOSED: {
    source: "TASK",
    state: "Poinformowano o wizycie",
    template: "Przegląd-informacja_o_nadchodzącej_wizycie"
  },
  INSPECTION_DATE_CONFIRMED: {
    source: "TASK",
    state: "Ustalono termin wizyty",
    template: "Przegląd-informacja_o_umówionej_wizycie"
  },
  INSPECTION_REMINDER: {
    source: "TASK",
    state: "Przypomnienie o wizycie",
    template: "Przegląd-przypomnienie_o_wizycie"
  },
  INSPECTION_COMPLETED: {
    source: "TASK",
    state: "Zakończono przegląd",
    template: "Przegląd-podsumowanie_wizyty"
  }
};

const cfg = CONFIG[scenario];

if (!cfg) {
  throw new Error(
    "UNKNOWN_SCENARIO. Allowed: " + Object.keys(CONFIG).join(", ")
  );
}

const prisma = createPrismaClient(process.env.DATABASE_URL);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const cutoff = new Date(Date.now() - WINDOW_MS);

function pickRandom(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function isRecentDate(value) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() >= cutoff.getTime();
}

function arr(v) {
  return Array.isArray(v)
    ? v.filter(x => typeof x === "string" && x.trim())
    : [];
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function inconsistentInspection(i) {
  if (!i.inspectionPerformedAt) return false;

  const status = (i.currentStatus ?? "").trim().toUpperCase();

  return /^(DO REALIZACJI|DO WYKONANIA|PLANOWAN|ZAPLANOWAN)/.test(status);
}

function recognizedResult(v) {
  const s = (v ?? "").trim().toUpperCase();

  return (
    s.includes("NIESPRAW") ||
    s.includes("WARUNK") ||
    s === "SPRAWNY" ||
    s.startsWith("SPRAWNY ")
  );
}

// ---------------------------------------------------------------------------
// SERVICE ORDERS
// ---------------------------------------------------------------------------

async function findServiceOrder() {
  const baseWhere = {
    caseType: "SERVICE_ORDER",
    active: true,
    sourceHospitalRecordId: { not: null },
    sourceModifiedAt: { gte: cutoff }
  };

  const include = {
    recipients: {
      where: { eligible: true },
      select: { airtableContactRecordId: true }
    },
    devices: {
      select: { deviceAirtableId: true }
    }
  };

  const exactRows = await prisma.trackedCase.findMany({
    where: {
      ...baseWhere,
      emmaCustomerStatus: cfg.state,
      emmaMailTemplate: cfg.template
    },
    include,
    orderBy: { sourceModifiedAt: "desc" },
    take: 1000
  });

  const exactCandidates = exactRows.filter(r =>
    r.businessNumber &&
    r.deviceName &&
    r.recipients.length > 0
  );

  let record = pickRandom(exactCandidates);
  let exactMatch = true;
  let poolSize = exactCandidates.length;

  if (!record) {
    const genericRows = await prisma.trackedCase.findMany({
      where: baseWhere,
      include,
      orderBy: { sourceModifiedAt: "desc" },
      take: 1000
    });

    const genericCandidates = genericRows.filter(r =>
      r.businessNumber &&
      r.deviceName &&
      r.recipients.length > 0
    );

    record = pickRandom(genericCandidates);
    exactMatch = false;
    poolSize = genericCandidates.length;
  }

  if (!record) {
    throw new Error(
      `NO_SAFE_SERVICE_ORDER_CANDIDATE_IN_LAST_${WINDOW_DAYS}_DAYS`
    );
  }

  const source = obj(record.sourceSnapshot);
  const contactId = record.recipients[0].airtableContactRecordId;
  const deviceId = record.devices[0]?.deviceAirtableId ?? null;

  return {
    sourceRecordId: record.airtableRecordId,
    exactMatch,
    poolSize,
    recentAt: record.sourceModifiedAt?.toISOString() ?? null,
    recentBy: "SERVICE_ORDER.sourceModifiedAt",
    description:
      `Sprawa ${record.businessNumber} / ${record.deviceName} / ` +
      `modified ${record.sourceModifiedAt?.toISOString() ?? "?"}`,
    snapshot: {
      sourceEntityType: "SERVICE_ORDER",
      sourceRecordId: record.airtableRecordId,
      scenario,
      emmaCustomerStatus: cfg.state,
      emmaMailTemplate: cfg.template,

      businessNumber: record.businessNumber,
      clientOrderNumber: record.clientOrderNumber,

      reportedAt: record.reportedAt?.toISOString() ?? null,
      reportedAtRaw: source.reportedAtRaw ?? null,
      completedAt: source.completedAt ?? null,
      department: source.department ?? null,

      currentStatus: record.currentStatus,
      serviceOrderType: record.serviceOrderType,
      hospitalName: record.hospitalName,
      sourceHospitalRecordId: record.sourceHospitalRecordId,

      contactRecordIds: [contactId],

      device: {
        airtableRecordId: deviceId,
        name: record.deviceName,
        manufacturer: record.manufacturer,
        model: record.model,
        serialNumber: record.serialNumber,
        inventoryNumber: record.inventoryNumber
      },

      manualSmokeTest: true,
      smokeWindowDays: WINDOW_DAYS
    }
  };
}

// ---------------------------------------------------------------------------
// INSPECTION TASKS
// ---------------------------------------------------------------------------

async function findTask() {
  const preferred = await prisma.trackedTask.findMany({
    where: {
      active: true,
      sourceHospitalRecordId: { not: null },
      emmaCustomerStatus: cfg.state,
      emmaMailTemplate: cfg.template
    },
    orderBy: { updatedAt: "desc" },
    take: 1000
  });

  const generic = await prisma.trackedTask.findMany({
    where: {
      active: true,
      sourceHospitalRecordId: { not: null }
    },
    orderBy: { updatedAt: "desc" },
    take: 1000
  });

  async function collect(tasks) {
    const shuffled = [...tasks].sort(() => Math.random() - 0.5);
    const candidates = [];

    for (const task of shuffled) {
      const ids = arr(task.linkedInspectionRecordIds);
      const contacts = arr(task.selectedContactRecordIds);

      if (!task.day || !ids.length || !contacts.length) continue;

      // Keep smoke payloads compact. Large-list behavior is covered elsewhere.
      if (ids.length > 30) continue;

      const inspections = await prisma.trackedCase.findMany({
        where: {
          caseType: "INSPECTION",
          active: true,
          airtableRecordId: { in: ids }
        },
        select: {
          airtableRecordId: true,
          sourceHospitalRecordId: true,
          currentStatus: true,
          sourceModifiedAt: true,
          inspectionPerformedAt: true,
          inspectionResult: true
        }
      });

      // Task must point only to currently tracked active inspections.
      if (inspections.length !== ids.length) continue;

      // Tenant / hospital consistency.
      if (
        inspections.some(
          i => i.sourceHospitalRecordId !== task.sourceHospitalRecordId
        )
      ) {
        continue;
      }

      if (inspections.some(inconsistentInspection)) continue;

      // Summary mail needs usable inspection results.
      if (
        scenario === "INSPECTION_COMPLETED" &&
        inspections.some(i => !recognizedResult(i.inspectionResult))
      ) {
        continue;
      }

      const recentInspectionDates = inspections
        .map(i => i.sourceModifiedAt)
        .filter(isRecentDate)
        .sort((a, b) => b.getTime() - a.getTime());

      const taskFirstSeenRecent = isRecentDate(task.firstSeenAt);

      if (!taskFirstSeenRecent && recentInspectionDates.length === 0) {
        continue;
      }

      const recentAt = recentInspectionDates[0] ?? task.firstSeenAt;
      const recentBy = recentInspectionDates.length
        ? "linked INSPECTION.sourceModifiedAt"
        : "TASK.firstSeenAt";

      candidates.push({
        task,
        inspections,
        recentAt,
        recentBy
      });
    }

    return candidates;
  }

  let candidates = await collect(preferred);
  let exactMatch = true;

  if (!candidates.length) {
    candidates = await collect(generic);
    exactMatch = false;
  }

  const selectedCandidate = pickRandom(candidates);

  if (!selectedCandidate) {
    throw new Error(
      `NO_SAFE_TASK_CANDIDATE_IN_LAST_${WINDOW_DAYS}_DAYS`
    );
  }

  const { task, recentAt, recentBy } = selectedCandidate;
  const ids = arr(task.linkedInspectionRecordIds);
  const contacts = arr(task.selectedContactRecordIds);
  const source = obj(task.sourceSnapshot);

  return {
    sourceRecordId: task.airtableRecordId,
    exactMatch,
    poolSize: candidates.length,
    recentAt: recentAt?.toISOString() ?? null,
    recentBy,
    description:
      `Task ${task.airtableRecordId} / ${ids.length} przegladow / ${task.day} / ` +
      `recent ${recentAt?.toISOString() ?? "?"}`,
    snapshot: {
      sourceEntityType: "TASK",
      sourceRecordId: task.airtableRecordId,
      taskNumber: task.taskNumber,
      scenario,
      emmaCustomerStatus: cfg.state,
      emmaMailTemplate: cfg.template,

      day: task.day,
      department: source.department ?? null,
      durationSeconds: source.durationSeconds ?? null,
      completed: task.completed,

      // One logical hospital contact is enough; EMAIL_MODE=TEST controls
      // the physical destination.
      selectedContactRecordIds: [contacts[0]],

      sourceHospitalRecordId: task.sourceHospitalRecordId,
      linkedInspectionRecordIds: task.linkedInspectionRecordIds,
      linkedServiceOrderRecordIds: task.linkedServiceOrderRecordIds,
      performerRecordIds: task.performerRecordIds,

      manualSmokeTest: true,
      smokeWindowDays: WINDOW_DAYS
    }
  };
}

// ---------------------------------------------------------------------------
// CREATE EVENT -> WAIT RECIPIENT -> FORCE DELIVERY READY -> WAIT RESULT
// ---------------------------------------------------------------------------

try {
  const selected =
    cfg.source === "SERVICE_ORDER"
      ? await findServiceOrder()
      : await findTask();

  const now = new Date();

  const event = await prisma.communicationEvent.create({
    data: {
      sourceEntityType: cfg.source,
      sourceRecordId: selected.sourceRecordId,
      scenario,
      fingerprint:
        `MANUAL_SMOKE:${scenario}:${selected.sourceRecordId}:${Date.now()}`,
      detectedAt: now,
      eventSnapshot: {
        ...selected.snapshot,
        detectedAt: now.toISOString()
      }
    }
  });

  console.log("");
  console.log("=== EMMA SMOKE TEST ===");
  console.log("Scenario:", scenario);
  console.log(
    "Window:",
    `last ${WINDOW_DAYS} days since ${cutoff.toISOString()}`
  );
  console.log("Event ID:", event.id);
  console.log("Source:", selected.sourceRecordId);
  console.log("Candidate:", selected.description);
  console.log("Random pool size:", selected.poolSize);
  console.log("Recent signal:", selected.recentBy, selected.recentAt ?? "-");
  console.log(
    "Business state:",
    selected.exactMatch ? "EXACT MATCH" : "SIMULATED ON SAFE RECORD"
  );
  console.log("Recipient mode: TEST_EMAIL");
  console.log("Airtable writes: ZERO");
  console.log("");

  let recipient = null;

  // Wait max 120 seconds for normal recipient resolution by the Worker.
  for (let i = 0; i < 60; i++) {
    const current = await prisma.communicationEvent.findUnique({
      where: { id: event.id },
      include: {
        recipients: true
      }
    });

    recipient =
      current?.recipients.find(
        r =>
          r.resolutionStatus === "READY" ||
          r.resolutionStatus === "FALLBACK"
      ) ?? null;

    if (recipient) break;
    await sleep(2000);
  }

  if (!recipient) {
    throw new Error("RECIPIENT_NOT_RESOLVED_WITHIN_120_SECONDS");
  }

  console.log(
    "Recipient resolution:",
    recipient.resolutionStatus,
    recipient.resolutionReason ?? ""
  );

  // Smoke only: make this delivery immediately ready.
  const readyAt = new Date();

  let delivery = await prisma.communicationDelivery.findUnique({
    where: {
      communicationEventRecipientId: recipient.id
    }
  });

  if (!delivery) {
    delivery = await prisma.communicationDelivery.create({
      data: {
        communicationEventId: event.id,
        communicationEventRecipientId: recipient.id,
        scenario,
        status: "READY",
        scheduledFor: readyAt,
        readyAt,
        deliveryKey: `${event.id}:${recipient.id}`,
        scheduleReason:
          scenario === "INSPECTION_REMINDER"
            ? "REMINDER_0600"
            : "EVENT_DRIVEN"
      }
    });
  } else if (
    delivery.status === "SCHEDULED" ||
    delivery.status === "CANCELLED"
  ) {
    delivery = await prisma.communicationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "READY",
        scheduledFor: readyAt,
        readyAt,
        cancelReason: null,
        nextRetryAt: null
      }
    });
  }

  await prisma.communicationEvent.update({
    where: { id: event.id },
    data: { processedAt: readyAt }
  });

  console.log("Delivery ID:", delivery.id);
  console.log("Delivery prepared for immediate smoke test.");

  let finalDelivery = delivery;

  // Wait max 120 seconds for final delivery state.
  for (let i = 0; i < 60; i++) {
    finalDelivery = await prisma.communicationDelivery.findUnique({
      where: { id: delivery.id }
    });

    if (
      finalDelivery &&
      ["SENT", "FAILED", "CANCELLED"].includes(finalDelivery.status)
    ) {
      break;
    }

    await sleep(2000);
  }

  console.log("");
  console.log("=== FINAL RESULT ===");
  console.log("Status:", finalDelivery?.status ?? "UNKNOWN");
  console.log(
    "Actual recipient:",
    finalDelivery?.actualRecipientEmail ?? "-"
  );
  console.log("Resend ID:", finalDelivery?.resendMessageId ?? "-");
  console.log("Error:", finalDelivery?.lastError ?? "-");
  console.log("");

  if (finalDelivery?.status !== "SENT") {
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}
'@

$b64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($script)
)

$scenarios = @(
    "REPAIR_RECEIVED",
    "REPAIR_DELAYED_PARTS",
    "REPAIR_COMPLETED",
    "INSPECTION_DATE_PROPOSED",
    "INSPECTION_DATE_CONFIRMED",
    "INSPECTION_REMINDER",
    "INSPECTION_COMPLETED"
)

$results = @()

foreach ($scenario in $scenarios) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " SMOKE TEST: $scenario" -ForegroundColor Cyan
    Write-Host " WINDOW: LAST $WindowDays DAYS" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""

    $remote = "'echo $b64 | base64 -d > /tmp/emma-smoke-runner.mjs && /mise/shims/node /tmp/emma-smoke-runner.mjs $scenario $WindowDays'"

    $output = railway ssh -- sh -lc $remote 2>&1
    $exitCode = $LASTEXITCODE

    $output | ForEach-Object { Write-Host $_ }

    $joined = $output -join "`n"
    $sent = $joined -match "Status:\s*SENT"

    $failureReason = ""

    if (-not $sent) {
        if ($joined -match "(NO_SAFE_[A-Z0-9_]+)") {
            $failureReason = $Matches[1]
        } elseif ($joined -match "Error:\s*(.+)") {
            $failureReason = $Matches[1].Trim()
        } elseif ($exitCode -ne 0) {
            $failureReason = "REMOTE_EXIT_$exitCode"
        } else {
            $failureReason = "NOT_SENT"
        }
    }

    $results += [PSCustomObject]@{
        Scenario = $scenario
        Sent = $sent
        ExitCode = $exitCode
        Reason = $failureReason
    }

    if (-not $sent -or $exitCode -ne 0) {
        Write-Host ""
        Write-Host "FAIL: $scenario nie zakonczyl sie statusem SENT." -ForegroundColor Red

        if (-not [string]::IsNullOrWhiteSpace($failureReason)) {
            Write-Host "Reason: $failureReason" -ForegroundColor Yellow
        }

        Write-Host "Kontynuuje z kolejnym scenariuszem..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
        continue
    }

    Write-Host ""
    Write-Host "OK: $scenario -> SENT" -ForegroundColor Green
    Start-Sleep -Seconds 5
}

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " PODSUMOWANIE - FINAL SMOKE TESTS" -ForegroundColor Cyan
Write-Host " WINDOW: LAST $WindowDays DAYS" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$results | Format-Table -AutoSize

$failedCount = @(
    $results | Where-Object {
        -not $_.Sent -or $_.ExitCode -ne 0
    }
).Count

$sentCount = @(
    $results | Where-Object {
        $_.Sent -and $_.ExitCode -eq 0
    }
).Count

Write-Host ""
Write-Host "Wyslane: $sentCount / $($results.Count)" -ForegroundColor Green

if ($failedCount -gt 0) {
    Write-Host "Nieudane: $failedCount / $($results.Count)" -ForegroundColor Yellow
    Write-Host "Wszystkie scenariusze zostaly mimo to sprobowane." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "SMOKE TEST RESULT: FAIL / PARTIAL" -ForegroundColor Red
    exit 1
}

Write-Host "Nieudane: 0 / $($results.Count)" -ForegroundColor Green
Write-Host "Wszystkie smoke testy zakonczone statusem SENT." -ForegroundColor Green
Write-Host ""
Write-Host "SMOKE TEST RESULT: PASS" -ForegroundColor Green
exit 0

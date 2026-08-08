# Emma Notify

Niezależna usługa przygotowująca dane spraw i odbiorców dla przyszłych powiadomień. Projekt nie zawiera frontendu i nie wysyła wiadomości e-mail.

## Architektura

Jedno repozytorium dostarcza dwa niezależne procesy Railway:

- **API** — Express udostępniający `GET /health`; endpoint sprawdza połączenie z PostgreSQL i zwraca HTTP 503, gdy baza jest niedostępna.
- **Worker** — proces wykonujący jednorazowy baseline Airtable, zapisujący stan instancji `main` i aktualizujący heartbeat co 30 sekund.
- **PostgreSQL** — wspólna baza danych zarządzana przez Prisma. Migracje nie uruchamiają się automatycznie przy starcie procesów.

Airtable jest źródłem bezwzględnie **READ ONLY**. Klient wykonuje wyłącznie zapytania `GET`; aplikacja nigdy nie zapisuje danych do Airtable.

## Baseline Airtable

Worker przy starcie sprawdza `SyncState` dla kontaktów, zleceń serwisowych i przeglądów. Jeżeli wszystkie trzy baseline mają `baselineCompletedAt`, synchronizacja jest pomijana. W przeciwnym razie worker:

1. pobiera kontakty i buduje lookup w pamięci,
2. pobiera oraz upsertuje zlecenia serwisowe,
3. pobiera oraz upsertuje przeglądy,
4. synchronizuje aktualne, bezpośrednio podlinkowane `CaseRecipient`,
5. ustawia `baselineCompletedAt`, `lastSuccessfulSyncAt` i `WorkerState.lastSyncAt`.

Technicznym kluczem jest zawsze Airtable Record ID. Numery zleceń, LP, numery seryjne i inwentarzowe nie są używane jako klucze. Baseline jest idempotentny i nie tworzy `CaseEvent`, `NotificationBuffer` ani `BufferItem`. Nie wysyła również powiadomień.

Odbiorcą może zostać wyłącznie kontakt bezpośrednio podlinkowany na sprawie, dla którego flaga kontaktowa po `trim + uppercase` wynosi `TAK`, a e-mail jest obecny i poprawny. Nie istnieje fallback na e-mail szpitala ani inne pola kontaktowe.

Używane są wyłącznie Table IDs i Field IDs. Table IDs:

| Dane | Table ID |
| --- | --- |
| Zlecenia serwisowe | `tblJSUtmWrc1feldG` |
| Przeglądy | `tblPiDXQXcAWKogIk` |
| Kontakty | `tblOAizKjQYDhIzEx` |
| Urządzenia | `tblnEZZVI2ws2dyx4` |

## Incremental sync i quiet-period watchdog

Po potwierdzeniu zakończonego baseline worker rozpoczyna incremental polling. Dla zleceń serwisowych i przeglądów używa osobnych `SyncState.lastSuccessfulSyncAt`, odejmuje `AIRTABLE_SYNC_OVERLAP_SECONDS` i filtruje Airtable przez `filterByFormula` na odpowiednim Field ID `Last mod Emma`. Overlap może zwrócić rekord ponownie; fingerprint SHA-256 i constraints PostgreSQL zapewniają idempotency.

Na tym etapie monitorowana jest wyłącznie zmiana customer-facing statusu. Każda zmiana tworzy transakcyjnie `CaseEvent`, aktualizuje `TrackedCase`, korzysta z aktualnych eligible `CaseRecipient` i tworzy albo resetuje jeden aktywny `NotificationBuffer` na `normalizedEmail`. `BufferItem` pozostaje unikalny dla pary buffer–case.

Każdy kolejny event ustawia `sendAfter = now + DIGEST_QUIET_MINUTES`. Nie istnieje maksymalny czas oczekiwania ani forced send. Watchdog co 15 sekund wykonuje warunkowy update PostgreSQL i ustawia `READY` wyłącznie dla bufferów nadal `OPEN`, których aktualne `sendAfter <= now`. Następnie czyści `activeRecipientKey`, dzięki czemu przyszły event może utworzyć nowy OPEN buffer. Nadal nie jest tworzony digest i nie jest wysyłany żaden e-mail.

## Wymagania

- Node.js 20.19 lub nowszy
- PostgreSQL

Skopiuj `.env.example` do `.env` i ustaw:

| Zmienna | Znaczenie |
| --- | --- |
| `DATABASE_URL` | Łańcuch połączenia PostgreSQL |
| `AIRTABLE_BASE_ID` | ID bazy Airtable |
| `AIRTABLE_PAT` | Personal Access Token Airtable, wyłącznie z uprawnieniami odczytu |
| `AIRTABLE_POLL_SECONDS` | Odstęp incremental polling; domyślnie `60` |
| `AIRTABLE_SYNC_OVERLAP_SECONDS` | Zakładka checkpointu chroniąca granice timestampów; domyślnie `120` |
| `PORT` | Port API; Railway dostarcza go automatycznie |
| `DIGEST_QUIET_MINUTES` | Czas oczekiwania bufora; domyślnie `1` |
| `TIMEZONE` | Strefa czasowa; domyślnie `Europe/Warsaw` |
| `EMAIL_MODE` | `TEST` albo `PRODUCTION`; obecnie tylko walidowane |
| `TEST_EMAIL` | Adres testowy; obecnie tylko walidowany |
| `PRODUCTION_EMAILS_ENABLED` | Flaga `true`/`false`; obecnie tylko walidowana |
| `LINK_TTL_DAYS` | Ważność przyszłych linków w dniach; domyślnie `30` |

API wymaga tylko `DATABASE_URL`; `PORT` jest opcjonalny i domyślnie wynosi `3000`. Pozostałe niesekretne ustawienia API mają wartości domyślne. API nie odczytuje zmiennych Airtable ani `DIGEST_QUIET_MINUTES`.

Worker wymaga `DATABASE_URL`, `AIRTABLE_BASE_ID` i `AIRTABLE_PAT`. Pozostałe ustawienia workera mają wartości domyślne podane powyżej.

`EMAIL_MODE=TEST` **nie oznacza wysyłania maili**. W tej wersji nie ma konfiguracji dostawcy poczty ani kodu wysyłającego wiadomości.

## Praca lokalna

```bash
npm install
npm run prisma:generate
npm run dev:api
npm run dev:worker
```

Pozostałe komendy:

```bash
npm run build
npm test
npm run prisma:validate
npm run db:migrate:deploy
npm run db:summary
npm run db:inspect-case -- 19103
```

`npm run db:summary` jest diagnostyką tylko do odczytu. Pokazuje wyłącznie agregaty spraw, odbiorców, eventów, wszystkich/OPEN/READY bufferów, najnowszy czas eventu oraz czasy heartbeat/sync workera; nie wyświetla adresów e-mail, nazw kontaktów, tokenów ani rekordów Airtable.

`npm run db:inspect-case -- <businessNumber>` porównuje wszystkie przeglądy o podanym numerze (numer biznesowy nie jest unikalny) z aktualnymi powiązaniami Airtable. Raport jest tylko do odczytu i pokazuje wyłącznie identyfikatory rekordów, statusy, liczniki, przyczyny eligibility oraz flagi `hasEmail`/`hasNormalizedEmail` — bez nazw i adresów e-mail.

## Railway

1. Utwórz usługę PostgreSQL.
2. Utwórz dwie usługi z tego samego repozytorium: API i Worker.
3. W API ustaw `DATABASE_URL`; nie dodawaj do tej usługi sekretów Airtable.
4. W workerze ustaw `DATABASE_URL`, `AIRTABLE_BASE_ID` i `AIRTABLE_PAT`. Token Airtable powinien mieć wyłącznie zakresy odczytu.
5. Przed uruchomieniem nowej wersji wykonaj migrację jednorazowo przez Railway pre-deploy command albo osobny job: `npm run db:migrate:deploy`.
6. Ustaw osobne komendy startowe:

```text
API: npm run start:api
WORKER: npm run start:worker
```

Oba procesy wymagają wcześniejszego kroku build (`npm run build`). Żaden z nich nie uruchamia migracji automatycznie.

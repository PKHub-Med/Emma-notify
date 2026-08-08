# Emma Notify

Fundament niezależnej usługi powiadomień. Projekt nie integruje się jeszcze z istniejącym systemem Emma, nie zawiera frontendu i nie wysyła wiadomości e-mail.

## Architektura

Jedno repozytorium dostarcza dwa niezależne procesy Railway:

- **API** — Express udostępniający `GET /health`; endpoint sprawdza połączenie z PostgreSQL i zwraca HTTP 503, gdy baza jest niedostępna.
- **Worker** — proces zapisujący stan instancji `main` w tabeli `WorkerState` i aktualizujący heartbeat co 30 sekund.
- **PostgreSQL** — wspólna baza danych zarządzana przez Prisma. Migracje nie uruchamiają się automatycznie przy starcie procesów.

Airtable będzie źródłem **READ ONLY**. Obecna wersja nie wykonuje jeszcze synchronizacji ani zapytań do Airtable.

## Wymagania

- Node.js 20.19 lub nowszy
- PostgreSQL

Skopiuj `.env.example` do `.env` i ustaw:

| Zmienna | Znaczenie |
| --- | --- |
| `DATABASE_URL` | Łańcuch połączenia PostgreSQL |
| `AIRTABLE_BASE_ID` | ID bazy Airtable |
| `AIRTABLE_PAT` | Personal Access Token Airtable, wyłącznie z uprawnieniami odczytu |
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
```

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

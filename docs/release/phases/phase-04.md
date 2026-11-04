# Phase 4 — Market reference data

Plan: `docs/architecture/08-implementation-plan.md` §4, Phase 4.

## Slice 1 — reference read surface

`packages/db/src/reference/index.ts` exposes the Market Reference public surface of `00` §5:

- `resolveSymbol` (BR-002). It returns `FOUND`, `UNKNOWN` or `AMBIGUOUS`, never a guess. An instrument's
  current symbol is valid from its listing, or from the day after its last closed alias, until its delisting.
  An alias is valid inside its own window. When a delisted symbol is re-used, the delisted row takes a new
  symbol and keeps the old one as an alias, because `(exchange, symbol, series)` is unique.
- `getInstrument`.
- `sessionBounds` and `tradingDays`. Both read calendar rows only; a date without a row raises
  `CALENDAR_DAY_NOT_FOUND` (BR-008).
- `effectiveMembers`, giving index constituents as of a date (BR-005).
- `resolveGroup`, giving static group members as of a date. Delisted instruments are excluded unless asked
  for (BR-006). Dynamic groups raise `GROUP_DYNAMIC_RULE_INVALID` until Phase 10.

Evidence: `packages/db/test/reference.integration.test.ts` has 7 tests, which pass against PostgreSQL 18.

- E4.1: a rename, a delisting, a re-listing under the old symbol, and an ambiguous symbol.
- E4.2: a normal NSE session, an MCX session whose row differs from the exchange default, a Muhurat session,
  a holiday, and a missing row.

## Slice 2 — reference-data API

`apps/api/src/routes-reference.ts` adds all 30 routes of `05` §11.4: exchanges and their calendar,
timeframes, instruments, aliases, sector memberships, index constituents, sectors, groups and corporate
actions. Every route declares its permission, so the boot-time check of `06` §7.2 covers it. Every write
records an audit event with before and after state in the same transaction.

- **Calendar.** `PUT` refuses a holiday with session bounds, and a trading day without both bounds. A past
  session that already has bars returns `CALENDAR_DAY_NOT_EDITABLE`.
- **Instruments.** Status changes go through the instrument state machine (`01` §3.5). `DELISTED` needs a
  `delistingDate`, and a delisted instrument cannot return to `ACTIVE` (`RESOURCE_CONFLICT`).
- **Aliases.** Two aliases for the same symbol on one exchange may not have overlapping windows
  (`ALIAS_WINDOW_OVERLAP`). Writes are serialised per symbol with an advisory lock.
- **Sector memberships.** BR-004: a new period of the same sector kind closes the open period on the day
  before. Any other overlap returns `MEMBERSHIP_OVERLAP`.
- **Sectors.** BR-003: re-parenting under itself or a descendant returns `SECTOR_CYCLE`. Sector writes are
  serialised so that two concurrent re-parents cannot form a cycle together.
- **Groups.**
  - Visible when they are system groups, shared, or owned by the caller. Others return `GROUP_NOT_FOUND`.
  - Only the owner edits a group. System groups return `GROUP_IMMUTABLE_SYSTEM`. Sharing needs
    `group:share`.
  - Member removal is soft.
- **Corporate actions.** `SPLIT` and `BONUS` need positive ratios, and `DIVIDEND` needs a cash amount
  (`CORPORATE_ACTION_INVALID`).
- **Lists.** Unknown filters return `400 FILTER_NOT_SUPPORTED`. `limit` above 200 is refused, not clamped.

Evidence: `apps/api/test/reference.integration.test.ts` has 8 tests, which pass against PostgreSQL 18.
E4.5: a `VIEWER` gets `403 AUTHZ_FORBIDDEN` on all 18 write routes, and no audit row is written; the audit
trail of each write holds its before and after state.

Shortcuts, each marked in the code:

- Lists return one page with `nextCursor: null`, because signed cursors are still a Phase 3 open item.
- No `ETag` or `If-Match` on instruments, sectors and groups (`05` §7.1).
- Deleting a corporate action does not yet recompute adjustment factors, which arrive in Phase 6.
- Dynamic groups cannot be created; they arrive in Phase 10.
- `POST /exchanges` was added later and has no `PATCH`; see below.

## `POST /exchanges`

Exchanges had no create path, because neither the API nor the import created them. `POST /exchanges` is now
in `05` §11.4. It needs `settings:write` (ADMIN only), because an exchange is platform configuration, like a
data source.

- The time zone must be a valid IANA zone, and defaults to `Asia/Kolkata`.
- The default session must close after it opens. It is a label only: sessions come from calendar rows (A8).
- A repeated code returns `RESOURCE_CONFLICT`.
- Creation is audited as `exchange.created`.

The Data Management screen shows a "Create an exchange" form to `settings:write` holders. There is still
no `PATCH` or delete; changes go through `psql` with an audit note until one is needed.

## Slice 3 — `REFERENCE` import batches, proxies and Data Management

**Import.** `packages/db/src/reference/import.ts` loads six kinds of reference CSV as `REFERENCE` batches in
`md.import_batch`: `CALENDAR`, `INSTRUMENTS`, `SECTOR_MEMBERSHIPS`, `INDEX_MEMBERSHIPS`, `CORPORATE_ACTIONS`
and `GROUP_MEMBERS`. The formats are in `infra/reference/README.md`. Operators run it with
`pnpm db:import:reference <KIND> <EXCHANGE> <file.csv>`.

- **Parsing.** An RFC 4180 parser (`reference/csv.ts`) handles quoted delimiters, quotes, line breaks and
  a BOM. Headers are case-insensitive.
- **File-level failures.** A missing, repeated or unknown header field fails the batch before any row is
  read. So does an empty file.
- **Row-level rejects.** These include bad values, unknown or ambiguous symbols as of the row's date, a
  repeated key in the file, a wrong column count, and the same domain rules as the API (BR-003, BR-004,
  overlaps, corporate-action types, a past calendar day with bars).
- **All or nothing.** Every row is applied on probation inside the batch transaction. One reject rolls every
  row back, stores the rejects in `md.ingestion_reject`, and ends the batch `VALIDATION_FAILED`. A clean file
  moves `RECEIVED → VALIDATING → VALIDATED → PROCESSING → COMPLETED` (`01` §3.1).
- **Re-runnable.**
  - Rows are upserts, and an unchanged row writes nothing.
  - Calendar times are exchange-local and converted with the exchange's time zone (A8).
  - The same file for the same kind and exchange replays its first batch, keyed by its SHA-256 in
    `idempotency_key`.
- **Audit.** Each changed row records an audit event with before and after state and the batch id.
- **System groups.** `GROUP_MEMBERS` is the path for system groups, which the API refuses to edit. It
  creates a missing system group when the row names it.
- **Shared writes.** The BR-004 and overlap rules moved into `reference/write.ts`
  (`addSectorMembership`, `addIndexMember`), which the API and the import share. Sending the same period
  again now updates its end instead of failing as an overlap.

**GS Composite and RS proxies.** `infra/reference/rs-proxies.instruments.csv` holds:

- the gold, silver, long-gilt and USD-INR proxies of `04` §7.4;
- the synthetic `GS_COMPOSITE` instrument (`is_synthetic`, A11).

`gs-composite.members.csv` defines the `GS_COMPOSITE` system group. All of it is flagged
`VERIFY_BEFORE_PROD`.

**SPA.** `apps/web/src/features/data/DataManagement.tsx` is the Data Management screen (`/data`):

- **Exchanges and calendars:** a range view, and saving a day.
- **Instruments:** search, create, suspend, resume and delist; aliases; sector classification; index
  constituents as of a date.
- **Sectors:** tree, create, move.
- **Groups:** list, create, members as of a date, add, remove, share, delete.
- **Corporate actions:** list, filter, record, delete.

Each write control appears only with the permission its endpoint needs.

Evidence:

- `packages/db/test/reference-import.integration.test.ts` has 7 tests: completed and replayed batches,
  all-or-nothing rejects, header failures, a calendar served by `sessionBounds`, memberships, corporate-action
  upserts, and the GS Composite system group.
- `reference-csv.test.ts` has 3 tests.
- The CLI loaded both templates into a migrated scratch database, and a second run replayed.

## Open

- **E4.3 and E4.4 need real data.** One is the NSE, BSE and MCX holiday calendars for the current and next
  year; the other is a 5-year corporate-action feed with its own count. The import path for both now
  exists, but neither file is in the repository, and neither can be produced without a licensed source
  (PRG-21).
- **Uploads.** Closed in Phase 5: `POST /ingestion/uploads` with `batchType=REFERENCE` and `referenceKind`
  calls the same `importReference`; the CLI remains for operators.
- **Data Management has not been clicked through in a browser.** It is checked by typecheck and build only.
- **Calendar times in the SPA assume UTC+05:30.** That holds for every v1 exchange and is marked as a
  shortcut.

# Phase 1 completion note — Architecture and domain model

Status: **OPEN**. Engineering exit criteria E1.1 and E1.2 are evidenced; E1.3, E1.4 and E1.5 are sign-offs by
the system owner and have not happened. The phase closes when all five are evidenced (`08` §8).

## Delivered

| Deliverable (`08` §4, Phase 1) | Location |
|---|---|
| Monorepo scaffold: pnpm 10 workspace, TypeScript 5.9 strict, ESLint 9 flat config, Prettier 3, Vitest 3 | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `vitest.config.ts` |
| Package-boundary rule (`00` §7 rules 2 and 4) | `eslint.config.js` (`no-restricted-imports`, `no-restricted-syntax`) |
| Decimal-discipline rule (`05` §4.1, ADR-005) | `tooling/eslint-plugin-tradesoft/index.js` |
| `packages/contracts`: error registry (131 codes from `05` §5.2), RFC 9457 problem schema and builder, decimal-string and int64-string schemas with the single serialiser, collection envelope and cursor shape, UUIDv7 / date / instant scalars, wire enums | `packages/contracts/src/` |
| `packages/domain`: `Decimal`, branded ids, `IsoDate`, `Instant`, `DomainError`, the five state machines of `01` §3.1–§3.5, value-level invariants INV-01/02/03/05/08/10/11/12/17 | `packages/domain/src/` |
| CI stages 1–3 (`07` §6.13) | `.github/workflows/ci.yml` |
| `.env.example` from the configuration contract (`07` §3.4) | `.env.example` |

## Exit criteria

| ID | Status | Evidence |
|---|---|---|
| E1.1 | **Met** | `packages/domain/test/state-machines.test.ts` parses each Mermaid diagram in `01` §3.1–§3.5 and asserts the code's initial states, terminal states and edges equal it, then enumerates every (state, event) pair. A deliberate mutation (dropping `CANCELLED` from the scanner-run terminal set) failed the test. |
| E1.2 | **Met** | `tooling/eslint-plugin-tradesoft/rules.test.js` lints fixtures through the repository's real ESLint configuration: a deep import, a relative cross-package import, an I/O import and `Date.now()` in `domain`, a workspace import in `contracts`, and a price typed as `number` (Zod and TypeScript) in `contracts` are each rejected; the public entrypoint and an integer `rank` are accepted. |
| E1.3 | **Open** | Needs the system owner's written approval of `04` §5.10, §6.7, §7.7 and §8.7 with the commit hash of `04`. |
| E1.4 | **Open** | Needs the system owner's review of A1–A11 (`00` §2). |
| E1.5 | **Open** | Needs the data-source and licence decision per exchange and per inter-market proxy (R-03, R-09, PRG-21). |

Local run on the completion commit (Windows 11, Node 24.19.0, pnpm 10.34.9):

| Stage | Command | Result |
|---|---|---|
| 1. Static | `pnpm static` | typecheck, lint and format check clean |
| 2. Unit | `pnpm test:unit` | 6 files, 48 tests passed |
| 3. Contract | `pnpm test:contract` | 1 file, 3 tests passed; the registry equals `05` §5.2 code for code. A deliberate mutation (`RATE_LIMITED` 429 → 428) failed it. |

The GitHub Actions workflow has not run: the directory is not yet a git repository.

## Specification changes made in this phase (`08` §8 item 4)

- `08` Phase 1: hand-written entity types for `01` §1 removed from the deliverables. Row types are inferred
  from the Drizzle schema in Phase 2, so the DDL remains the single source and cannot drift from a second copy.
- `01` INV-10: the brick-size formula now states the one-tick floor, matching `04` §5.2.

## Decisions recorded

- Wire enums (timeframes and statuses) live in `contracts`, because `contracts` is the leaf package and `domain`
  depends on it (DIAGRAM 3); `domain` re-exports what it uses.
- Problem `retryable` defaults by status: `429`, `500`, `503` and `504` are retryable; nothing else is.
- `01` §3.6 (bar quality) is a status set, not a state machine; it is an enum and has no transition table.
- The decision whether a failed job retries or dead-letters belongs to the job runtime (Phase 3, `03` §5.2), not
  to the job state machine.

## Deferred to their owning phase

| Item | Phase | Reason |
|---|---|---|
| Cursor signing and verification (`05` §6.3) | 3 | Needs `CURSOR_SECRET`, which the config loader introduces |
| Permission catalogue and matrix test | 3 | The matrix is structural seed for `iam` |
| Runtime "decimal walk" over DTO schemas (`05` §14.3) | 3 | No DTOs exist yet; the lint rule covers the source today |
| INV-06 bucket alignment | 6 | Needs the timeframe algebra |
| INV-09 brick direction property | 8 | Needs the Renko engine |

## Found, not resolved

- `07` §3.4 sets `UPLOAD_MAX_BYTES` to 20 MiB, while `03` §3.1 rejects files only above 200 MB
  (`FILE_TOO_LARGE`). One of the two must change before Phase 5; a full-market EOD file is far below either.
- ESLint 9 is marked deprecated on npm in favour of 10.x. typescript-eslint 8.72 supports both; the upgrade is a
  dependency change, not a design change.
- `docs/` mixes CRLF and LF line endings. Tests that read the specification normalise them.

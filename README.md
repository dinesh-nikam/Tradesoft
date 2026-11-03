# TradeSoft

Production-grade market analysis platform for Indian financial markets (NSE, BSE, MCX, NCDEX, NFO).

**Current state: PHASE 1 in progress — monorepo, `packages/contracts` and `packages/domain` exist; no runtime
service exists yet** ([phase note](docs/release/phases/phase-01.md)).
This repository is therefore **not** production-ready, and will not be until the gate in
`docs/architecture/07-operations.md` §13 is satisfied with evidence.

## Documents

| #   | Document                                                                                     | Contents                                                                                                        |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 00  | [`docs/architecture/00-system-architecture.md`](docs/architecture/00-system-architecture.md) | Assumptions, actors, RBAC, module map, technology decisions (ADR-style), repository layout, deployment topology |
| 01  | [`docs/architecture/01-domain-model.md`](docs/architecture/01-domain-model.md)               | Entity catalogue, relationships, state machines, business rules, invariants                                     |
| 02  | [`docs/architecture/02-database.md`](docs/architecture/02-database.md)                       | Physical PostgreSQL schema, indexes, partitioning, migrations, seed strategy                                    |
| 03  | [`docs/architecture/03-ingestion-and-jobs.md`](docs/architecture/03-ingestion-and-jobs.md)   | Ingestion adapters, validation, reconciliation, job architecture, concurrency and idempotency                   |
| 04  | [`docs/architecture/04-analytics-engines.md`](docs/architecture/04-analytics-engines.md)     | Canonical bars, timeframe rules, indicator mathematics, Renko, breadth, RS matrix, scanner engine               |
| 05  | [`docs/architecture/05-api.md`](docs/architecture/05-api.md)                                 | REST conventions, endpoint catalogue, error taxonomy, pagination, rate limiting                                 |
| 06  | [`docs/architecture/06-security.md`](docs/architecture/06-security.md)                       | Authentication, authorization, token strategy, threat model, controls                                           |
| 07  | [`docs/architecture/07-operations.md`](docs/architecture/07-operations.md)                   | Observability, audit, testing strategy, deployment and operations, production-readiness gate                    |
| 08  | [`docs/architecture/08-implementation-plan.md`](docs/architecture/08-implementation-plan.md) | Phased execution sequence with acceptance criteria, risks, effort                                               |
| —   | [`docs/architecture/DIAGRAMS.md`](docs/architecture/DIAGRAMS.md)                             | The twelve canonical Mermaid diagrams (single source of truth)                                                  |

## Coverage of the required specification

Where each of the 25 required outputs lives. Every row points to the authoritative section; nothing is
specified in two places.

| #   | Required output                | Location                                                                |
| --- | ------------------------------ | ----------------------------------------------------------------------- |
| 1   | Assumptions                    | `00` §2 (A1–A11)                                                        |
| 2   | Actors                         | `00` §3                                                                 |
| 3   | Roles and permissions          | `00` §4; resource-level rules `06` §7.4                                 |
| 4   | Domain modules                 | `00` §5; DIAGRAM 3                                                      |
| 5   | Entity catalogue               | `01` §1                                                                 |
| 6   | Entity relationships           | `01` §2; DIAGRAM 6                                                      |
| 7   | Lifecycle and state machines   | `01` §3 (import batch, job, scanner run, user, instrument, bar quality) |
| 8   | Business rules                 | `01` §4                                                                 |
| 9   | Invariants                     | `01` §5; `04` §11.3                                                     |
| 10  | Technology decisions           | `00` §6 (ADR-001…ADR-020)                                               |
| 11  | Architecture diagram           | DIAGRAM 1, 2, 3                                                         |
| 12  | Data-flow diagram              | DIAGRAM 4, 5                                                            |
| 13  | Database ERD                   | DIAGRAM 6                                                               |
| 14  | Database design                | `02` (DDL, partitioning, migrations, seed, indexes, capacity, backup)   |
| 15  | API architecture               | `05`                                                                    |
| 16  | Security architecture          | `06`; DIAGRAM 7                                                         |
| 17  | Async/job architecture         | `03` §5–§6; `04` §9; DIAGRAM 11                                         |
| 18  | Concurrency and idempotency    | `03` §7; `05` §8                                                        |
| 19  | Audit and observability        | `06` §14; `07` §4–§5                                                    |
| 20  | Testing strategy               | `07` §6; `04` §11; `06` §17                                             |
| 21  | Deployment architecture        | `00` §8; `07` §3, §7                                                    |
| 22  | Repository structure           | `00` §7                                                                 |
| 23  | Implementation sequence        | `08` §3–§5                                                              |
| 24  | Risks and mitigations          | `08` §6; security residual risks `06` §19.2                             |
| 25  | Production-readiness checklist | `07` §13–§14                                                            |

Engine methodologies required by the brief: indicators `04` §3, Fibonacci `04` §4, Renko `04` §5 and
DIAGRAM 10, breadth `04` §6, RS Matrix `04` §7 and DIAGRAM 9, scanners `04` §8 and DIAGRAM 8, timeframe
aggregation `04` §2, future live data `00` §5.1 and DIAGRAM 12.

## Read order

1. `00-system-architecture.md` — why the system looks the way it does.
2. `01-domain-model.md` — what the business is made of.
3. `02-database.md` + `03-ingestion-and-jobs.md` — how data is stored and moved.
4. `04-analytics-engines.md` — how every number is computed, exactly.
5. `05-api.md` + `06-security.md` — how clients reach it, and under what control.
6. `07-operations.md` — how it is proven and run.
7. `08-implementation-plan.md` — the order of work.

## Local prerequisites

| Tool           | Version  | Notes                                                                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | 24.x LTS | Verified present: v24.19.0                                                                                                  |
| pnpm           | 10.x     | `npm i -g pnpm@10`                                                                                                          |
| PostgreSQL     | 16.x     | Local service or Docker; required for any integration test                                                                  |
| Docker Desktop | 27.x     | Required for `docker compose` and Testcontainers-based integration tests. Not currently installed on the reference machine. |

Docker and PostgreSQL are **not** optional for Phase 2 onward: the schema uses `numeric`, range
partitioning, `ON CONFLICT`, advisory locks and `FOR UPDATE SKIP LOCKED`, none of which can be
faithfully substituted by an in-memory database.

## Commands

pnpm is pinned in `package.json`; without a global install, prefix each command with `npx pnpm@10.34.9`.

| Command              | CI stage (`07` §6.13)                          |
| -------------------- | ---------------------------------------------- |
| `pnpm install`       | —                                              |
| `pnpm static`        | 1. typecheck, lint, format check               |
| `pnpm test:unit`     | 2. unit                                        |
| `pnpm test:contract` | 3. contract (code against `docs/architecture`) |

## Ground rules for contributors

- Prices are `numeric` in PostgreSQL and decimal **strings** in JSON. They are never JavaScript
  `number` across a boundary.
- All timestamps are `timestamptz` in UTC. Exchange-local meaning lives in `session_date` and is
  resolved through `trading_calendar`.
- Analytical engines are pure functions. They never touch the database, the clock, or the network.
- Only the ingestion module writes to `market_bar`. Everything derived is produced by jobs.
- No module imports another module's internals. Public entrypoint only, enforced in CI.
#   T r a d e s o f t  
 
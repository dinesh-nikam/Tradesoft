# Data-source licence register (PRG-21)

Every source whose data reaches `md.market_bar` or `ref.*` is listed here before its first production import.
A row records what the licence allows, not what is technically possible. A source without a confirmed
licence stays in staging.

| Code | Provider | Data | Adapter | Licence | Redistribution | Retention | Status |
|---|---|---|---|---|---|---|---|
| `NSE_EOD` | NSE | End-of-day bhavcopy | `csv.nse.bhavcopy` | **Not confirmed** | Not confirmed | 24 months raw files (`06` §11.2) | Staging only |
| `BSE_EOD` | BSE | End-of-day bhavcopy | `csv.bse.bhavcopy` | **Not confirmed** | Not confirmed | 24 months raw files | Staging only |
| `MCX_EOD` | MCX | End-of-day futures with open interest | `csv.mcx.eod` | **Not confirmed** | Not confirmed | 24 months raw files | Staging only |
| `NCDEX_EOD` | NCDEX | End-of-day futures with open interest | `csv.ncdex.eod` | **Not confirmed** | Not confirmed | 24 months raw files | Staging only |
| `REF_*` | Internal | Reference files loaded through `REFERENCE` batches (Phase 4) | reference importer | Internal | n/a | 24 months raw files | Staging only |

Rules:

- A row moves to **Production** only when the licence column names a signed agreement or a published
  licence, with its date and the person who checked it.
- Vendor credentials are never stored in `md.data_source.config`; the config names the environment
  variable that holds them (`03` §1.1).
- The exchange column names in the bhavcopy adapters are marked `VERIFY_BEFORE_PROD` in the code. They must
  be checked against a current sample file from each exchange as part of moving a row to Production.

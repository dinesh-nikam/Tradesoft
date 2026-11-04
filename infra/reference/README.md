# Reference-data templates

Starting files for the `REFERENCE` import (`pnpm db:import:reference <KIND> <EXCHANGE> <file.csv>`, Phase 4).
Every market fact here is **VERIFY_BEFORE_PROD**: check each symbol, tick size and start date against the
exchange's current list before the first production import.

| File                         | Kind            | Purpose                                                                                                                                            |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rs-proxies.instruments.csv` | `INSTRUMENTS`   | The gold, silver, bond and USD-INR instruments the RS Matrix pairs against (`04` §7.4), and the synthetic GS Composite instrument (A11, `04` §7.8) |
| `gs-composite.members.csv`   | `GROUP_MEMBERS` | The `GS_COMPOSITE` system group and its proxy members                                                                                              |

Load the instruments first, because group members are resolved by symbol as of `added_on`:

```bash
DATABASE_URL=… pnpm db:import:reference INSTRUMENTS NSE infra/reference/rs-proxies.instruments.csv
DATABASE_URL=… pnpm db:import:reference GROUP_MEMBERS NSE infra/reference/gs-composite.members.csv
```

## File formats

UTF-8 CSV with one header row. Header names are case-insensitive. Empty, `-`, `NA`, `N/A` and `NULL` mean
absent. Dates are `YYYY-MM-DD`. Calendar times are `HH:MM` in the exchange's local time.

| Kind                 | Required columns                                   | Optional columns                                                                                                           |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CALENDAR`           | `date`, `is_trading_day`                           | `session_open`, `session_close`, `is_special`, `description`                                                               |
| `INSTRUMENTS`        | `symbol`, `name`, `instrument_type`, `asset_class` | `series`, `isin`, `currency`, `lot_size`, `tick_size`, `price_precision`, `listing_date`, `delisting_date`, `is_synthetic` |
| `SECTOR_MEMBERSHIPS` | `symbol`, `sector_code`, `effective_from`          | `series`, `effective_to`                                                                                                   |
| `INDEX_MEMBERSHIPS`  | `index_symbol`, `symbol`, `effective_from`         | `series`, `effective_to`, `weight`                                                                                         |
| `CORPORATE_ACTIONS`  | `symbol`, `action_type`, `ex_date`                 | `series`, `record_date`, `ratio_from`, `ratio_to`, `cash_amount`, `announced_at`, `note`                                   |
| `GROUP_MEMBERS`      | `group_code`, `symbol`, `added_on`                 | `series`, `removed_on`, `weight`, `group_name`, `group_type`                                                               |

## Behaviour

- **All or nothing.** One rejected row fails the batch (`VALIDATION_FAILED`) and nothing is applied. Each
  reject is stored in `md.ingestion_reject` with its row number and code.
- **Re-runnable.** Rows are upserts, and an unchanged row writes nothing. The same file for the same kind and
  exchange replays its first batch instead of running again.
- **Audited.** Every changed row records an audit event with its before and after state.
- **Instruments.** An `INSTRUMENTS` row carries the whole record, so a column left empty clears that value.
  A delisted instrument is never re-activated: import the re-listing as a new symbol, and keep the old
  symbol as an alias.
- **Groups.** `GROUP_MEMBERS` edits system groups only; user groups are edited through the API. A missing
  group is created as a system group when the row gives `group_name` and `group_type`.
- **Exchanges.** No import creates an exchange: a batch belongs to an existing exchange.

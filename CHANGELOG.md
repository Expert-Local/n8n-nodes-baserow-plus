# Changelog

## [3.1.2] - 2026-03-12

### Fixed
- Correct `number_decimal_places` property name (was reading `decimal_places`, causing silent skip of auto-rounding)
- Batch validation errors now deduplicate: same field+message across rows collapses to "All rows / field: msg"
- Error message extractor checks `e.error` before `e.detail`/`e.message` to unwrap Baserow's `{ error, code }` objects

## [3.1.1] - 2026-03-12

### Fixed
- Batch API validation error format: detect `detail.items` structure with per-row `{ "0": { field_xxx: [...] } }` nesting
- Fallback to `JSON.stringify()` instead of `String()` for unexpected nested validation objects

## [3.1.0] - 2026-03-12

### Added
- **Decimal auto-normalization**: fetches `decimal_places` from Baserow field schema and auto-rounds number values before writing
- **Human-readable validation errors**: translates `field_xxx` IDs to column names using schema cache
- **Row ID auto-detect**: Update, Delete, and Get operations read `id` from input item when no explicit ID is set
- **link_row strict validation**: throws on non-integer values instead of silently passing
- **Upsert multi-match warning** when more than one row matches

### Fixed
- Fetch All defaults to `true`; page size clamped 1-200
- List pagination double-break bug
- Multi-Table Fetch now respects the Request Timeout parameter

## [3.0.0] - 2026-02-26

### Added
- Field-type-aware serialization with automatic schema fetching
- True batch API support (Create, Update, Delete) — up to 200 rows per request
- Upsert operation (update-or-create by field match)
- Lookup operation (search by field value)
- Multi-Table Fetch (parallel queries across multiple tables)
- Automatic retry with exponential backoff on 429 rate limits
- Configurable request timeout
- Server-side field inclusion/exclusion
- Full-text search parameter

### Fixed
- `[null]` no longer becomes `[0]` in link_row fields
- Empty array `[]` no longer stringified to `"[]"`
- Multi-select vs linked record detection fixed (checks `.color` property)
- Upsert `matchValue` with `autoMapAll` reads directly from input item
- `minFilterValue` no longer rejects `0`
- `batchCreate` now uses Baserow's real batch endpoint

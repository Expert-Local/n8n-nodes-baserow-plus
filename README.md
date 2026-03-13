<p align="center">
  <img src="logo.svg" alt="Expert Local" width="80" />
</p>

<h1 align="center">n8n-nodes-baserow-plus</h1>

<p align="center">Production-grade n8n community node for <a href="https://baserow.io">Baserow</a> — the open-source Airtable alternative.</p>
<p align="center">Built by <a href="https://expertlocal.ca">Expert Local</a></p>

Field-type-aware serialization, decimal auto-normalization, human-readable validation errors, true batch API (up to 200 rows per request), upsert, lookup, automatic retry with exponential backoff, and parallel multi-table fetch.

## Installation

### Docker / Custom Nodes Directory

Copy the entire `n8n-nodes-baserow-plus` folder into your n8n custom nodes directory:

```bash
scp -r n8n-nodes-baserow-plus/ user@server:/path/to/n8n/custom/
```

Then restart n8n:

```bash
docker restart n8n n8n-worker
```

### npm (when published)

```bash
cd ~/.n8n
npm install n8n-nodes-baserow-plus
```

## Credentials

Create a new credential of type **Baserow Plus API** with:

| Field | Description |
|-------|-------------|
| **Base URL** | Your Baserow instance URL (e.g. `https://api.baserow.io` or `https://baserow.example.com`) |
| **API Token** | Generate in Baserow under Settings → API Tokens |

> The credential name (`baserowPlusApi`) is distinct from v2, so both can be installed side-by-side.

## Operations

### List
List rows with optional filters, sorting, full-text search, and server-side field filtering.

| Parameter | Description |
|-----------|-------------|
| Fetch All | Paginate through all rows automatically |
| Page Size | Rows per page (max 200) |
| Max Records | Stop after this many rows (0 = unlimited) |
| Search | Full-text search across all text fields |
| Include Fields | Comma-separated field names for server-side inclusion |
| Exclude Fields | Comma-separated field names for server-side exclusion |
| Sort | One or more sort rules (field + direction) |
| Filters | One or more filter rules (field + operator + value) |
| Select Fields | Client-side field selection (comma-separated) |

### Get
Retrieve one or more rows by ID. Accepts a single ID or comma-separated IDs.

### Create
Create a new row. Supports both auto-mapping from input JSON and manual field configuration.

### Update
Update an existing row by ID. Leave Row ID blank to auto-detect from the input item's `id` field — works automatically after List, Get, or Lookup operations.

### Delete
Delete a row by ID. Same auto-detect behaviour as Update.

### Batch Create
Create multiple rows using Baserow's batch API endpoint. Sends up to 200 rows per request, automatically chunking larger sets.

**Performance:** A single batch API call replaces 200 individual HTTP requests. Creating 500 rows requires only 3 API calls instead of 500.

### Batch Update
Update multiple rows in a single batch API call. Two modes:

1. **Shared fields mode:** Provide comma-separated Row IDs + field values applied to every row
2. **Per-item mode:** Leave Row IDs empty, enable Auto Map All, and include an `id` field in each input item

### Batch Delete
Delete multiple rows in a single batch API call. Provide comma-separated Row IDs.

### Upsert
Update if a matching row exists, otherwise create. Select a field to match on — the node searches for an existing row with that field value and updates it, or creates a new row if no match is found.

### Lookup
Search for rows by field value. A standalone search operation that exposes what upsert does internally.

| Parameter | Description |
|-----------|-------------|
| Lookup Field | The field to search in |
| Lookup Value | The value to search for |
| Lookup Operator | `equal`, `contains`, or `icontains` |
| Max Results | Maximum rows to return |

### Multi-Table Fetch
Fetch data from multiple Baserow tables in parallel using a single shared filter field. All tables are queried concurrently via `Promise.all`.

## Field-Type-Aware Serialization

The node fetches each table's field schema and uses field type information for precise serialization:

| Baserow Field Type | Serialization |
|--------------------|---------------|
| `link_row` | Integer array — `[18]` not `'[18]'`. Empty `[]` allowed. Single int auto-wrapped. Invalid values throw with a clear message. |
| `boolean` | Coerces `"true"`, `"false"`, `1`, `0` to actual booleans |
| `number` | Coerces string to Number, then **auto-rounds to the field's configured decimal places** (reads `number_decimal_places` from Baserow schema). A field set to 0 decimals turns `12.874523` into `13`, 2 decimals turns it into `12.87`. No manual `toFixed()` needed. |
| `rating` | Coerces to integer via `Math.round()` |
| `single_select` | Ensures string |
| `multiple_select` | Ensures string array (accepts comma-separated strings) |
| `date` | Ensures ISO string |
| `text`, `long_text`, `url`, `email`, `phone_number` | Ensures string (stringifies objects) |
| `file` | Pass-through |
| Unknown | Primitives pass through, objects stringify |

When field type info is unavailable (e.g. cache miss), falls back to a heuristic that preserves backward compatibility with v2.

## Error Handling & Retry

- **Human-readable validation errors:** Field IDs are translated to column names using the schema cache. Instead of `{"field_267": ["A valid number is required."]}` you get `"Revenue": A valid number is required.` Multiple field errors are piped together with `|`.
- **Batch validation errors deduplicated:** When the same field has the same error across multiple rows, it collapses to `All rows / "tech_score": Ensure that there are no more than 0 decimal places.` instead of repeating per row. Unique errors per row are shown individually as `Row 0,2 / "field": message`.
- **429 retry:** Automatic retry on rate limiting with exponential backoff (1s, 2s, 4s). Respects `Retry-After` header.
- **Configurable timeout:** Default 30s, adjustable per-node via the "Request Timeout" parameter
- **Continue on fail:** All operations respect n8n's `continueOnFail()` pattern

## Bug Fixes from v2

1. **`[null]` → `[0]` in sanitizeWriteValue** — `Number(null)===0` passed integer check. Fixed with null/undefined guard.
2. **Empty array `[]` → `"[]"`** — Now passes through as `[]` for link_row fields.
3. **Multi-select vs linked record overlap** — Both checked `value[0]?.value`. Now checks for `.color` property (select options have `{id, value, color}`, linked records have `{id, value}` only).
4. **Upsert matchValue broken with autoMapAll** — Convoluted `originalFields` lookup failed. Now reads directly from `items[i].json[upsertField]`.
5. **minFilterValue rejects 0** — Used `!== ''` which rejected `0`. Now uses `!= null`.
6. **batchCreate not batched** — Was identical to create (1 API call per row). Now uses Baserow's real batch endpoint.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Use Field Names Mapping | `true` | Convert between `field_xxx` IDs and human-readable names |
| Return Raw | `false` | Skip all name conversion and value cleaning |
| Refresh Field Schema | `false` | Bypass the 5-minute schema cache |
| Request Timeout | `30000` ms | Per-request timeout |
| Auto Map All Input Fields | `true` | Map all incoming JSON keys automatically |

## License

MIT

## Author

Steven Lefebvre — [expertlocal.ca](https://expertlocal.ca)

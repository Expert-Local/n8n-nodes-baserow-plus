"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaserowPlus = void 0;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum rows per Baserow batch API call. */
const BATCH_CHUNK_SIZE = 200;

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Maximum retry attempts for 429 (rate limited) responses. */
const MAX_RETRIES = 3;

/** Base delay between retries in milliseconds (doubles each attempt). */
const RETRY_BASE_DELAY_MS = 1000;

/** Cache TTL in milliseconds (default: 5 minutes). */
const CACHE_TTL = 5 * 60 * 1000;

// ─── Field Schema Cache ─────────────────────────────────────────────────────
// In-memory cache mapping table IDs to their field name↔id maps + field types.
const fieldCache = {};

// ─── Utility: Chunk Array ────────────────────────────────────────────────────

/**
 * Splits an array into chunks of the specified size.
 *
 * @param {Array} arr  - The array to chunk.
 * @param {number} size - Maximum chunk size.
 * @returns {Array[]} Array of chunks.
 */
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

// ─── Error Handling ──────────────────────────────────────────────────────────

/**
 * Extracts a human-readable error message from a Baserow API error response.
 *
 * When idToName is provided, validation errors translate field IDs (field_267)
 * into their human-readable column names so users see exactly which field failed.
 *
 * @param {Error}  error     - The raw error from the HTTP request.
 * @param {object} [idToName={}] - Optional map of field_xxx → column name.
 * @returns {string} Formatted error message.
 */
function parseBaserowError(error, idToName = {}) {
    // n8n wraps HTTP errors — try to get the response body
    let body = error.response?.body || error.error || error.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { /* not JSON */ }
    }

    if (body && typeof body === 'object') {
        const code = body.error || 'UNKNOWN';
        const detail = body.detail;

        // Validation errors: detail is an object keyed by field_xxx
        if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
            const fieldErrors = [];
            for (const [fieldKey, errors] of Object.entries(detail)) {
                // Batch API format: detail.items = { "0": { field_xxx: ["err"] }, "1": ... }
                if (fieldKey === 'items' && errors && typeof errors === 'object' && !Array.isArray(errors)) {
                    // Collect per-field errors across all rows, then deduplicate
                    // Structure: { "fieldName: message" -> [rowIndex, ...] }
                    const fieldMsgRows = {};
                    for (const [rowIndex, rowDetail] of Object.entries(errors)) {
                        if (!rowDetail || typeof rowDetail !== 'object') continue;
                        for (const [rFieldKey, rErrors] of Object.entries(rowDetail)) {
                            const rFieldName = idToName[rFieldKey] || rFieldKey;
                            const msgs = Array.isArray(rErrors)
                                ? rErrors.map(e => (typeof e === 'string' ? e : (e.error || e.detail || e.message || JSON.stringify(e)))).join('; ')
                                : String(rErrors);
                            const key = `"${rFieldName}": ${msgs}`;
                            if (!fieldMsgRows[key]) fieldMsgRows[key] = [];
                            fieldMsgRows[key].push(Number(rowIndex));
                        }
                    }
                    const totalRows = Object.keys(errors).length;
                    for (const [msg, rows] of Object.entries(fieldMsgRows)) {
                        const prefix = rows.length === totalRows
                            ? 'All rows'
                            : `Row${rows.length > 1 ? 's' : ''} ${rows.join(',')}`;
                        fieldErrors.push(`${prefix} / ${msg}`);
                    }
                    continue;
                }
                const fieldName = idToName[fieldKey] || fieldKey;
                const messages = Array.isArray(errors)
                    ? errors.map(e => (typeof e === 'string' ? e : (e.error || e.detail || e.message || JSON.stringify(e)))).join('; ')
                    : (errors && typeof errors === 'object' ? JSON.stringify(errors) : String(errors));
                fieldErrors.push(`"${fieldName}": ${messages}`);
            }
            if (fieldErrors.length > 0) {
                return `[BaserowPlus] Validation failed — ${fieldErrors.join(' | ')}`;
            }
        }

        const detailStr = typeof detail === 'string' ? detail : (body.message || JSON.stringify(body));
        return `[BaserowPlus] API error (${code}): ${detailStr}`;
    }

    return `[BaserowPlus] ${error.message || 'Unknown error'}`;
}

// ─── Request with Retry ──────────────────────────────────────────────────────

/**
 * Executes an HTTP request via n8n's helper with automatic retry on 429.
 *
 * Uses exponential backoff (1s, 2s, 4s) and respects the Retry-After header
 * when present. All other HTTP errors are thrown immediately.
 *
 * @param {object} ctx     - The n8n execution context.
 * @param {object} opts    - Request options (method, uri, body, etc.).
 * @param {number} timeout - Request timeout in milliseconds.
 * @returns {Promise<*>} The parsed response body.
 */
async function requestWithRetry(ctx, opts, timeout = DEFAULT_TIMEOUT_MS, idToName = {}) {
    const reqOpts = { ...opts, timeout };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await ctx.helpers.request(reqOpts);
        } catch (error) {
            const statusCode = error.statusCode || error.response?.statusCode;

            if (statusCode === 429 && attempt < MAX_RETRIES) {
                // Respect Retry-After header if present, otherwise exponential backoff
                const retryAfter = error.response?.headers?.['retry-after'];
                const delayMs = retryAfter
                    ? Math.min(Number(retryAfter) * 1000, 30000)
                    : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);

                console.warn(`[BaserowPlus] Rate limited (429). Retry ${attempt + 1}/${MAX_RETRIES} after ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            // Enrich the error message with Baserow details and field name translation
            error.message = parseBaserowError(error, idToName);
            throw error;
        }
    }
}

// ─── Helper: Field Schema ────────────────────────────────────────────────────

/**
 * Retrieves field name↔id mappings and field type information for a Baserow table.
 *
 * Results are cached per table + base URL combination. A forced refresh bypasses
 * the cache and fetches fresh schema from the Baserow API.
 *
 * @param {object}  ctx          - The n8n execution context (or loadOptions context).
 * @param {string}  baseUrl      - Baserow base URL without trailing slash.
 * @param {string}  apiToken     - Baserow API token.
 * @param {string}  tableId      - Numeric Baserow table ID.
 * @param {boolean} [forceRefresh=false] - When true, ignores cached data.
 * @param {number}  [timeout]    - Request timeout in ms.
 * @returns {Promise<{idToName: object, nameToId: object, fieldTypes: object, fieldMeta: object, timestamp: number, fieldCount: number}>}
 */
async function getFieldMaps(ctx, baseUrl, apiToken, tableId, forceRefresh = false, timeout = DEFAULT_TIMEOUT_MS) {
    const cacheKey = `${tableId}_${baseUrl}`;
    const now = Date.now();

    if (!forceRefresh && fieldCache[cacheKey] && (now - fieldCache[cacheKey].timestamp < CACHE_TTL)) {
        return fieldCache[cacheKey];
    }

    console.log(`[BaserowPlus] ${forceRefresh ? 'Force-refreshing' : 'Fetching'} field schema for table ${tableId}`);

    const options = {
        method: 'GET',
        uri: `${baseUrl}/api/database/fields/table/${tableId}/`,
        headers: { Authorization: `Token ${apiToken}` },
        json: true,
        timeout,
    };

    try {
        const res = await ctx.helpers.request(options);
        const idToName = {};
        const nameToId = {};
        const fieldTypes = {};
        const fieldMeta = {};

        for (const field of res) {
            idToName[`field_${field.id}`] = field.name;
            nameToId[field.name] = `field_${field.id}`;
            fieldTypes[field.name] = field.type;
            // Also store by field_id key for lookups when working with raw IDs
            fieldTypes[`field_${field.id}`] = field.type;
            // Store decimal_places for number fields (used for auto-rounding).
            // Baserow API returns the property as `number_decimal_places` (may be a string).
            if (field.type === 'number') {
                const dp = field.number_decimal_places ?? field.decimal_places;
                if (dp !== undefined && dp !== null) {
                    const meta = { decimal_places: Number(dp) };
                    fieldMeta[field.name] = meta;
                    fieldMeta[`field_${field.id}`] = meta;
                }
            }
        }

        fieldCache[cacheKey] = { idToName, nameToId, fieldTypes, fieldMeta, timestamp: now, fieldCount: res.length };
        console.log(`[BaserowPlus] Cached ${res.length} fields (with types) for table ${tableId}`);
        return fieldCache[cacheKey];
    } catch (error) {
        console.error(`[BaserowPlus] Failed to fetch field schema for table ${tableId}: ${error.message}`);
        // Fall back to stale cache rather than crashing the node.
        if (fieldCache[cacheKey]) {
            console.warn(`[BaserowPlus] Using stale cache for table ${tableId}`);
            return fieldCache[cacheKey];
        }
        throw error;
    }
}

// ─── Helper: Field Mapping ───────────────────────────────────────────────────

/**
 * Converts Baserow internal field keys (`field_123`) to human-readable names.
 */
function mapFromIdsToNames(row, idToName) {
    const out = {};
    for (const key of Object.keys(row)) {
        if (key.startsWith('field_')) {
            out[idToName[key] ?? key] = row[key];
        } else {
            out[key] = row[key];
        }
    }
    return out;
}

/**
 * Converts human-readable field names back to Baserow internal keys (`field_123`).
 */
function mapFromNamesToIds(obj, nameToId) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[nameToId[k] ?? k] = v;
    }
    return out;
}

/**
 * Extracts human-readable scalar values from Baserow select and linked-record fields.
 *
 * BUG FIX #3: Uses `.color` property to distinguish multi-select options
 * (`{id, value, color}`) from linked records (`{id, value}`).
 */
function cleanFieldValues(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
            // Single-select field: { id, value, color }
            if (
                Object.prototype.hasOwnProperty.call(value, 'id') &&
                Object.prototype.hasOwnProperty.call(value, 'value') &&
                Object.prototype.hasOwnProperty.call(value, 'color')
            ) {
                cleaned[key] = value.value;
            }
            // Array fields — check first element to determine type
            else if (Array.isArray(value) && value.length > 0) {
                const first = value[0];
                if (first && typeof first === 'object') {
                    // FIX #3: Multi-select has `color`, linked records do not
                    if (Object.prototype.hasOwnProperty.call(first, 'color')) {
                        // Multi-select: array of { id, value, color }
                        cleaned[key] = value.map((item) => item.value);
                    } else if (Object.prototype.hasOwnProperty.call(first, 'id')) {
                        // Linked record: array of { id, value }
                        cleaned[key] = value.map((item) => item.value || item.id);
                    } else {
                        cleaned[key] = value;
                    }
                } else {
                    cleaned[key] = value;
                }
            }
            else {
                cleaned[key] = value;
            }
        } else {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

/**
 * Returns a subset of an object containing only the specified keys.
 */
function pickFields(obj, fields) {
    if (!fields.length) return obj;
    const out = {};
    for (const f of fields) {
        if (f in obj) out[f] = obj[f];
    }
    return out;
}

// ─── Field-Type-Aware Sanitization ───────────────────────────────────────────

/**
 * Sanitizes a field value before writing to Baserow, using field type information
 * when available for precise serialization.
 *
 * BUG FIX #1: Guards against `Number(null) === 0` passing integer check.
 * BUG FIX #2: Empty arrays `[]` pass through instead of becoming `"[]"`.
 *
 * @param {*}      value     - Raw value from the n8n item.
 * @param {string} [fieldType] - Baserow field type string (e.g. 'link_row', 'boolean').
 * @param {object} [meta]      - Field metadata (e.g. { decimal_places: 2 } for number fields).
 * @returns {*} Sanitized value, or `undefined` to skip the field.
 */
function sanitizeWriteValue(value, fieldType, meta) {
    // Skip nulls and undefineds entirely
    if (value === null || value === undefined) return undefined;

    // ── Type-aware path (when fieldType is known) ────────────────────────
    if (fieldType) {
        switch (fieldType) {
            case 'link_row': {
                // Must be an integer array. Empty [] is valid.
                if (Array.isArray(value)) {
                    if (value.length === 0) return [];
                    return value
                        .filter(v => v !== null && v !== undefined)
                        .map(v => {
                            const n = Number(v);
                            if (!Number.isInteger(n)) {
                                throw new Error(`[BaserowPlus] link_row value "${v}" is not a valid integer row ID.`);
                            }
                            return n;
                        });
                }
                // Single integer → wrap in array
                if (typeof value === 'number' && Number.isInteger(value)) return [value];
                // String that looks like a number
                if (typeof value === 'string') {
                    const n = Number(value);
                    if (Number.isInteger(n) && value.trim() !== '') return [n];
                }
                // Already-wrapped string like "[18]" — parse it
                if (typeof value === 'string' && value.startsWith('[')) {
                    try {
                        const parsed = JSON.parse(value);
                        if (Array.isArray(parsed)) {
                            return parsed
                                .filter(v => v !== null && v !== undefined)
                                .map(v => Number(v))
                                .filter(v => Number.isInteger(v));
                        }
                    } catch (_) { /* not valid JSON */ }
                }
                return Array.isArray(value) ? value : [value];
            }

            case 'boolean': {
                if (typeof value === 'boolean') return value;
                if (value === 'true' || value === 1 || value === '1') return true;
                if (value === 'false' || value === 0 || value === '0') return false;
                return Boolean(value);
            }

            case 'number': {
                const n = typeof value === 'number' ? value : Number(value);
                if (isNaN(n)) return undefined;
                // Auto-round to the field's configured decimal places
                if (meta?.decimal_places !== undefined) {
                    return parseFloat(n.toFixed(meta.decimal_places));
                }
                return n;
            }

            case 'rating': {
                const n = typeof value === 'number' ? value : Number(value);
                return isNaN(n) ? undefined : Math.round(n);
            }

            case 'single_select': {
                // Baserow expects the option name as a string
                if (typeof value === 'string') return value;
                if (typeof value === 'object' && value !== null && value.value) return String(value.value);
                return String(value);
            }

            case 'multiple_select': {
                // Baserow expects an array of option name strings
                if (Array.isArray(value)) {
                    return value.map(v => {
                        if (typeof v === 'string') return v;
                        if (typeof v === 'object' && v !== null && v.value) return String(v.value);
                        return String(v);
                    });
                }
                // Accept comma-separated string
                if (typeof value === 'string') {
                    return value.split(',').map(s => s.trim()).filter(Boolean);
                }
                return [String(value)];
            }

            case 'date':
            case 'last_modified':
            case 'created_on': {
                if (typeof value === 'string') return value;
                if (value instanceof Date) return value.toISOString();
                if (typeof value === 'number') return new Date(value).toISOString();
                return String(value);
            }

            case 'text':
            case 'long_text':
            case 'url':
            case 'email':
            case 'phone_number': {
                if (typeof value === 'string') return value;
                if (typeof value === 'object') return JSON.stringify(value);
                return String(value);
            }

            case 'file': {
                // File fields expect a specific structure — pass through
                return value;
            }

            default: {
                // Unknown field type — use safe defaults
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
                if (Array.isArray(value)) {
                    if (value.length === 0) return [];
                    return value;
                }
                if (typeof value === 'object') return JSON.stringify(value);
                return value;
            }
        }
    }

    // ── Heuristic fallback (no fieldType available) ──────────────────────
    // Preserves v2 behavior with bug fixes applied.

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

    // FIX #2: Empty arrays pass through
    if (Array.isArray(value) && value.length === 0) return [];

    // Integer arrays: pass as-is for link_row fields (e.g. [16, 42]).
    // FIX #1: Guard against null/undefined elements being coerced to 0
    if (Array.isArray(value) && value.length > 0 &&
        value.every(v => v !== null && v !== undefined && Number.isInteger(Number(v)) && String(v).trim() !== '')) {
        return value.map(v => Number(v));
    }

    // Everything else (string arrays, objects): serialize for text fields.
    return JSON.stringify(value);
}

// ─── Helper: Body Builders ───────────────────────────────────────────────────

/**
 * Builds a Baserow write body from a manually configured `fields` fixedCollection.
 */
function buildBodyFromFields(fieldsInput, useNames, returnRaw, nameToId, fieldTypes, fieldMeta = {}) {
    const body = {};
    for (const f of fieldsInput.field || []) {
        // Resolve field type and metadata: try by human name first, then by mapped field_id
        const ft = fieldTypes?.[f.name] || fieldTypes?.[nameToId?.[f.name]];
        const meta = fieldMeta?.[f.name] || fieldMeta?.[nameToId?.[f.name]];
        const sanitized = sanitizeWriteValue(f.value, ft, meta);
        if (sanitized === undefined) continue;
        const key = useNames && !returnRaw ? (nameToId[f.name] || f.name) : f.name;
        body[key] = sanitized;
    }
    return body;
}

/**
 * Builds a Baserow write body from the entire incoming n8n item JSON.
 */
function buildBodyFromObject(obj, useNames, returnRaw, nameToId, fieldTypes, fieldMeta = {}) {
    if (!obj) return {};
    const body = {};
    for (const [k, v] of Object.entries(obj)) {
        // Resolve field type and metadata: try by human name first, then by mapped field_id
        const ft = fieldTypes?.[k] || fieldTypes?.[nameToId?.[k]];
        const meta = fieldMeta?.[k] || fieldMeta?.[nameToId?.[k]];
        const sanitized = sanitizeWriteValue(v, ft, meta);
        if (sanitized === undefined) continue;
        const key = useNames && !returnRaw ? (nameToId[k] || k) : k;
        body[key] = sanitized;
    }
    return body;
}

// ─── Multi-Table Fetch ───────────────────────────────────────────────────────

/**
 * Fetches multiple Baserow tables in parallel using a single shared filter.
 *
 * BUG FIX #5: minFilterValue uses `!= null` instead of `!== ''` so that 0 is allowed.
 */
async function fetchMultipleTables(ctx, baseUrl, apiToken, filterField, filterValue, tables, timeout) {
    const headers = { Authorization: `Token ${apiToken}` };

    console.log(`[BaserowPlus] Fetching ${tables.length} table(s) with ${filterField}=${filterValue}`);

    const requests = tables.map((table) => {
        const params = {
            [`filter__${filterField}__equal`]: filterValue,
            size: table.limit || 100,
            user_field_names: true,
        };

        if (table.sortBy) {
            params['order_by'] = table.sortBy;
        }

        // FIX #5: Allow minFilterValue of 0 — only skip when null/undefined
        if (table.minFilterField && table.minFilterValue != null) {
            params[`filter__${table.minFilterField}__gte`] = table.minFilterValue;
        }

        return {
            name: table.name,
            returnFirst: table.returnFirst || false,
            reqOptions: {
                method: 'GET',
                uri: `${baseUrl}/api/database/rows/table/${table.tableId}/`,
                qs: params,
                headers,
                json: true,
                timeout,
            },
        };
    });

    try {
        const responses = await Promise.all(
            requests.map(async ({ name, returnFirst, reqOptions }) => {
                const response = await ctx.helpers.request(reqOptions);
                const rows = response.results || [];
                return { name, data: returnFirst ? (rows[0] || {}) : rows };
            })
        );

        const result = {};
        for (const { name, data } of responses) {
            result[name] = data;
        }

        const totalRows = Object.values(result).reduce(
            (sum, v) => sum + (Array.isArray(v) ? v.length : 1),
            0
        );
        console.log(`[BaserowPlus] Multi-table fetch complete: ${totalRows} total rows across ${tables.length} table(s)`);

        return result;
    } catch (error) {
        console.error(`[BaserowPlus] Multi-table fetch failed: ${error.message}`);
        throw error;
    }
}

// ─── Node Class ──────────────────────────────────────────────────────────────

/**
 * Baserow Plus — production-grade n8n community node for Baserow.
 *
 * Features:
 * - Field-type-aware serialization (prevents link_row/boolean/number bugs)
 * - True batch API (POST/PATCH/DELETE up to 200 rows per request)
 * - Automatic retry on 429 with exponential backoff
 * - Upsert, Lookup, and enhanced List operations
 * - Parallel multi-table fetch
 * - Configurable request timeout
 */
class BaserowPlus {
    constructor() {
        this.description = {
            displayName: 'Baserow Plus',
            name: 'baserowPlus',
            icon: 'fa:table',
            group: ['input'],
            version: 3,
            description: 'Production-grade Baserow node — field-type-aware serialization, decimal auto-normalization, human-readable errors, true batch API, upsert, lookup, retry with backoff, and parallel multi-table fetch.',
            defaults: {
                name: 'Baserow Plus',
                color: '#00aaff',
            },
            inputs: ['main'],
            outputs: ['main'],
            credentials: [
                {
                    name: 'baserowPlusApi',
                    required: true,
                },
            ],
            properties: [

                // ── Operation Selector ─────────────────────────────────────
                {
                    displayName: 'Operation',
                    name: 'operation',
                    type: 'options',
                    noDataExpression: true,
                    options: [
                        {
                            name: 'Multi-Table Fetch',
                            value: 'completeAnalysis',
                            description: 'Fetch multiple tables in parallel using a shared filter field',
                        },
                        { name: 'List',         value: 'list',        description: 'List rows with optional filters, sorting, and search' },
                        { name: 'Get',          value: 'get',         description: 'Retrieve one or more rows by ID' },
                        { name: 'Create',       value: 'create',      description: 'Create a new row' },
                        { name: 'Update',       value: 'update',      description: 'Update an existing row by ID' },
                        { name: 'Delete',       value: 'delete',      description: 'Delete a row by ID' },
                        { name: 'Batch Create', value: 'batchCreate', description: 'Create multiple rows in a single batch API call (up to 200 per request)' },
                        { name: 'Batch Update', value: 'batchUpdate', description: 'Update multiple rows in a single batch API call' },
                        { name: 'Batch Delete', value: 'batchDelete', description: 'Delete multiple rows in a single batch API call' },
                        { name: 'Upsert',       value: 'upsert',      description: 'Update if a matching row exists, otherwise create' },
                        { name: 'Lookup',       value: 'lookup',      description: 'Search for rows by field value' },
                    ],
                    default: 'list',
                },

                // ── Multi-Table Fetch ──────────────────────────────────────
                {
                    displayName: 'Filter Field',
                    name: 'filterField',
                    type: 'string',
                    default: 'analysis_id',
                    required: true,
                    displayOptions: { show: { operation: ['completeAnalysis'] } },
                    description: 'The field name used to filter rows across all tables (e.g. "analysis_id")',
                },
                {
                    displayName: 'Filter Value',
                    name: 'filterValue',
                    type: 'string',
                    default: '={{ $json.analysis_id }}',
                    required: true,
                    displayOptions: { show: { operation: ['completeAnalysis'] } },
                    description: 'The value to match in the filter field. Supports n8n expressions.',
                },
                {
                    displayName: 'Tables',
                    name: 'tables',
                    type: 'fixedCollection',
                    typeOptions: { multipleValues: true },
                    displayOptions: { show: { operation: ['completeAnalysis'] } },
                    default: {},
                    description: 'One entry per Baserow table to fetch. All tables are queried in parallel.',
                    options: [
                        {
                            displayName: 'Table',
                            name: 'table',
                            values: [
                                {
                                    displayName: 'Result Key',
                                    name: 'name',
                                    type: 'string',
                                    default: '',
                                    description: 'Key used in the output object for this table\'s data (e.g. "keywords")',
                                },
                                {
                                    displayName: 'Table ID',
                                    name: 'tableId',
                                    type: 'string',
                                    default: '',
                                    description: 'Baserow table ID (visible in the table URL: /database/TABLE_ID/)',
                                },
                                {
                                    displayName: 'Limit',
                                    name: 'limit',
                                    type: 'number',
                                    default: 100,
                                    description: 'Maximum number of rows to fetch from this table',
                                },
                                {
                                    displayName: 'Sort By',
                                    name: 'sortBy',
                                    type: 'string',
                                    default: '',
                                    description: 'Field to sort by. Prefix with "-" for descending order (e.g. "-created_on"). Leave empty for default order.',
                                },
                                {
                                    displayName: 'Return First Row Only',
                                    name: 'returnFirst',
                                    type: 'boolean',
                                    default: false,
                                    description: 'When enabled, returns the first matching row as an object instead of an array.',
                                },
                                {
                                    displayName: 'Min Filter Field',
                                    name: 'minFilterField',
                                    type: 'string',
                                    default: '',
                                    description: 'Optional: field name for an additional numeric minimum-value filter',
                                },
                                {
                                    displayName: 'Min Filter Value',
                                    name: 'minFilterValue',
                                    type: 'number',
                                    default: 0,
                                    description: 'Minimum value for the Min Filter Field. Only applied when Min Filter Field is set.',
                                },
                            ],
                        },
                    ],
                },

                // ── Standard Settings ──────────────────────────────────────
                {
                    displayName: 'Table ID',
                    name: 'tableId',
                    type: 'string',
                    default: '',
                    required: true,
                    displayOptions: { hide: { operation: ['completeAnalysis'] } },
                    description: 'Baserow table ID (visible in the table URL: /database/TABLE_ID/)',
                },
                {
                    displayName: 'Refresh Field Schema',
                    name: 'refreshSchema',
                    type: 'boolean',
                    default: false,
                    displayOptions: { hide: { operation: ['completeAnalysis'] } },
                    description: 'Force a fresh schema fetch from Baserow, bypassing the 5-minute cache.',
                },
                {
                    displayName: 'Use Field Names Mapping',
                    name: 'useNames',
                    type: 'boolean',
                    default: true,
                    displayOptions: { hide: { operation: ['completeAnalysis'] } },
                    description: 'Automatically convert between internal field IDs (field_xxx) and human-readable column names.',
                },
                {
                    displayName: 'Return Raw (No Mapping)',
                    name: 'returnRaw',
                    type: 'boolean',
                    default: false,
                    displayOptions: { hide: { operation: ['completeAnalysis'] } },
                    description: 'Return raw Baserow field keys (field_xxx) without any name conversion or value cleaning.',
                },
                {
                    displayName: 'Request Timeout (ms)',
                    name: 'requestTimeout',
                    type: 'number',
                    default: 30000,
                    description: 'Timeout for each API request in milliseconds. Increase for large batch or multi-table operations.',
                },
                {
                    displayName: 'Auto Map All Input Fields',
                    name: 'autoMapAll',
                    type: 'boolean',
                    default: true,
                    displayOptions: {
                        show: { operation: ['create', 'update', 'upsert', 'batchCreate', 'batchUpdate'] },
                    },
                    description: 'When enabled, all JSON keys from the incoming item are mapped automatically.',
                },

                // ── Field Configuration ────────────────────────────────────
                {
                    displayName: 'Fields',
                    name: 'fields',
                    type: 'fixedCollection',
                    displayOptions: { show: { operation: ['create', 'update', 'upsert'] } },
                    typeOptions: { multipleValues: true },
                    default: {},
                    description: 'Ignored when "Auto Map All Input Fields" is enabled.',
                    options: [
                        {
                            displayName: 'Field',
                            name: 'field',
                            values: [
                                {
                                    displayName: 'Name',
                                    name: 'name',
                                    type: 'options',
                                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                                    default: '',
                                },
                                {
                                    displayName: 'Value',
                                    name: 'value',
                                    type: 'string',
                                    default: '',
                                },
                            ],
                        },
                    ],
                },

                // ── List Operation ─────────────────────────────────────────
                {
                    displayName: 'Fetch All',
                    name: 'fetchAll',
                    type: 'boolean',
                    default: true,
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Automatically paginates through all rows. Disable to return a single page (up to Page Size).',
                },
                {
                    displayName: 'Page Size',
                    name: 'pageSize',
                    type: 'number',
                    default: 100,
                    typeOptions: { minValue: 1, maxValue: 200 },
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Number of rows per page (max 200).',
                },
                {
                    displayName: 'Max Records',
                    name: 'maxRecords',
                    type: 'number',
                    default: 0,
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Stop after collecting this many records. Set to 0 for unlimited.',
                },
                {
                    displayName: 'Search',
                    name: 'searchQuery',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Full-text search query. Baserow searches across all text-based fields.',
                },
                {
                    displayName: 'Include Fields',
                    name: 'includeFields',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Comma-separated field names to include in the API response (server-side filtering, reduces data transfer). Leave empty for all.',
                },
                {
                    displayName: 'Exclude Fields',
                    name: 'excludeFields',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Comma-separated field names to exclude from the API response (server-side).',
                },
                {
                    displayName: 'Sort',
                    name: 'sort',
                    type: 'fixedCollection',
                    displayOptions: { show: { operation: ['list'] } },
                    typeOptions: { multipleValues: true },
                    default: {},
                    options: [
                        {
                            displayName: 'Sort Rule',
                            name: 'field',
                            values: [
                                {
                                    displayName: 'Field',
                                    name: 'name',
                                    type: 'options',
                                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                                    default: '',
                                },
                                {
                                    displayName: 'Direction',
                                    name: 'direction',
                                    type: 'options',
                                    options: [
                                        { name: 'Ascending',  value: 'asc' },
                                        { name: 'Descending', value: 'desc' },
                                    ],
                                    default: 'asc',
                                },
                            ],
                        },
                    ],
                },
                {
                    displayName: 'Filters',
                    name: 'filters',
                    type: 'fixedCollection',
                    displayOptions: { show: { operation: ['list'] } },
                    typeOptions: { multipleValues: true },
                    default: {},
                    options: [
                        {
                            displayName: 'Filter',
                            name: 'filter',
                            values: [
                                {
                                    displayName: 'Field',
                                    name: 'field',
                                    type: 'options',
                                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                                    default: '',
                                },
                                {
                                    displayName: 'Operator',
                                    name: 'operator',
                                    type: 'options',
                                    options: [
                                        { name: 'Equal',            value: 'equal' },
                                        { name: 'Not Equal',        value: 'not_equal' },
                                        { name: 'Contains',         value: 'contains' },
                                        { name: 'Contains (case-insensitive)', value: 'icontains' },
                                        { name: 'Greater Than',     value: 'gt' },
                                        { name: 'Greater or Equal', value: 'gte' },
                                        { name: 'Less Than',        value: 'lt' },
                                        { name: 'Less or Equal',    value: 'lte' },
                                        { name: 'Blank',            value: 'blank' },
                                        { name: 'Not Blank',        value: 'not_blank' },
                                    ],
                                    default: 'equal',
                                },
                                {
                                    displayName: 'Value',
                                    name: 'value',
                                    type: 'string',
                                    default: '',
                                    description: 'Ignored for "Blank" and "Not Blank" operators.',
                                },
                            ],
                        },
                    ],
                },
                {
                    displayName: 'Select Fields',
                    name: 'selectFields',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['list'] } },
                    description: 'Comma-separated list of field names to include in the output (client-side). Leave empty to return all fields.',
                },

                // ── Get Operation ──────────────────────────────────────────
                {
                    displayName: 'Row IDs',
                    name: 'rowIds',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['get'] } },
                    description: 'A single row ID or multiple comma-separated IDs (e.g. "1,2,3").',
                },

                // ── Update / Delete ────────────────────────────────────────
                {
                    displayName: 'Row ID',
                    name: 'rowId',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['update', 'delete'] } },
                    description: 'Row ID to target. Leave empty to auto-detect from the input item\'s "id" field (works automatically after List, Get, or Lookup operations).',
                },

                // ── Batch Operations ───────────────────────────────────────
                {
                    displayName: 'Row IDs (Comma-Separated)',
                    name: 'batchRowIds',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['batchUpdate', 'batchDelete'] } },
                    description: 'Comma-separated list of row IDs. For batchUpdate with autoMapAll, leave empty and include "id" in each input item instead.',
                },
                {
                    displayName: 'Fields (Applied to Every Row)',
                    name: 'batchFields',
                    type: 'fixedCollection',
                    displayOptions: { show: { operation: ['batchUpdate'] } },
                    typeOptions: { multipleValues: true },
                    default: {},
                    description: 'The same field values are written to every row ID. Ignored when "Auto Map All Input Fields" is enabled.',
                    options: [
                        {
                            displayName: 'Field',
                            name: 'field',
                            values: [
                                {
                                    displayName: 'Name',
                                    name: 'name',
                                    type: 'options',
                                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                                    default: '',
                                },
                                {
                                    displayName: 'Value',
                                    name: 'value',
                                    type: 'string',
                                    default: '',
                                },
                            ],
                        },
                    ],
                },

                // ── Upsert ─────────────────────────────────────────────────
                {
                    displayName: 'Upsert By Field',
                    name: 'upsertField',
                    type: 'options',
                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                    default: '',
                    displayOptions: { show: { operation: ['upsert'] } },
                    description: 'Field used to look up an existing row. If a row matches, it is updated; otherwise a new row is created.',
                },

                // ── Lookup Operation ───────────────────────────────────────
                {
                    displayName: 'Lookup Field',
                    name: 'lookupField',
                    type: 'options',
                    typeOptions: { loadOptionsMethod: 'getTableFields' },
                    default: '',
                    displayOptions: { show: { operation: ['lookup'] } },
                    description: 'The field to search in.',
                },
                {
                    displayName: 'Lookup Value',
                    name: 'lookupValue',
                    type: 'string',
                    default: '',
                    displayOptions: { show: { operation: ['lookup'] } },
                    description: 'The value to search for. Supports n8n expressions.',
                },
                {
                    displayName: 'Lookup Operator',
                    name: 'lookupOperator',
                    type: 'options',
                    options: [
                        { name: 'Equal',                      value: 'equal' },
                        { name: 'Contains',                   value: 'contains' },
                        { name: 'Contains (case-insensitive)', value: 'icontains' },
                    ],
                    default: 'equal',
                    displayOptions: { show: { operation: ['lookup'] } },
                    description: 'How to match the lookup value.',
                },
                {
                    displayName: 'Max Results',
                    name: 'lookupLimit',
                    type: 'number',
                    default: 10,
                    displayOptions: { show: { operation: ['lookup'] } },
                    description: 'Maximum number of matching rows to return.',
                },
            ],
        };

        /**
         * Dynamic dropdown methods for the n8n UI.
         */
        this.methods = {
            loadOptions: {
                async getTableFields() {
                    const tableId = this.getCurrentNodeParameter('tableId');
                    const refreshSchema = this.getCurrentNodeParameter('refreshSchema') || false;
                    const { baseUrl, apiToken } = await this.getCredentials('baserowPlusApi');

                    if (!tableId) return [];

                    const base = baseUrl.replace(/\/$/, '');

                    try {
                        const { nameToId } = await getFieldMaps(this, base, apiToken, tableId, refreshSchema);
                        return Object.keys(nameToId).map((name) => ({ name, value: name }));
                    } catch (error) {
                        console.error(`[BaserowPlus] Failed to load table fields: ${error.message}`);
                        return [{ name: 'Error loading fields — check Table ID and credentials', value: '' }];
                    }
                },
            },
        };
    }

    /**
     * Main execution method called by n8n for every workflow run.
     */
    async execute() {
        const items = this.getInputData();
        const returnData = [];
        const operation = this.getNodeParameter('operation', 0);

        const { baseUrl, apiToken } = await this.getCredentials('baserowPlusApi');
        const base = baseUrl.replace(/\/$/, '');

        // ── Multi-Table Fetch ──────────────────────────────────────────────
        if (operation === 'completeAnalysis') {
            const filterField = this.getNodeParameter('filterField', 0);
            const filterValue = this.getNodeParameter('filterValue', 0);
            const tablesParam = this.getNodeParameter('tables', 0, {});
            const tables = tablesParam.table || [];

            if (!filterValue) {
                throw new Error('[BaserowPlus] Multi-Table Fetch: "Filter Value" is required.');
            }
            if (!tables.length) {
                throw new Error('[BaserowPlus] Multi-Table Fetch: Configure at least one table entry.');
            }

            try {
                const timeout = this.getNodeParameter('requestTimeout', 0, DEFAULT_TIMEOUT_MS);
                const result = await fetchMultipleTables(this, base, apiToken, filterField, filterValue, tables, timeout);
                const tokenEstimate = Math.round(JSON.stringify(result).length / 4);

                returnData.push({
                    ...result,
                    _meta: {
                        operation: 'multiTableFetch',
                        filter_field: filterField,
                        filter_value: filterValue,
                        tables_fetched: tables.length,
                        token_estimate: tokenEstimate,
                    },
                });

                return [this.helpers.returnJsonArray(returnData)];
            } catch (error) {
                if (this.continueOnFail()) {
                    returnData.push({ error: error.message, filter_value: filterValue });
                    return [this.helpers.returnJsonArray(returnData)];
                }
                throw error;
            }
        }

        // ── Shared Setup for CRUD Operations ──────────────────────────────
        const tableId    = this.getNodeParameter('tableId', 0);
        const useNames   = this.getNodeParameter('useNames', 0, true);
        const returnRaw  = this.getNodeParameter('returnRaw', 0, false);
        const refreshSchema = this.getNodeParameter('refreshSchema', 0, false);
        const timeout    = this.getNodeParameter('requestTimeout', 0, DEFAULT_TIMEOUT_MS);

        let idToName = {};
        let nameToId = {};
        let fieldTypes = {};
        let fieldMeta = {};

        if (useNames && !returnRaw) {
            const maps = await getFieldMaps(this, base, apiToken, tableId, refreshSchema, timeout);
            idToName = maps.idToName;
            nameToId = maps.nameToId;
            fieldTypes = maps.fieldTypes || {};
            fieldMeta = maps.fieldMeta || {};
        }

        const headers = { Authorization: `Token ${apiToken}` };

        /** Executes an HTTP request with retry on 429. Passes idToName for readable error messages. */
        const request = async (opts) => requestWithRetry(this, { ...opts, headers: { ...headers, ...opts.headers } }, timeout, idToName);

        /**
         * Maps a raw Baserow row to human-readable field names and cleans select values.
         */
        const mapOutput = (row) => {
            const mapped = returnRaw || !useNames ? row : mapFromIdsToNames(row, idToName);
            return cleanFieldValues(mapped);
        };

        // ── List ───────────────────────────────────────────────────────────
        if (operation === 'list') {
            const fetchAll     = this.getNodeParameter('fetchAll', 0, false);
            const size         = Math.min(Math.max(this.getNodeParameter('pageSize', 0, 100), 1), 200);
            const maxRecords   = this.getNodeParameter('maxRecords', 0, 0);
            const searchQuery  = this.getNodeParameter('searchQuery', 0, '');
            const includeFieldsStr = this.getNodeParameter('includeFields', 0, '');
            const excludeFieldsStr = this.getNodeParameter('excludeFields', 0, '');
            const selectFieldsStr = this.getNodeParameter('selectFields', 0, '');
            const selectFields = selectFieldsStr
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);

            const sortRules = this.getNodeParameter('sort', 0, {}).field || [];
            const orderBy = sortRules.length
                ? sortRules.map((s) => (s.direction === 'desc' ? `-${s.name}` : s.name)).join(',')
                : '';

            const filterRules = this.getNodeParameter('filters', 0, {}).filter || [];
            const baseQuery = { size, user_field_names: true };

            if (orderBy) baseQuery['order_by'] = orderBy;
            if (searchQuery) baseQuery['search'] = searchQuery;

            // Server-side field filtering
            if (includeFieldsStr) {
                baseQuery['include_fields'] = includeFieldsStr.split(',').map(s => s.trim()).filter(Boolean).join(',');
            }
            if (excludeFieldsStr) {
                baseQuery['exclude_fields'] = excludeFieldsStr.split(',').map(s => s.trim()).filter(Boolean).join(',');
            }

            for (const f of filterRules) {
                const key = `filter__${f.field}__${f.operator}`;
                baseQuery[key] = (f.operator === 'blank' || f.operator === 'not_blank') ? 'true' : f.value;
            }

            let page  = 1;
            let total = 0;

            while (true) {
                const res = await request({
                    method: 'GET',
                    qs: { ...baseQuery, page },
                    uri: `${base}/api/database/rows/table/${tableId}/`,
                    json: true,
                });

                const results = res.results;
                if (!results || results.length === 0) break;

                for (const row of results) {
                    let record = mapOutput(row);
                    if (selectFields.length && !returnRaw) {
                        record = pickFields(record, selectFields);
                    }
                    returnData.push(record);
                    total++;
                    if (maxRecords > 0 && total >= maxRecords) break;
                }

                if (!fetchAll) break;
                if (maxRecords > 0 && total >= maxRecords) break;
                if (results.length < size) break;
                page++;
            }

            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Get ────────────────────────────────────────────────────────────
        if (operation === 'get') {
            let rowIdsStr = this.getNodeParameter('rowIds', 0, '');
            if (typeof rowIdsStr !== 'string') rowIdsStr = String(rowIdsStr);
            const ids = rowIdsStr.split(',').map((s) => s.trim()).filter(Boolean);

            // Auto-detect: if no explicit IDs provided, pull "id" from each input item
            if (ids.length === 0) {
                for (const item of items) {
                    if (item.json && item.json.id) {
                        ids.push(String(item.json.id));
                    }
                }
            }

            if (ids.length === 0) {
                throw new Error('[BaserowPlus] No Row IDs provided. Enter IDs explicitly or ensure input items have an "id" field (e.g. from a List or Lookup operation).');
            }

            for (let i = 0; i < ids.length; i++) {
                try {
                    const rowId = Number(ids[i]);
                    const res = await request({
                        method: 'GET',
                        uri: `${base}/api/database/rows/table/${tableId}/${rowId}/`,
                        json: true,
                    });
                    returnData.push(mapOutput(res));
                } catch (error) {
                    if (this.continueOnFail()) { returnData.push({ error: error.message }); continue; }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Create ─────────────────────────────────────────────────────────
        if (operation === 'create') {
            const autoMapAll = this.getNodeParameter('autoMapAll', 0, true);
            for (let i = 0; i < items.length; i++) {
                try {
                    const body = autoMapAll
                        ? buildBodyFromObject(items[i].json, useNames, returnRaw, nameToId, fieldTypes, fieldMeta)
                        : buildBodyFromFields(this.getNodeParameter('fields', i, { field: [] }), useNames, returnRaw, nameToId, fieldTypes, fieldMeta);

                    const res = await request({
                        method: 'POST',
                        uri: `${base}/api/database/rows/table/${tableId}/`,
                        body,
                        json: true,
                    });
                    returnData.push(mapOutput(res));
                } catch (error) {
                    if (this.continueOnFail()) { returnData.push({ error: error.message }); continue; }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Update ─────────────────────────────────────────────────────────
        if (operation === 'update') {
            const autoMapAll = this.getNodeParameter('autoMapAll', 0, true);
            for (let i = 0; i < items.length; i++) {
                try {
                    let rowId = this.getNodeParameter('rowId', i, '');
                    if (!rowId && items[i].json.id) {
                        rowId = Number(items[i].json.id);
                    } else {
                        rowId = Number(rowId);
                    }
                    if (!rowId || isNaN(rowId)) {
                        throw new Error('[BaserowPlus] Row ID is required. Set it explicitly or ensure input items have an "id" field (e.g. from a List or Get operation).');
                    }
                    const body = autoMapAll
                        ? buildBodyFromObject(items[i].json, useNames, returnRaw, nameToId, fieldTypes, fieldMeta)
                        : buildBodyFromFields(this.getNodeParameter('fields', i, { field: [] }), useNames, returnRaw, nameToId, fieldTypes, fieldMeta);

                    const res = await request({
                        method: 'PATCH',
                        uri: `${base}/api/database/rows/table/${tableId}/${rowId}/`,
                        body,
                        json: true,
                    });
                    returnData.push(mapOutput(res));
                } catch (error) {
                    if (this.continueOnFail()) { returnData.push({ error: error.message }); continue; }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Delete ─────────────────────────────────────────────────────────
        if (operation === 'delete') {
            for (let i = 0; i < items.length; i++) {
                try {
                    let rowId = this.getNodeParameter('rowId', i, '');
                    if (!rowId && items[i].json.id) {
                        rowId = Number(items[i].json.id);
                    } else {
                        rowId = Number(rowId);
                    }
                    if (!rowId || isNaN(rowId)) {
                        throw new Error('[BaserowPlus] Row ID is required. Set it explicitly or ensure input items have an "id" field (e.g. from a List or Get operation).');
                    }
                    await request({
                        method: 'DELETE',
                        uri: `${base}/api/database/rows/table/${tableId}/${rowId}/`,
                        json: true,
                    });
                    returnData.push({ success: true, rowId });
                } catch (error) {
                    if (this.continueOnFail()) { returnData.push({ error: error.message }); continue; }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Batch Create (FIX #6: True Batch API) ─────────────────────────
        if (operation === 'batchCreate') {
            const autoMapAll = this.getNodeParameter('autoMapAll', 0, true);

            // Build all row bodies
            const allRows = [];
            for (let i = 0; i < items.length; i++) {
                const body = autoMapAll
                    ? buildBodyFromObject(items[i].json, useNames, returnRaw, nameToId, fieldTypes, fieldMeta)
                    : buildBodyFromFields(this.getNodeParameter('fields', i, { field: [] }), useNames, returnRaw, nameToId, fieldTypes, fieldMeta);
                allRows.push(body);
            }

            // Chunk into groups of BATCH_CHUNK_SIZE and send via batch endpoint
            const chunks = chunkArray(allRows, BATCH_CHUNK_SIZE);
            console.log(`[BaserowPlus] batchCreate: ${allRows.length} rows in ${chunks.length} chunk(s)`);

            for (const chunk of chunks) {
                try {
                    const res = await request({
                        method: 'POST',
                        uri: `${base}/api/database/rows/table/${tableId}/batch/`,
                        body: { items: chunk },
                        json: true,
                    });

                    // Batch response returns { items: [...created rows] }
                    const created = res.items || res;
                    if (Array.isArray(created)) {
                        for (const row of created) {
                            returnData.push(mapOutput(row));
                        }
                    }
                } catch (error) {
                    if (this.continueOnFail()) {
                        returnData.push({ error: error.message, chunk_size: chunk.length });
                        continue;
                    }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Batch Update (True Batch API) ──────────────────────────────────
        if (operation === 'batchUpdate') {
            const autoMapAll = this.getNodeParameter('autoMapAll', 0, true);
            let idsStr = this.getNodeParameter('batchRowIds', 0, '');
            if (typeof idsStr !== 'string') idsStr = String(idsStr);
            const explicitIds = idsStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);

            const allRows = [];

            if (autoMapAll && explicitIds.length === 0) {
                // Per-item mode: each input item has its own "id" field + data
                for (let i = 0; i < items.length; i++) {
                    const itemJson = { ...items[i].json };
                    const rowId = itemJson.id;
                    if (!rowId) {
                        if (this.continueOnFail()) {
                            returnData.push({ error: `Item ${i} missing "id" field for batch update` });
                            continue;
                        }
                        throw new Error(`[BaserowPlus] batchUpdate: Item ${i} missing "id" field. Either provide Row IDs or include "id" in each item.`);
                    }
                    delete itemJson.id;
                    const body = buildBodyFromObject(itemJson, useNames, returnRaw, nameToId, fieldTypes, fieldMeta);
                    body.id = Number(rowId);
                    allRows.push(body);
                }
            } else {
                // Shared-fields mode: same body applied to all explicit IDs
                const bodyBase = autoMapAll
                    ? buildBodyFromObject(items[0]?.json, useNames, returnRaw, nameToId, fieldTypes, fieldMeta)
                    : buildBodyFromFields(this.getNodeParameter('batchFields', 0, { field: [] }), useNames, returnRaw, nameToId, fieldTypes, fieldMeta);

                for (const id of explicitIds) {
                    allRows.push({ id, ...bodyBase });
                }
            }

            // Chunk and send via batch endpoint
            const chunks = chunkArray(allRows, BATCH_CHUNK_SIZE);
            console.log(`[BaserowPlus] batchUpdate: ${allRows.length} rows in ${chunks.length} chunk(s)`);

            for (const chunk of chunks) {
                try {
                    const res = await request({
                        method: 'PATCH',
                        uri: `${base}/api/database/rows/table/${tableId}/batch/`,
                        body: { items: chunk },
                        json: true,
                    });

                    const updated = res.items || res;
                    if (Array.isArray(updated)) {
                        for (const row of updated) {
                            returnData.push(mapOutput(row));
                        }
                    }
                } catch (error) {
                    if (this.continueOnFail()) {
                        returnData.push({ error: error.message, chunk_size: chunk.length });
                        continue;
                    }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Batch Delete (True Batch API) ──────────────────────────────────
        if (operation === 'batchDelete') {
            let idsStr = this.getNodeParameter('batchRowIds', 0);
            if (typeof idsStr !== 'string') idsStr = String(idsStr);
            const ids = idsStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);

            const chunks = chunkArray(ids, BATCH_CHUNK_SIZE);
            console.log(`[BaserowPlus] batchDelete: ${ids.length} rows in ${chunks.length} chunk(s)`);

            for (const chunk of chunks) {
                try {
                    await request({
                        method: 'POST',
                        uri: `${base}/api/database/rows/table/${tableId}/batch-delete/`,
                        body: { items: chunk },
                        json: true,
                    });

                    for (const id of chunk) {
                        returnData.push({ success: true, rowId: id });
                    }
                } catch (error) {
                    if (this.continueOnFail()) {
                        returnData.push({ error: error.message, chunk_size: chunk.length });
                        continue;
                    }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Upsert (FIX #4: matchValue resolution) ────────────────────────
        if (operation === 'upsert') {
            const autoMapAll = this.getNodeParameter('autoMapAll', 0, true);
            for (let i = 0; i < items.length; i++) {
                try {
                    const upsertField = this.getNodeParameter('upsertField', i);
                    let body;

                    if (autoMapAll) {
                        body = buildBodyFromObject(items[i].json, useNames, returnRaw, nameToId, fieldTypes, fieldMeta);
                    } else {
                        const fieldsInput = this.getNodeParameter('fields', i, { field: [] });
                        body = buildBodyFromFields(fieldsInput, useNames, returnRaw, nameToId, fieldTypes, fieldMeta);
                    }

                    // FIX #4: Read match value directly from the input item or body.
                    // The upsertField is always a human-readable name (from the dropdown).
                    // With autoMapAll, the value lives in items[i].json[upsertField].
                    // Without autoMapAll, look up from body using the mapped field key.
                    let matchValue;
                    if (autoMapAll) {
                        matchValue = items[i].json[upsertField];
                    } else {
                        // Try the mapped key in body
                        const mappedKey = useNames && !returnRaw ? (nameToId[upsertField] || upsertField) : upsertField;
                        matchValue = body[mappedKey];
                    }

                    if (matchValue === undefined || matchValue === null) {
                        throw new Error(`[BaserowPlus] Upsert field "${upsertField}" not found or has no value in provided fields.`);
                    }

                    // Search for an existing row.
                    const searchQuery = {
                        size: 1,
                        page: 1,
                        user_field_names: true,
                        [`filter__${upsertField}__equal`]: matchValue,
                    };
                    const found = await request({
                        method: 'GET',
                        qs: searchQuery,
                        uri: `${base}/api/database/rows/table/${tableId}/`,
                        json: true,
                    });

                    const existing = (found.results || [])[0];
                    if (found.count > 1) {
                        console.warn(`[BaserowPlus] Upsert: ${found.count} rows match "${upsertField}" = "${matchValue}". Updating first match (row ${existing.id}). Consider adding a unique constraint in Baserow.`);
                    }
                    let res;

                    if (existing) {
                        res = await request({
                            method: 'PATCH',
                            uri: `${base}/api/database/rows/table/${tableId}/${existing.id}/`,
                            body,
                            json: true,
                        });
                    } else {
                        res = await request({
                            method: 'POST',
                            uri: `${base}/api/database/rows/table/${tableId}/`,
                            body,
                            json: true,
                        });
                    }

                    returnData.push(mapOutput(res));
                } catch (error) {
                    if (this.continueOnFail()) { returnData.push({ error: error.message }); continue; }
                    throw error;
                }
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        // ── Lookup (NEW: standalone search operation) ──────────────────────
        if (operation === 'lookup') {
            const lookupField    = this.getNodeParameter('lookupField', 0);
            const lookupValue    = this.getNodeParameter('lookupValue', 0);
            const lookupOperator = this.getNodeParameter('lookupOperator', 0, 'equal');
            const lookupLimit    = this.getNodeParameter('lookupLimit', 0, 10);

            try {
                const searchQuery = {
                    size: lookupLimit,
                    page: 1,
                    user_field_names: true,
                    [`filter__${lookupField}__${lookupOperator}`]: lookupValue,
                };

                const res = await request({
                    method: 'GET',
                    qs: searchQuery,
                    uri: `${base}/api/database/rows/table/${tableId}/`,
                    json: true,
                });

                const rows = res.results || [];
                for (const row of rows) {
                    returnData.push(mapOutput(row));
                }

                if (rows.length === 0) {
                    returnData.push({
                        _lookup: {
                            field: lookupField,
                            value: lookupValue,
                            operator: lookupOperator,
                            found: 0,
                        },
                    });
                }
            } catch (error) {
                if (this.continueOnFail()) { returnData.push({ error: error.message }); }
                else throw error;
            }
            return [this.helpers.returnJsonArray(returnData)];
        }

        return [this.helpers.returnJsonArray(returnData)];
    }
}

exports.BaserowPlus = BaserowPlus;

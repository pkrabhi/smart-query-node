'use strict';
/**
 * schemaDiscoveryService.js
 * ─────────────────────────────────────────────
 * Zero-shot schema auto-discovery engine.
 *
 * Introspects the live PostgreSQL database using information_schema and
 * pg_catalog to automatically build a full schema context — tables, columns,
 * types, PKs, FKs, check constraints, row counts, cardinality stats, and
 * sample values for low-cardinality columns.
 *
 * Output format is directly compatible with the existing schema_context.json
 * and alias_mapping.json structures so it plugs into PromptBuilder as-is.
 */

const crypto = require('crypto');
const pool   = require('../config/database');
const config = require('../config');

const MODULE_SCHEMA_MAP = {
    MARKET:      config.db.schemas.market      || 'mrkt_kmc2_data',
    ENGINEERING: config.db.schemas.engineering || 'public'
};

// ─────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────
async function discoverSchema(moduleCode) {
    const key        = moduleCode.toUpperCase();
    const schemaName = MODULE_SCHEMA_MAP[key];
    if (!schemaName) throw new Error(`Unknown module: ${moduleCode}`);

    console.log(`[SchemaDiscovery:${key}] Discovering schema '${schemaName}'…`);
    const t0 = Date.now();

    const client = await pool.connect();
    try {
        // All introspection queries run in parallel for speed
        const [tablesRes, colsRes, pkRes, fkRes, checkRes, rowsRes, statsRes] =
            await Promise.all([

            // 1. Tables
            client.query(`
                SELECT table_name
                FROM   information_schema.tables
                WHERE  table_schema = $1 AND table_type = 'BASE TABLE'
                ORDER  BY table_name`, [schemaName]),

            // 2. Columns (with full type info)
            client.query(`
                SELECT table_name, column_name, data_type, udt_name,
                       is_nullable, column_default,
                       character_maximum_length, numeric_precision, numeric_scale,
                       ordinal_position
                FROM   information_schema.columns
                WHERE  table_schema = $1
                ORDER  BY table_name, ordinal_position`, [schemaName]),

            // 3. Primary keys
            client.query(`
                SELECT tc.table_name, kcu.column_name
                FROM   information_schema.table_constraints   tc
                JOIN   information_schema.key_column_usage    kcu
                    ON tc.constraint_name = kcu.constraint_name
                   AND tc.table_schema    = kcu.table_schema
                WHERE  tc.constraint_type = 'PRIMARY KEY'
                  AND  tc.table_schema    = $1`, [schemaName]),

            // 4. Foreign keys
            client.query(`
                SELECT tc.table_name  AS from_table,
                       kcu.column_name AS from_col,
                       ccu.table_name  AS to_table,
                       ccu.column_name AS to_col
                FROM   information_schema.table_constraints      tc
                JOIN   information_schema.key_column_usage       kcu
                    ON tc.constraint_name  = kcu.constraint_name
                   AND tc.table_schema     = kcu.table_schema
                JOIN   information_schema.referential_constraints rc
                    ON tc.constraint_name  = rc.constraint_name
                   AND tc.table_schema     = rc.constraint_schema
                JOIN   information_schema.constraint_column_usage ccu
                    ON rc.unique_constraint_name   = ccu.constraint_name
                   AND rc.unique_constraint_schema = ccu.table_schema
                WHERE  tc.constraint_type = 'FOREIGN KEY'
                  AND  tc.table_schema    = $1`, [schemaName]),

            // 5. Check constraints (exclude NOT NULL auto-generated ones)
            client.query(`
                SELECT tc.table_name, cc.check_clause
                FROM   information_schema.table_constraints  tc
                JOIN   information_schema.check_constraints  cc
                    ON tc.constraint_name  = cc.constraint_name
                   AND tc.table_schema     = cc.constraint_schema
                WHERE  tc.constraint_type = 'CHECK'
                  AND  tc.table_schema    = $1
                  AND  cc.check_clause NOT ILIKE '%IS NOT NULL%'`, [schemaName]),

            // 6. Approximate row counts (pg_stat_user_tables — no full scan)
            client.query(`
                SELECT relname AS table_name,
                       n_live_tup AS row_count
                FROM   pg_stat_user_tables
                WHERE  schemaname = $1`, [schemaName]),

            // 7. Column statistics (cardinality, null rate, most common values)
            client.query(`
                SELECT tablename, attname AS col,
                       n_distinct, null_frac,
                       most_common_vals, most_common_freqs
                FROM   pg_stats
                WHERE  schemaname = $1`, [schemaName]),
        ]);

        // ── Build lookup maps ────────────────────────────────────────────

        // table → Set<pk_columns>
        const pkMap = new Map();
        for (const r of pkRes.rows) {
            if (!pkMap.has(r.table_name)) pkMap.set(r.table_name, new Set());
            pkMap.get(r.table_name).add(r.column_name);
        }

        // "table.col" → "to_table.to_col"
        const fkMap = new Map();
        for (const r of fkRes.rows) {
            fkMap.set(`${r.from_table}.${r.from_col}`, `${r.to_table}.${r.to_col}`);
        }

        // table → [clause, …]
        const checkMap = new Map();
        for (const r of checkRes.rows) {
            if (!checkMap.has(r.table_name)) checkMap.set(r.table_name, []);
            checkMap.get(r.table_name).push(r.check_clause);
        }

        // table → row_count
        const rowMap = new Map();
        for (const r of rowsRes.rows) rowMap.set(r.table_name, parseInt(r.row_count) || 0);

        // "table.col" → stats
        const statMap = new Map();
        for (const r of statsRes.rows) {
            statMap.set(`${r.tablename}.${r.col}`, {
                nDistinct:       parseFloat(r.n_distinct),
                nullFrac:        parseFloat(r.null_frac),
                mostCommonVals:  r.most_common_vals,
            });
        }

        // table → [columns, …]
        const colsByTable = new Map();
        for (const r of colsRes.rows) {
            if (!colsByTable.has(r.table_name)) colsByTable.set(r.table_name, []);
            colsByTable.get(r.table_name).push(r);
        }

        // ── Build schema output ──────────────────────────────────────────

        // Pre-pass: detect alias collisions so no table is silently dropped.
        // When two tables produce the same alias (e.g. coll_sequence_mst and
        // mrkt_sequence_mst both → "sequence"), ALL colliding tables fall back
        // to their real table name as alias so every table is preserved.
        const _aliasBucket = {};
        for (const { table_name: t } of tablesRes.rows) {
            const a = tableAlias(t);
            if (!_aliasBucket[a]) _aliasBucket[a] = [];
            _aliasBucket[a].push(t);
        }
        const _collidingTables = new Set();
        for (const [alias, tbls] of Object.entries(_aliasBucket)) {
            if (tbls.length > 1) {
                console.warn(`[SchemaDiscovery:${key}] Alias collision '${alias}': [${tbls.join(', ')}] — using real table names for all`);
                tbls.forEach(t => _collidingTables.add(t));
            }
        }

        const tables        = {};   // alias → table definition
        const aliasTables   = {};   // for alias_mapping.tables
        const businessRules = [];

        for (const { table_name: tbl } of tablesRes.rows) {
            const rowCount  = rowMap.get(tbl) || 0;
            const pks       = pkMap.get(tbl) || new Set();
            const checks    = checkMap.get(tbl) || [];
            // Use real table name as alias if it would collide with another table
            const tblAlias  = _collidingTables.has(tbl) ? tbl : tableAlias(tbl);
            const colAliasMap = {}; // colAlias → realColName

            const keyColumns = {};

            for (const col of colsByTable.get(tbl) || []) {
                const realCol = col.column_name;
                const statKey = `${tbl}.${realCol}`;
                const stats   = statMap.get(statKey);
                const fkKey   = `${tbl}.${realCol}`;
                const fkTarget= fkMap.get(fkKey);
                const isPk    = pks.has(realCol);

                const info = {
                    type: friendlyType(col.data_type, col.udt_name),
                };
                if (isPk)     info.pk  = true;
                if (fkTarget) info.fk  = fkTarget;
                if (col.is_nullable === 'NO' && !isPk) info.required = true;

                // Enrich with statistics
                if (stats) {
                    const nd = stats.nDistinct;
                    if (stats.nullFrac > 0.1) info.nullRate = `${Math.round(stats.nullFrac * 100)}%`;

                    // Low-cardinality: extract actual enum-like values
                    if (nd > 0 && nd <= 25 && stats.mostCommonVals) {
                        const vals = parsePgArray(stats.mostCommonVals);
                        if (vals.length > 0) {
                            info.values = vals.slice(0, 15);
                            businessRules.push(
                                `${tbl}.${realCol} distinct values (${vals.length}): ` +
                                vals.slice(0, 10).map(v => `'${v}'`).join(', ')
                            );
                        }
                    }
                }

                // ── KEY FIX: use real column names, NO column-level aliasing ──
                // If we alias columns (e.g. mrkt_stall_id → stall_id), the same
                // alias appears in 30+ tables, generating 30 identical replacements.
                // replaceAliasesWithReal applies them sequentially: each pass finds
                // "stall_id" inside the previous output "mrkt_stall_id" and prepends
                // another "mrkt_", resulting in mrkt_mrkt_...mrkt_ × N iterations.
                // Using real column names in the schema avoids this entirely — the
                // LLM writes real column names and no column swap is needed.
                keyColumns[realCol] = info;
                // colAliasMap intentionally left empty — no column aliases
            }

            // Check constraint → business rule
            for (const clause of checks) {
                businessRules.push(`${tbl} constraint: ${clause}`);
            }

            tables[tblAlias] = {
                real_name:   tbl,
                description: tableDescription(tbl, rowCount, Object.keys(keyColumns)),
                row_count:   rowCount,
                key_columns: keyColumns,
            };

            aliasTables[tblAlias] = {
                real_name: tbl,
                columns:   colAliasMap,
            };
        }

        // Semantic relationship hints (name-pattern FK detection)
        const semanticRules = detectSemanticRelationships(tables);

        const uniqueTableCount = Object.keys(tables).length;
        const schema = {
            module:        key,
            schema_name:   schemaName,
            discovered_at: new Date().toISOString(),
            table_count:   uniqueTableCount,
            tables,
            important_rules: [...businessRules, ...semanticRules],
            alias_mapping: {
                schema_real:  schemaName,
                schema_alias: 'data_schema',
                tables:       aliasTables,
            },
        };

        const hash        = computeHash(tables);
        schema._hash      = hash;

        const elapsed = Date.now() - t0;
        const collisionNote = _collidingTables.size > 0
            ? ` (${_collidingTables.size} alias collisions resolved, all tables preserved)`
            : '';
        console.log(`[SchemaDiscovery:${key}] Done — ${uniqueTableCount} tables (${tablesRes.rows.length} from DB), ${colsRes.rows.length} columns, ${elapsed}ms${collisionNote}`);

        return { schema, hash, discoveryMs: elapsed };

    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────
//  Convert discovered schema to schema_context.json-compatible format
// ─────────────────────────────────────────────
function toSchemaContext(discoveredSchema) {
    return {
        tables:          discoveredSchema.tables,
        important_rules: discoveredSchema.important_rules || [],
    };
}

// ─────────────────────────────────────────────
//  Alias generators
// ─────────────────────────────────────────────

/** mrkt_stall_mst → stall,  eng_tender_hdr → tender_header */
function tableAlias(tableName) {
    let a = tableName.toLowerCase();

    // Strip known module prefixes
    for (const pfx of ['mrkt_', 'eng_', 'engg_', 'coll_', 'pub_', 'kmc_']) {
        if (a.startsWith(pfx)) { a = a.slice(pfx.length); break; }
    }

    // Normalize common suffixes
    const suffixes = [
        ['_master', ''], ['_mst', ''], ['_hdr', '_header'], ['_dtl', '_detail'],
        ['_trns', '_transactions'], ['_trn', '_transaction'],
        ['_hist', '_history'], ['_tmp', '_temp'],
        ['_cfg', '_config'],   ['_ref', ''],
    ];
    for (const [s, r] of suffixes) {
        if (a.endsWith(s)) { a = a.slice(0, -s.length) + r; break; }
    }

    return a.replace(/_+$/, '') || tableName;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function friendlyType(dataType, udtName) {
    const map = {
        'character varying':             'varchar',
        'character':                     'char',
        'integer':                       'int',
        'bigint':                        'bigint',
        'smallint':                      'smallint',
        'numeric':                       'numeric',
        'double precision':              'float',
        'real':                          'float',
        'boolean':                       'bool',
        'timestamp without time zone':   'timestamp',
        'timestamp with time zone':      'timestamptz',
        'date':                          'date',
        'time without time zone':        'time',
        'text':                          'text',
        'json':                          'json',
        'jsonb':                         'jsonb',
        'uuid':                          'uuid',
        'bytea':                         'bytes',
        'USER-DEFINED':                  udtName || 'enum',
        'ARRAY':                         `${udtName || 'array'}[]`,
    };
    return map[dataType] || dataType;
}

/**
 * Generate a rich description that embeds column-derived keywords.
 * This is critical for RAG/BM25 table selection — thin descriptions like
 * "Meter conn (500 rows)" score near-zero for "electricity connections".
 * By surfacing column keywords (meter_type, unit_consumed, connection_date…)
 * BM25 can correctly rank this table for electricity-related questions.
 */
function tableDescription(tableName, rowCount, columnNames = []) {
    const label = tableName
        .replace(/^(mrkt_|eng_|engg_|coll_|pub_|kmc_)/, '')
        .replace(/_(mst|master)$/, ' master')
        .replace(/_hdr$/, ' header')
        .replace(/_dtl$/, ' detail')
        .replace(/_trn(s)?$/, ' transaction')
        .replace(/_hist$/, ' history')
        .replace(/_/g, ' ')
        .trim();
    const cap = label.charAt(0).toUpperCase() + label.slice(1);

    // Extract semantic keywords from column names (strip module prefix, dedupe)
    const keywords = [...new Set(
        columnNames
            .map(c => c
                .replace(/^(mrkt_|eng_|engg_|coll_|pub_|kmc_)/, '')
                .replace(/_id$|_cd$|_no$|_pk$/, '')
                .replace(/_/g, ' ')
                .trim()
            )
            .filter(k => k.length > 2 && k !== label.toLowerCase())
            .slice(0, 8)          // up to 8 extra keywords
    )].join(', ');

    const rowLabel = rowCount > 0 ? ` (${rowCount.toLocaleString()} rows)` : '';
    return keywords ? `${cap}${rowLabel} — ${keywords}` : `${cap}${rowLabel}`;
}

function parsePgArray(pgStr) {
    if (!pgStr) return [];
    try {
        const inner = String(pgStr).trim().replace(/^\{/, '').replace(/\}$/, '');
        return inner
            .split(',')
            .map(v => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
            .filter(Boolean);
    } catch { return []; }
}

/** Semantic FK detection: if "stall_id" exists in multiple tables and is PK in one, infer FK */
function detectSemanticRelationships(tables) {
    const rules = [];
    const pkLookup = {}; // colName → tableAlias (where it is PK)

    for (const [alias, tbl] of Object.entries(tables)) {
        for (const [col, info] of Object.entries(tbl.key_columns || {})) {
            if (info.pk) pkLookup[col] = alias;
        }
    }

    for (const [alias, tbl] of Object.entries(tables)) {
        for (const [col, info] of Object.entries(tbl.key_columns || {})) {
            if (info.pk || info.fk) continue; // already documented
            const pkOwner = pkLookup[col];
            if (pkOwner && pkOwner !== alias) {
                rules.push(`${alias}.${col} likely references ${pkOwner}.${col} (inferred by name match)`);
            }
        }
    }

    return rules.slice(0, 15); // cap
}

function computeHash(tables) {
    const fingerprint = Object.entries(tables)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, t]) => `${name}:${Object.keys(t.key_columns || {}).sort().join(',')}`)
        .join('|');
    return crypto.createHash('md5').update(fingerprint).digest('hex');
}

module.exports = { discoverSchema, toSchemaContext };

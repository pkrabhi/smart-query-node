'use strict';
/**
 * schemaCacheService.js
 * ─────────────────────────────────────────────
 * In-memory TTL cache for auto-discovered schemas with:
 *  • Hash-based change detection (alerts when DB schema drifts)
 *  • Snapshot persistence for diff comparison across restarts
 *  • warmAll() for startup pre-warming
 *  • getStatus() for API introspection
 */

const fs   = require('fs');
const path = require('path');
const { discoverSchema } = require('./schemaDiscoveryService');

const TTL_MS = (parseInt(process.env.SCHEMA_DISCOVERY_TTL_SECONDS) || 3600) * 1000; // 1h default

// moduleCode → { schema, hash, discoveredAt, expiresAt, prevHash, changed, discoveryMs }
const cache = new Map();

const SNAPSHOT_DIR = path.resolve(__dirname, '../resources/smartquery');

// ─────────────────────────────────────────────
//  Get schema — from cache or discover
// ─────────────────────────────────────────────
async function getSchema(moduleCode) {
    const key    = moduleCode.toUpperCase();
    const cached = cache.get(key);

    if (cached && Date.now() < cached.expiresAt) {
        const ageS = Math.round((Date.now() - cached.discoveredAt) / 1000);
        const ttlS = Math.round((cached.expiresAt - Date.now()) / 1000);
        console.log(`[SchemaCache:${key}] HIT (age ${ageS}s, TTL ${ttlS}s remaining)`);
        return { ...cached, fromCache: true };
    }

    return await _refresh(key);
}

// ─────────────────────────────────────────────
//  Force-refresh a module's schema
// ─────────────────────────────────────────────
async function refresh(moduleCode) {
    return await _refresh(moduleCode.toUpperCase());
}

async function _refresh(key) {
    console.log(`[SchemaCache:${key}] Refreshing…`);
    const prev = cache.get(key);

    const { schema, hash, discoveryMs } = await discoverSchema(key);

    const changed = !!(prev && prev.hash !== hash);
    if (changed) {
        console.warn(`[SchemaCache:${key}] ⚠ SCHEMA CHANGED — hash ${prev.hash} → ${hash}`);
        _saveSnapshot(key, prev.schema, 'prev');
    }
    _saveSnapshot(key, schema, 'latest');

    const entry = {
        schema,
        hash,
        discoveredAt: Date.now(),
        expiresAt:    Date.now() + TTL_MS,
        prevHash:     prev?.hash || null,
        changed,
        discoveryMs,
        fromCache:    false,
    };
    cache.set(key, entry);
    return entry;
}

// ─────────────────────────────────────────────
//  Diff — compare latest snapshot with previous
// ─────────────────────────────────────────────
function getDiff(moduleCode) {
    const key = moduleCode.toUpperCase();

    if (!cache.has(key)) {
        return { available: false, message: 'Schema not yet discovered for this module.' };
    }

    const latestPath = _snapPath(key, 'latest');
    const prevPath   = _snapPath(key, 'prev');

    if (!fs.existsSync(prevPath)) {
        return { available: true, changed: false, message: 'No previous snapshot available — this is the first discovery.' };
    }

    try {
        const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
        const prev   = JSON.parse(fs.readFileSync(prevPath,   'utf8'));

        const latestTbls = new Set(Object.keys(latest.tables || {}));
        const prevTbls   = new Set(Object.keys(prev.tables   || {}));

        const addedTables   = [...latestTbls].filter(t => !prevTbls.has(t));
        const removedTables = [...prevTbls].filter(t => !latestTbls.has(t));
        const modifiedTables = [];

        for (const tbl of latestTbls) {
            if (!prevTbls.has(tbl)) continue;
            const lCols = new Set(Object.keys(latest.tables[tbl].key_columns || {}));
            const pCols = new Set(Object.keys(prev.tables[tbl].key_columns   || {}));
            const added   = [...lCols].filter(c => !pCols.has(c));
            const removed = [...pCols].filter(c => !lCols.has(c));

            // Detect type changes
            const typeChanges = [];
            for (const c of lCols) {
                if (!pCols.has(c)) continue;
                const lt = latest.tables[tbl].key_columns[c]?.type;
                const pt = prev.tables[tbl].key_columns[c]?.type;
                if (lt && pt && lt !== pt) typeChanges.push({ column: c, from: pt, to: lt });
            }

            if (added.length || removed.length || typeChanges.length) {
                modifiedTables.push({ table: tbl, addedColumns: added, removedColumns: removed, typeChanges });
            }
        }

        const entry = cache.get(key);
        return {
            available:      true,
            changed:        addedTables.length > 0 || removedTables.length > 0 || modifiedTables.length > 0,
            addedTables,
            removedTables,
            modifiedTables,
            currentHash:    entry?.hash,
            prevHash:       entry?.prevHash,
            prevDiscoveredAt:    prev.discovered_at,
            currentDiscoveredAt: latest.discovered_at,
        };
    } catch (e) {
        return { available: false, message: `Diff error: ${e.message}` };
    }
}

// ─────────────────────────────────────────────
//  Status — cache metadata for all modules
// ─────────────────────────────────────────────
function getStatus() {
    const out = {};
    for (const [key, entry] of cache.entries()) {
        out[key] = {
            hash:               entry.hash,
            tableCount:         Object.keys(entry.schema.tables || {}).length,
            discoveredAt:       new Date(entry.discoveredAt).toISOString(),
            expiresAt:          new Date(entry.expiresAt).toISOString(),
            ageSeconds:         Math.round((Date.now() - entry.discoveredAt) / 1000),
            ttlRemainingSeconds: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
            lastDiscoveryMs:    entry.discoveryMs,
            schemaChanged:      entry.changed,
        };
    }
    return out;
}

// ─────────────────────────────────────────────
//  Pre-warm all modules at startup
// ─────────────────────────────────────────────
async function warmAll() {
    for (const mod of ['MARKET', 'ENGINEERING']) {
        try {
            await _refresh(mod);
            console.log(`[SchemaCache:${mod}] Pre-warmed successfully`);
        } catch (e) {
            console.warn(`[SchemaCache:${mod}] Pre-warm failed (will retry on first request): ${e.message}`);
        }
    }
}

// ─────────────────────────────────────────────
//  Snapshot helpers
// ─────────────────────────────────────────────
function _snapPath(moduleCode, type) {
    return path.join(SNAPSHOT_DIR, moduleCode.toLowerCase(), 'schema_snapshots', `schema_${type}.json`);
}

function _saveSnapshot(moduleCode, schema, type) {
    try {
        const p   = _snapPath(moduleCode, type);
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify(schema, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[SchemaCache:${moduleCode}] Snapshot save failed (${type}): ${e.message}`);
    }
}

module.exports = { getSchema, refresh, getDiff, getStatus, warmAll };

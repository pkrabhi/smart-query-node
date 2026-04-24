const NodeCache = require('node-cache');
const crypto = require('crypto');
const config = require('../config');

// ─────────────────────────────────────────────
//  Query Cache
//  Caches LLM-generated SQL for identical questions.
//  Cache key = hash(question + moduleCode + filters).
//  Saves 2–13s per repeated query + reduces API costs.
// ─────────────────────────────────────────────

class QueryCache {

    constructor() {
        this.enabled = config.cache.enabled;
        this.cache = new NodeCache({
            stdTTL: config.cache.ttlSeconds,      // Default: 10 minutes
            maxKeys: config.cache.maxKeys,         // Default: 200 entries
            checkperiod: 120,                       // Cleanup every 2 min
            useClones: false,                       // Performance: don't deep-clone
        });

        this.stats = { hits: 0, misses: 0, sets: 0 };

        if (this.enabled) {
            console.log(`[Cache] Initialized — TTL: ${config.cache.ttlSeconds}s, maxKeys: ${config.cache.maxKeys}`);
        } else {
            console.log('[Cache] DISABLED by config');
        }
    }

    /**
     * Build a deterministic cache key from query parameters.
     * ✅ FIX: Only hash actual filter fields — NOT userId/previousSql/previousQuestion.
     * Previously the full request object was passed as filters, so two different users
     * asking the exact same question got different cache keys (cache never hit).
     */
    _buildKey(question, moduleCode, filters = {}) {
        const normalizedQ = question.trim().toLowerCase();

        // Whitelist only real context filter fields — exclude request metadata
        const FILTER_KEYS = [
            'marketCode', 'phaseCode', 'blockCode', 'stallId', 'wardNo', 'finYear',
            'fileNo', 'tenderNo', 'poNumber', 'deptCode', 'borough', 'contractorCode'
        ];

        const sortedFilters = FILTER_KEYS
            .filter(k => filters[k] && String(filters[k]).trim())
            .map(k => `${k}=${String(filters[k]).trim().toLowerCase()}`)
            .join('|');

        const raw = `${moduleCode}::${normalizedQ}::${sortedFilters}`;
        return crypto.createHash('md5').update(raw).digest('hex');
    }

    /**
     * Get cached SQL for a question.
     * Returns { hit: true, sql, source } or { hit: false }
     */
    get(question, moduleCode, filters) {
        if (!this.enabled) return { hit: false };

        const key = this._buildKey(question, moduleCode, filters);
        const cached = this.cache.get(key);

        if (cached) {
            this.stats.hits++;
            console.log(`[Cache] HIT — key: ${key.slice(0, 12)}… (${this.stats.hits} total hits)`);
            return { hit: true, ...cached };
        }

        this.stats.misses++;
        return { hit: false };
    }

    /**
     * Cache generated SQL after successful LLM call.
     */
    set(question, moduleCode, filters, data) {
        if (!this.enabled) return;

        const key = this._buildKey(question, moduleCode, filters);
        this.cache.set(key, {
            sql: data.sql,
            source: data.source + ' (cached)',
            cachedAt: new Date().toISOString(),
        });
        this.stats.sets++;
        console.log(`[Cache] SET — key: ${key.slice(0, 12)}… (${this.cache.keys().length} entries)`);
    }

    /**
     * Flush all cached entries.
     */
    flush() {
        const count = this.cache.keys().length;
        this.cache.flushAll();
        console.log(`[Cache] Flushed ${count} entries`);
        return count;
    }

    /**
     * Get cache statistics.
     */
    getStats() {
        return {
            enabled: this.enabled,
            entries: this.cache.keys().length,
            hits: this.stats.hits,
            misses: this.stats.misses,
            sets: this.stats.sets,
            hitRate: this.stats.hits + this.stats.misses > 0
                ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1) + '%'
                : '0%',
            ttlSeconds: config.cache.ttlSeconds,
            maxKeys: config.cache.maxKeys,
        };
    }
}

module.exports = new QueryCache();

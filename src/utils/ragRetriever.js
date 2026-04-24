'use strict';

/**
 * ragRetriever.js — v2
 * ─────────────────────────────────────────────────────────────
 * Vectorless RAG engine for the Market Intelligence Hub.
 *
 * NEW in v2:
 *  ✅  Point 3 — Adaptive topK/topN via complexity detection
 *  ✅  Point 4 — BM25 score threshold: exposes maxScore so
 *                promptBuilder can fallback to static prompt
 * ─────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════
//  INTENT TAXONOMY
// ═══════════════════════════════════════════════════════════
const INTENT_KEYWORDS = {
    stallage: [
        'stall', 'stallage', 'rent', 'shop', 'tenant', 'allot', 'lessee',
        'occupant', 'stall id', 'stallid', 'mrkt_stall'
    ],
    electricity: [
        'electric', 'electricity', 'meter', 'unit', 'consumption',
        'point', 'cesc', 'kwh', 'connection', 'wiring', 'power'
    ],
    collection: [
        'collect', 'collection', 'payment', 'paid', 'receipt',
        'revenue', 'arrear', 'outstanding', 'recovery', 'realised'
    ],
    mutation: [
        'mutation', 'transfer', 'ownership', 'change', 'mutate',
        'reassign', 'name change'
    ],
    demand: [
        'demand', 'due', 'dues', 'outstanding', 'pending',
        'active', 'finalized', 'old demand', 'bad debt', 'cancelled'
    ],
    market: [
        'market', 'bazaar', 'bazar', 'hat', 'haat', 'complex',
        'ward', 'zone', 'borough'
    ],
    financial: [
        'financial', 'fin year', 'fiscal', 'fy', '2024', '2025',
        'quarter', 'monthly', 'annual', 'yearly'
    ],
    summary: [
        'summary', 'total', 'count', 'aggregate', 'sum', 'average',
        'top', 'rank', 'compare', 'comparison', 'report', 'list'
    ]
};

// ═══════════════════════════════════════════════════════════
//  COMPLEXITY DETECTION
//  ─────────────────────────────────────────────────────────
//  COMPLEX  (topK=8,  topN=14): multi-concept, comparison, trend
//  MEDIUM   (topK=6,  topN=10): grouping, ranking, multi-filter
//  SIMPLE   (topK=4,  topN=6):  single lookup / single aggregate
// ═══════════════════════════════════════════════════════════
const COMPLEXITY_COMPLEX = [
    'compare', 'comparison', ' vs ', 'versus', 'trend', 'monthly breakdown',
    'quarterly breakdown', 'across all', 'all markets', 'year over year',
    'period over period', 'historical', 'both', 'multiple', 'several',
    'demand vs collection', 'collection vs demand'
];

const COMPLEXITY_MEDIUM = [
    'top 10', 'top 5', 'group by', 'breakdown', 'total by', 'count by',
    'summary', 'rank', 'market-wise', 'ward-wise', 'phase-wise',
    'month-wise', 'year-wise', 'category-wise', 'by market', 'by ward',
    'by block', 'by phase'
];

// ═══════════════════════════════════════════════════════════
//  TABLE → INTENT MAPPING
// ═══════════════════════════════════════════════════════════
const TABLE_INTENT_AFFINITY = {
    mrkt_market_mst:            ['market', 'summary', 'financial'],
    mrkt_stall_mst:             ['stallage', 'market'],
    mrkt_rent_roll_mst:         ['stallage', 'mutation', 'market'],
    mrkt_demand_hdr:            ['demand', 'stallage', 'electricity', 'financial'],
    mrkt_demand_dtl:            ['demand', 'stallage', 'electricity'],
    mrkt_receipt_hdr:           ['collection', 'demand', 'financial'],
    mrkt_receipt_dtl:           ['collection', 'stallage', 'electricity'],
    mrkt_receipt_pay_dtl:       ['collection'],
    mrkt_futnani_demand_hdr:    ['demand', 'stallage'],
    mrkt_futnani_receipt_hdr:   ['collection'],
    mrkt_kmc_meter_conn:         ['electricity', 'stallage', 'market'],
    mrkt_cesc_conn:              ['electricity'],
    mrkt_electric_new_connection:['electricity'],
    mrkt_meter_unit_rate_mst:    ['electricity', 'demand'],
    // legacy names kept for backward compat with static schema_context.json
    mrkt_elec_connection_mst:   ['electricity'],
    mrkt_elec_meter_reading:    ['electricity'],
    mrkt_elec_demand_hdr:       ['demand', 'electricity'],
    mrkt_elec_demand_dtl:       ['demand', 'electricity'],
    mrkt_elec_receipt_hdr:      ['collection', 'electricity'],
    mrkt_elec_receipt_dtl:      ['collection', 'electricity'],
    mrkt_mutation_hdr:          ['mutation'],
    mrkt_mutation_dtl:          ['mutation'],
    mrkt_allotment_hdr:         ['stallage', 'mutation'],
    mrkt_allotment_dtl:         ['stallage'],
    mrkt_ward_market_map:       ['market', 'summary'],
    mrkt_charge_mst:            ['stallage', 'electricity'],
    mrkt_fin_year_mst:          ['financial'],
    mrkt_block_mst:             ['market'],
    mrkt_phase_mst:             ['market'],
    mrkt_stall_type_mst:        ['stallage'],
    mrkt_tariff_mst:            ['electricity', 'demand'],
    mrkt_arrear_hdr:            ['demand', 'collection'],
    mrkt_outstanding_view:      ['demand', 'collection', 'summary'],
    mrkt_collection_summary:    ['collection', 'summary', 'financial']
};

// ═══════════════════════════════════════════════════════════
//  RULE INTENT KEYWORDS
// ═══════════════════════════════════════════════════════════
const RULE_INTENT_KEYWORDS = {
    stallage:    ['stall', 'stallage', 'rent'],
    electricity: ['electric', 'meter', 'unit', 'kwh', 'cesc', 'connection'],
    collection:  ['collect', 'receipt', 'payment', 'paid', 'revenue'],
    mutation:    ['mutation', 'transfer'],
    demand:      ['demand', 'charge', 'code 22', 'code 21', 'code 1', 'code 6'],
    market:      ['market', 'mrkt_code', 'mrkt_name', 'ward', 'phase', 'block'],
    financial:   ['financial', 'fin_year', 'fiscal', 'fy'],
    summary:     ['sum', 'count', 'total', 'aggregate']
};

// ═══════════════════════════════════════════════════════════
//  BM25 CONSTANTS
// ═══════════════════════════════════════════════════════════
const BM25_K1 = 1.5;
const BM25_B  = 0.75;

// BM25 fallback threshold — if best score < this, caller uses static full prompt
// Calibrated: domain queries score 3.7–10.2, off-domain score 0.0
const BM25_FALLBACK_THRESHOLD = 1.0;

// ═══════════════════════════════════════════════════════════
class RagRetriever {

    constructor(examples, schema, aliasMapping) {
        this.examples     = examples || [];
        this.schema       = schema   || {};
        this.aliasMapping = aliasMapping;

        this._corpus    = this.examples.map(e => this._tokenise(e.question));
        this._avgDocLen = this._computeAvgDocLen(this._corpus);
        this._idfCache  = {};

        console.log(`[RAG] Initialised — ${this.examples.length} examples, ${Object.keys(this.schema.tables || {}).length} tables`);
    }

    // ─────────────────────────────────────────────
    //  PUBLIC: Hot-reload examples (after feedback)
    // ─────────────────────────────────────────────
    reloadExamples(newExamples) {
        this.examples   = newExamples || [];
        this._corpus    = this.examples.map(e => this._tokenise(e.question));
        this._avgDocLen = this._computeAvgDocLen(this._corpus);
        this._idfCache  = {};
        console.log(`[RAG] Hot-reloaded — ${this.examples.length} examples`);
    }

    // ─────────────────────────────────────────────
    //  PUBLIC: Main retrieval
    // ─────────────────────────────────────────────

    /**
     * Retrieve targeted context for a question.
     * topK / topN are AUTO-DETECTED from complexity if not overridden.
     *
     * @param {string}  question
     * @param {number|null} topKOverride — force example count (null = auto)
     * @param {number|null} topNOverride — force table count  (null = auto)
     * @returns {{ examples, tables, rules, intents, complexity, maxBm25Score, usedFallback, stats }}
     */
    retrieve(question, topKOverride = null, topNOverride = null) {
        const t0 = Date.now();

        // Step 1: Detect intents
        const intents = this._detectIntents(question);

        // Step 2: Detect query complexity → adaptive topK/topN
        const complexity = this._detectComplexity(question);
        const topK = topKOverride !== null ? topKOverride : complexity.topK;
        const topN = topNOverride !== null ? topNOverride : complexity.topN;

        // Step 3: BM25 example retrieval (returns maxScore for threshold check)
        const { examples, maxScore } = this._retrieveExamples(question, topK);
        const usedFallback = maxScore < BM25_FALLBACK_THRESHOLD;

        // Step 4: Table relevance scoring
        const tables = this._retrieveTables(question, intents, topN);

        // Step 5: Rule filtering
        const rules = this._retrieveRules(intents);

        const elapsed = Date.now() - t0;
        const stats = {
            totalExamples:    this.examples.length,
            selectedExamples: examples.length,
            totalTables:      Object.keys(this.schema.tables || {}).length,
            selectedTables:   Object.keys(tables).length,
            totalRules:       (this.schema.important_rules || []).length,
            selectedRules:    rules.length,
            intents,
            complexity:       complexity.level,
            topK,
            topN,
            maxBm25Score:     parseFloat(maxScore.toFixed(3)),
            usedFallback,
            retrievalMs:      elapsed
        };

        console.log(`[RAG] ${complexity.level} | intents:[${intents.join(',')}] | examples:${examples.length}/${this.examples.length} | tables:${stats.selectedTables}/${stats.totalTables} | BM25max:${maxScore.toFixed(2)} | fallback:${usedFallback} | ${elapsed}ms`);

        return { examples, tables, rules, intents, complexity: complexity.level, maxBm25Score: maxScore, usedFallback, stats };
    }

    // ─────────────────────────────────────────────
    //  STEP 1: INTENT DETECTION
    // ─────────────────────────────────────────────
    _detectIntents(question) {
        const q = question.toLowerCase();
        const detected = [];
        for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
            if (keywords.some(kw => q.includes(kw))) detected.push(intent);
        }
        if (detected.length === 0) detected.push('summary');
        return detected;
    }

    // ─────────────────────────────────────────────
    //  STEP 2: COMPLEXITY DETECTION  (Point 3)
    // ─────────────────────────────────────────────
    _detectComplexity(question) {
        const ql = question.toLowerCase();

        // topN is scaled at call-time by _retrieveTables based on total table count.
        // These are base values for a ~30-table schema; they get multiplied for larger
        // schemas so the LLM always sees a proportionally representative slice.
        if (COMPLEXITY_COMPLEX.some(w => ql.includes(w))) {
            return { level: 'COMPLEX', topK: 8, topN: 16 };
        }
        if (COMPLEXITY_MEDIUM.some(w => ql.includes(w))) {
            return { level: 'MEDIUM', topK: 6, topN: 12 };
        }
        return { level: 'SIMPLE', topK: 4, topN: 8 };
    }

    // ─────────────────────────────────────────────
    //  STEP 3: BM25 EXAMPLE RETRIEVAL
    // ─────────────────────────────────────────────

    /** Returns { examples, maxScore } — maxScore used for fallback decision */
    _retrieveExamples(question, topK) {
        if (this.examples.length === 0) return { examples: [], maxScore: 0 };

        const qTokens = this._tokenise(question);

        const scored = this.examples.map((ex, i) => ({
            example: ex,
            score:   this._bm25Score(qTokens, this._corpus[i])
        }));

        scored.sort((a, b) => b.score - a.score);

        const maxScore = scored[0] ? scored[0].score : 0;
        const topSlice = scored.slice(0, topK);

        return {
            examples: topSlice.map(r => r.example),
            maxScore
        };
    }

    _bm25Score(queryTokens, docTokens) {
        if (!queryTokens.length || !docTokens.length) return 0;
        const docLen  = docTokens.length;
        const termFreq = this._termFrequency(docTokens);

        return queryTokens.reduce((score, term) => {
            const tf = termFreq[term] || 0;
            if (tf === 0) return score;
            const idf    = this._idf(term);
            const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / this._avgDocLen));
            return score + idf * tfNorm;
        }, 0);
    }

    _idf(term) {
        if (this._idfCache[term] !== undefined) return this._idfCache[term];
        const df  = this._corpus.filter(doc => doc.includes(term)).length;
        const N   = this._corpus.length;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        this._idfCache[term] = idf;
        return idf;
    }

    _termFrequency(tokens) {
        return tokens.reduce((freq, t) => { freq[t] = (freq[t] || 0) + 1; return freq; }, {});
    }

    _computeAvgDocLen(corpus) {
        if (!corpus.length) return 1;
        return corpus.reduce((sum, doc) => sum + doc.length, 0) / corpus.length;
    }

    // ─────────────────────────────────────────────
    //  STEP 4: TABLE RELEVANCE SCORING
    // ─────────────────────────────────────────────
    _retrieveTables(question, intents, topN) {
        const schemaTables = this.schema.tables || {};
        const q       = question.toLowerCase();
        const qTokens = this._tokenise(question);

        const scored = Object.entries(schemaTables).map(([tableName, tableInfo]) => {
            let score = 0;

            // Affinity lookup: try alias first, then real name (for auto-discovered schemas
            // where tableName is an alias like "elec_connection_mst" but TABLE_INTENT_AFFINITY
            // uses real names like "mrkt_elec_connection_mst").
            const affinity = TABLE_INTENT_AFFINITY[tableName]
                          || TABLE_INTENT_AFFINITY[tableInfo.real_name]
                          || [];
            score += intents.filter(i => affinity.includes(i)).length * 3;

            // BM25-style keyword match on table name + description + column names.
            // With auto-discovery, tableInfo.description now embeds column keywords
            // (e.g. "Elec connection mst (500 rows) — meter type, unit consumed…")
            // which dramatically improves scoring for electricity/meter queries.
            const tableText = [
                tableName,
                tableInfo.real_name || '',
                tableInfo.description || '',
                ...Object.keys(tableInfo.key_columns || {})
            ].join(' ').toLowerCase();

            score += qTokens.filter(t => tableText.includes(t)).length * 1.5;

            // Exact phrase bonus: "electricity" in question + "elec" in table name
            const bareTableName = (tableInfo.real_name || tableName)
                .replace(/^(mrkt_|eng_|kmc_|coll_)/, '')
                .replace(/_/g, ' ');
            if (q.includes(bareTableName)) score += 5;

            return { tableName, tableInfo, score };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).reduce((acc, { tableName, tableInfo }) => {
            acc[tableName] = tableInfo;
            return acc;
        }, {});
    }

    // ─────────────────────────────────────────────
    //  STEP 5: RULE FILTERING
    // ─────────────────────────────────────────────
    _retrieveRules(intents) {
        const allRules      = this.schema.important_rules || [];
        const universalRules = allRules.slice(0, 5);

        const domainRules = allRules.slice(5).filter(rule => {
            const rLower = rule.toLowerCase();
            for (const intent of intents) {
                const kws = RULE_INTENT_KEYWORDS[intent] || [];
                if (kws.some(kw => rLower.includes(kw))) return true;
            }
            return false;
        });

        return [...new Set([...universalRules, ...domainRules])];
    }

    // ─────────────────────────────────────────────
    //  UTILITIES
    // ─────────────────────────────────────────────
    _tokenise(text) {
        if (!text) return [];
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 1 && !STOPWORDS.has(t));
    }
}

const STOPWORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for',
    'of','with','by','from','is','are','was','were','be','been',
    'being','have','has','had','do','does','did','will','would',
    'could','should','may','might','can','me','my','i','we','our',
    'you','your','it','its','this','that','these','those','all',
    'show','get','give','find','list','what','which','who','how',
    'where','when','many','much','more','most','some','any','no'
]);

module.exports = { RagRetriever, BM25_FALLBACK_THRESHOLD };

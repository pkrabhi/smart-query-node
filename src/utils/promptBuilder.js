'use strict';
/**
 * promptBuilder.js — v4
 * ─────────────────────────────────────────────────────────────
 * NEW in v4:
 *  ✅  Point 1 — ragStats exposed in buildRagSystemPrompt return
 *  ✅  Point 4 — BM25 threshold: auto-fallback to static prompt
 *               when no good examples found (usedFallback=true)
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const { RagRetriever, BM25_FALLBACK_THRESHOLD } = require('./ragRetriever');

class PromptBuilder {

    constructor(moduleCode) {
        this.moduleCode    = moduleCode.toUpperCase();
        this.systemPrompt  = '';
        this.aliasMapping  = null;
        this._rawSchema    = null;
        this._rawExamples  = null;
        this._ragRetriever = null;
        this._resourceDir  = null;
        this.init();
    }

    init() {
        try {
            this._resourceDir = path.resolve(
                __dirname, '../resources/smartquery', this.moduleCode.toLowerCase()
            );

            this._rawSchema   = JSON.parse(fs.readFileSync(path.join(this._resourceDir, 'schema_context.json'), 'utf8'));
            this.aliasMapping = JSON.parse(fs.readFileSync(path.join(this._resourceDir, 'alias_mapping.json'),  'utf8'));
            this._rawExamples = JSON.parse(fs.readFileSync(path.join(this._resourceDir, 'few_shot_examples.json'), 'utf8'));

            this.systemPrompt = this._buildStaticSystemPrompt(this._rawSchema, this._rawExamples);
            console.log(`[PromptBuilder:${this.moduleCode}] Static prompt: ${this.systemPrompt.length} chars`);

            this._ragRetriever = new RagRetriever(
                this._rawExamples.examples || [],
                this._rawSchema,
                this.aliasMapping
            );
        } catch (e) {
            console.error(`[PromptBuilder:${this.moduleCode}] Init failed:`, e.message);
            throw e;
        }
    }

    // ─────────────────────────────────────────────
    //  Point 2 support: Hot-reload after feedback
    // ─────────────────────────────────────────────
    reloadExamples() {
        try {
            this._rawExamples = JSON.parse(
                fs.readFileSync(path.join(this._resourceDir, 'few_shot_examples.json'), 'utf8')
            );
            // Rebuild static prompt
            this.systemPrompt = this._buildStaticSystemPrompt(this._rawSchema, this._rawExamples);
            // Hot-reload RAG corpus
            if (this._ragRetriever) {
                this._ragRetriever.reloadExamples(this._rawExamples.examples || []);
            }
            console.log(`[PromptBuilder:${this.moduleCode}] Hot-reloaded — ${(this._rawExamples.examples||[]).length} examples`);
        } catch (e) {
            console.error(`[PromptBuilder:${this.moduleCode}] Hot-reload failed:`, e.message);
        }
    }

    // ─────────────────────────────────────────────
    //  Hot-reload schema_context.json without restart
    // ─────────────────────────────────────────────
    reloadSchema() {
        try {
            this._rawSchema   = JSON.parse(fs.readFileSync(path.join(this._resourceDir, 'schema_context.json'), 'utf8'));
            this.systemPrompt = this._buildStaticSystemPrompt(this._rawSchema, this._rawExamples);
            if (this._ragRetriever) {
                this._ragRetriever.schema = this._rawSchema;
            }
            console.log(`[PromptBuilder:${this.moduleCode}] Schema hot-reloaded — ${(this._rawSchema.important_rules||[]).length} rules`);
        } catch (e) {
            console.error(`[PromptBuilder:${this.moduleCode}] Schema reload failed:`, e.message);
        }
    }

    // ─────────────────────────────────────────────
    //  Full reload: schema + examples in one call
    // ─────────────────────────────────────────────
    reloadAll() {
        this.reloadSchema();
        this.reloadExamples();
    }

    // ═══════════════════════════════════════════════
    //  ★ DYNAMIC RAG SYSTEM PROMPT
    //  Points 1 + 4: exposes ragStats, auto-fallback
    // ═══════════════════════════════════════════════

    /**
     * Build dynamic RAG prompt for a question.
     *
     * @param {string} question
     * @returns {{
     *   prompt:       string,
     *   ragStats:     Object,    // Point 1: exposed in API response
     *   usedFallback: boolean    // Point 4: true = used static full prompt
     * }}
     */
    buildRagSystemPrompt(question) {
        if (!this._ragRetriever) {
            return { prompt: this.systemPrompt, ragStats: null, usedFallback: true };
        }

        const result = this._ragRetriever.retrieve(question);
        const { examples, tables, rules, usedFallback, stats } = result;

        // ── Point 4: BM25 threshold fallback ──────────────────────
        if (usedFallback) {
            console.log(`[PromptBuilder:${this.moduleCode}] BM25 max=${stats.maxBm25Score} < threshold=${BM25_FALLBACK_THRESHOLD} — using STATIC full prompt`);
            return {
                prompt:       this.systemPrompt,
                ragStats:     { ...stats, mode: 'STATIC_FALLBACK' },
                usedFallback: true
            };
        }

        // ── Dynamic RAG prompt ─────────────────────────────────────
        let sb = '';
        sb += `You are a PostgreSQL SQL generator for KMC Municipal ${this._moduleLabel()} Management.\n`;
        sb += '⚠ OUTPUT FORMAT: Your ENTIRE response must be the raw SQL query — nothing else.\n';
        sb += '   Do NOT write any explanation, reasoning, preamble, commentary, or markdown.\n';
        sb += '   The FIRST word of your response must be SELECT or WITH.\n';
        sb += '   If you cannot generate SQL, output only: UNABLE_TO_GENERATE\n\n';
        sb += 'RULES:\n';
        sb += '1. Return ONLY the raw SQL query. No text before or after the SQL.\n';
        sb += '2. ONLY SELECT statements. Never INSERT/UPDATE/DELETE/DROP/ALTER.\n';
        sb += '3. Prefix all tables with: data_schema.<table>\n';
        sb += '4. Use COALESCE for nullable numeric fields.\n';
        sb += '5. Use ILIKE for text searches.\n';
        sb += '6. Add LIMIT 5000 unless the user specifies a different limit.\n';
        sb += '7. If the question is unrelated or unclear, respond: UNABLE_TO_GENERATE\n';
        sb += '8. NEVER use :: type casts (e.g. ::date, ::int). Use CAST(x AS type) instead.\n';
        sb += '9. CRITICAL: Use ONLY the tables and columns listed in the schema below. DO NOT invent column names.\n';
        sb += '10. CRITICAL: Use ONLY JOINs where foreign key relationships exist in the schema.\n';
        sb += '11. NEVER use SELECT *. Always list specific column names explicitly.\n\n';

        if (rules.length > 0) {
            sb += 'BUSINESS RULES (relevant to this query):\n';
            for (const rule of rules) sb += `- ${rule}\n`;
            sb += '\n';
        }

        sb += `SCHEMA (data_schema) — ${Object.keys(tables).length} most relevant tables:\n\n`;
        for (const [tableName, tableInfo] of Object.entries(tables)) {
            sb += `TABLE: data_schema.${tableName}`;
            if (tableInfo.description) sb += ` — ${tableInfo.description}`;
            sb += '\n';
            if (tableInfo.key_columns) {
                for (const [colName, colInfo] of Object.entries(tableInfo.key_columns)) {
                    sb += `  ${colName}`;
                    if (colInfo.type) sb += ` (${colInfo.type})`;
                    if (colInfo.pk)   sb += ' PK';
                    if (colInfo.fk)   sb += ` FK→${colInfo.fk}`;
                    if (colInfo.desc) sb += ` — ${colInfo.desc}`;
                    sb += '\n';
                }
            }
            sb += '\n';
        }

        let aliasedPrompt = this._replaceRealWithAliases(sb);

        let exSb = `EXAMPLES (${examples.length} most relevant — ${stats.complexity} query):\n\n`;
        for (const ex of examples) {
            const aliasedSql = this._replaceRealWithAliases(ex.sql);
            exSb += `Q: ${ex.question}\nSQL: ${aliasedSql}\n\n`;
        }

        const prompt = aliasedPrompt + exSb;
        const tokenSaving = Math.round((1 - prompt.length / this.systemPrompt.length) * 100);

        console.log(`[PromptBuilder:${this.moduleCode}] RAG(${stats.complexity}) prompt=${prompt.length} chars, static=${this.systemPrompt.length}, saved=${tokenSaving}%`);

        return {
            prompt,
            ragStats: { ...stats, mode: 'RAG', tokenSavingPct: tokenSaving },
            usedFallback: false
        };
    }

    // ═══════════════════════════════════════════════
    //  STATIC FULL PROMPT (legacy / fallback)
    // ═══════════════════════════════════════════════

    _buildStaticSystemPrompt(schema, examplesRoot) {
        let sb = '';
        sb += `You are a PostgreSQL SQL generator for KMC Municipal ${this._moduleLabel()} Management.\n`;
        sb += '⚠ OUTPUT FORMAT: Your ENTIRE response must be the raw SQL query — nothing else.\n';
        sb += '   Do NOT write any explanation, reasoning, preamble, commentary, or markdown.\n';
        sb += '   The FIRST word of your response must be SELECT or WITH.\n';
        sb += '   If you cannot generate SQL, output only: UNABLE_TO_GENERATE\n\n';
        sb += 'RULES:\n';
        sb += '1. Return ONLY the raw SQL query. No text before or after the SQL.\n';
        sb += '2. ONLY SELECT statements. Never INSERT/UPDATE/DELETE/DROP/ALTER.\n';
        sb += '3. Prefix all tables with: data_schema.<table>\n';
        sb += '4. Use COALESCE for nullable numeric fields.\n';
        sb += '5. Use ILIKE for text searches.\n';
        sb += '6. Add LIMIT 5000 unless the user specifies a different limit.\n';
        sb += '7. If the question is unrelated or unclear, respond: UNABLE_TO_GENERATE\n';
        sb += '8. NEVER use :: type casts (e.g. ::date, ::int). Use CAST(x AS type) instead.\n';
        sb += '9. CRITICAL: Use ONLY the tables and columns listed in the schema below. DO NOT invent column names.\n';
        sb += '10. CRITICAL: Use ONLY JOINs where foreign key relationships exist in the schema.\n';
        sb += '11. NEVER use SELECT *. Always list specific column names explicitly.\n\n';

        if (schema.important_rules) {
            sb += 'BUSINESS RULES:\n';
            for (const rule of schema.important_rules) sb += `- ${rule}\n`;
            sb += '\n';
        }

        sb += 'SCHEMA (data_schema):\n\n';
        if (schema.tables) {
            for (const [tableName, tableInfo] of Object.entries(schema.tables)) {
                sb += `TABLE: data_schema.${tableName}`;
                if (tableInfo.description) sb += ` — ${tableInfo.description}`;
                sb += '\n';
                if (tableInfo.key_columns) {
                    for (const [colName, colInfo] of Object.entries(tableInfo.key_columns)) {
                        sb += `  ${colName}`;
                        if (colInfo.type) sb += ` (${colInfo.type})`;
                        if (colInfo.pk)   sb += ' PK';
                        if (colInfo.fk)   sb += ` FK→${colInfo.fk}`;
                        if (colInfo.desc) sb += ` — ${colInfo.desc}`;
                        sb += '\n';
                    }
                }
                sb += '\n';
            }
        }

        let aliasedPrompt = this._replaceRealWithAliases(sb);
        let exSb = 'EXAMPLES:\n\n';
        if (examplesRoot.examples) {
            let count = 0;
            for (const ex of examplesRoot.examples) {
                const aliasedSql = this._replaceRealWithAliases(ex.sql);
                exSb += `Q: ${ex.question}\nSQL: ${aliasedSql}\n\n`;
                count++;
            }
            console.log(`[PromptBuilder:${this.moduleCode}] Loaded ${count} static few-shot examples`);
        }
        return aliasedPrompt + exSb;
    }

    // ═══════════════════════════════════════════════
    //  ALIAS ↔ REAL (unchanged)
    // ═══════════════════════════════════════════════

    _replaceRealWithAliases(text) {
        if (!this.aliasMapping) return text;
        text = text.replace(
            new RegExp(this._escapeRegex(this.aliasMapping.schema_real), 'g'),
            this.aliasMapping.schema_alias
        );
        const replacements = [];
        for (const [aliasTable, tableInfo] of Object.entries(this.aliasMapping.tables)) {
            replacements.push({ from: tableInfo.real_name, to: aliasTable });
            if (tableInfo.columns) {
                for (const [aliasCol, realCol] of Object.entries(tableInfo.columns)) {
                    replacements.push({ from: '.' + realCol, to: '.' + aliasCol });
                }
            }
        }
        replacements.sort((a, b) => b.from.length - a.from.length);
        for (const r of replacements) text = text.split(r.from).join(r.to);
        return text;
    }

    replaceAliasesWithReal(aliasedSql) {
        if (!aliasedSql || !this.aliasMapping) return aliasedSql;
        let result = aliasedSql;

        // Schema alias swap (simple — no collision risk: "data_schema" is unique)
        result = result.split(this.aliasMapping.schema_alias).join(this.aliasMapping.schema_real);

        const replacements = [];
        for (const [aliasTable, tableInfo] of Object.entries(this.aliasMapping.tables)) {
            replacements.push({ from: aliasTable, to: tableInfo.real_name });
            if (tableInfo.columns) {
                for (const [aliasCol, realCol] of Object.entries(tableInfo.columns)) {
                    replacements.push({ from: aliasCol, to: realCol });
                }
            }
        }
        replacements.sort((a, b) => b.from.length - a.from.length);

        // Deduplicate exact from→to pairs (multiple tables produce same mapping).
        const seen = new Set();
        for (const r of replacements) {
            const key = `${r.from}\x00${r.to}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // ── Word-boundary replacement ──────────────────────────────────
            // Plain split().join() causes "fin_year" (table alias) to match
            // inside "mrkt_fin_year" (column name), producing mrkt_mrkt_...
            // \b matches at \w/\W transitions. Since PostgreSQL identifiers
            // use [a-zA-Z0-9_] (all \w chars), a boundary exists at the .
            // before a bare identifier ("rh.fin_year") but NOT inside a
            // prefixed name ("mrkt_fin_year" — underscore is \w, no \b).
            result = result.replace(
                new RegExp('\\b' + this._escapeRegex(r.from) + '\\b', 'g'),
                r.to
            );
        }
        return result;
    }

    // ═══════════════════════════════════════════════
    //  USER MESSAGE (unchanged)
    // ═══════════════════════════════════════════════

    buildUserMessage(question, request) {
        let msg = `Generate a PostgreSQL SELECT query for: ${question}`;

        if (this.moduleCode === 'MARKET') {
            if (request.stallId && request.stallId.trim()) {
                msg += `\nContext: Filter by stall ID = ${request.stallId}`;
            } else if (request.marketCode && request.marketCode.trim()) {
                msg += `\nContext: Filter by market code = ${request.marketCode}`;
                if (request.phaseCode && request.phaseCode.trim()) msg += `, phase code = ${request.phaseCode}`;
                if (request.blockCode && request.blockCode.trim()) msg += `, block code = ${request.blockCode}`;
            }
        }

        if (this.moduleCode === 'ENGINEERING') {
            if (request.fileNo        && request.fileNo.trim())        msg += `\nContext: File number = ${request.fileNo}`;
            if (request.tenderNo     && request.tenderNo.trim())       msg += `\nContext: Tender number = ${request.tenderNo}`;
            if (request.poNumber     && request.poNumber.trim())       msg += `\nContext: PO number = ${request.poNumber}`;
            if (request.deptCode     && request.deptCode.trim())       msg += `\nContext: Department code = ${request.deptCode}`;
            if (request.borough      && request.borough.trim())        msg += `\nContext: Borough = ${request.borough}`;
            if (request.contractorCode && request.contractorCode.trim()) msg += `\nContext: Contractor code = ${request.contractorCode}`;
        }

        if (request.wardNo  && request.wardNo.trim())  msg += `\nContext: Ward number = ${request.wardNo}`;
        if (request.finYear && request.finYear.trim()) msg += `\nContext: Financial year = ${request.finYear}`;

        if (request.previousSql && request.previousSql.trim()) {
            const aliasedPrevSql = this._replaceRealWithAliases(request.previousSql);
            if (request.previousQuestion) msg += `\nPrevious question: "${request.previousQuestion}"`;
            msg += `\nPrevious SQL:\n${aliasedPrevSql}`;
            msg += `

FOLLOW-UP INSTRUCTIONS — you MUST return a valid SQL query, never UNABLE_TO_GENERATE:
1. Use the previous SQL as your starting point and modify it to answer the new question.
2. "Is this for X or Y?" → add a GROUP BY or CASE to show the breakdown between X and Y.
3. "Show only X" → add a WHERE clause to filter for X.
4. "Break it down by X" → add GROUP BY X.
5. "What about X?" → join or filter to include X dimension.
6. If the follow-up is a clarification about the nature of the previous result, rewrite the SQL to show the relevant breakdown or filter that would answer the question.
7. Use domain knowledge: "regular demand" vs "misc demand" likely maps to a demand type or charge code column — look in the schema for columns like demand_type, charge_code, or similar to distinguish them.`;
        }

        msg += '\n\nReturn ONLY the SQL.';
        return msg;
    }

    // ═══════════════════════════════════════════════
    //  ★ ZERO-SHOT SCHEMA AUTO-DISCOVERY INTEGRATION
    //
    //  Call this with a schema object from schemaCacheService
    //  to replace the static schema_context.json with live DB discovery.
    //  Preserves existing few-shot examples — only the schema changes.
    //
    //  Idempotent: if the hash hasn't changed, does nothing.
    // ═══════════════════════════════════════════════
    applyDiscoveredSchema(discoveredSchema) {
        const newHash = discoveredSchema._hash;
        if (this._discoveredSchemaHash && this._discoveredSchemaHash === newHash) {
            return; // no change
        }

        const schemaContext = {
            tables:          discoveredSchema.tables,
            important_rules: discoveredSchema.important_rules || [],
        };
        const aliasMapping = discoveredSchema.alias_mapping;

        this._rawSchema   = schemaContext;
        this.aliasMapping = aliasMapping;

        // Rebuild static fallback prompt
        this.systemPrompt = this._buildStaticSystemPrompt(this._rawSchema, this._rawExamples);

        // Rebuild RAG retriever with new schema (preserve existing examples)
        this._ragRetriever = new RagRetriever(
            this._rawExamples.examples || [],
            this._rawSchema,
            this.aliasMapping
        );

        this._discoveredSchemaHash = newHash;

        const tblCount = Object.keys(schemaContext.tables).length;
        console.log(`[PromptBuilder:${this.moduleCode}] Applied discovered schema — ${tblCount} tables (hash: ${newHash?.slice(0, 8)})`);
    }

    getSystemPrompt()  { return this.systemPrompt; }
    _moduleLabel()     { return { MARKET: 'Market', ENGINEERING: 'Engineering' }[this.moduleCode] || this.moduleCode; }
    _escapeRegex(str)  { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

// ═══════════════════════════════════════════════
//  MODULE CACHE
// ═══════════════════════════════════════════════
const instances = {};

function getBuilder(moduleCode = 'MARKET') {
    const key = (moduleCode || 'MARKET').toUpperCase();
    if (!instances[key]) {
        console.log(`[PromptBuilderFactory] Creating builder for module: ${key}`);
        instances[key] = new PromptBuilder(key);
    }
    return instances[key];
}

/** Called after feedback adds a new example — hot-reloads schema + examples without restart */
function reloadModule(moduleCode) {
    const key = (moduleCode || 'MARKET').toUpperCase();
    if (instances[key]) {
        instances[key].reloadAll();
    }
}

function preloadAll() {
    for (const mod of ['MARKET', 'ENGINEERING']) {
        try { getBuilder(mod); }
        catch (e) { console.warn(`[PromptBuilderFactory] Could not preload ${mod}: ${e.message}`); }
    }
}

module.exports = { getBuilder, reloadModule, preloadAll };

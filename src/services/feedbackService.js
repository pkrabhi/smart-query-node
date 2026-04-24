'use strict';
/**
 * feedbackService.js
 * ─────────────────────────────────────────────────────────────
 * Point 2: Self-improving feedback loop.
 *
 * When a user confirms that a generated SQL is correct,
 * this service appends it to few_shot_examples.json and
 * hot-reloads the RAG retriever — no server restart needed.
 *
 * Safety guards:
 *  - Duplicate detection (normalised question match)
 *  - Max feedback cap per module (default 200 total examples)
 *  - Atomic file write (write to .tmp, then rename)
 *  - SQL must be a SELECT statement
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const { reloadModule } = require('../utils/promptBuilder');

const MAX_TOTAL_EXAMPLES = 200;   // hard cap — keep prompt size bounded
const SIMILARITY_THRESHOLD = 0.85; // normalised overlap to detect duplicates

/**
 * Submit feedback for a query result.
 *
 * @param {{
 *   question:          string,
 *   sql:               string,
 *   moduleCode:        string,
 *   queryId:           string,
 *   isCorrect:         boolean,
 *   suggestedCategory: string  (optional)
 * }} payload
 *
 * @returns {{
 *   success: boolean,
 *   action:  'saved' | 'skipped_incorrect' | 'skipped_duplicate' | 'skipped_cap' | 'skipped_invalid_sql',
 *   message: string,
 *   totalExamples?: number
 * }}
 */
async function submitFeedback(payload) {
    const { question, sql, moduleCode, queryId, isCorrect, suggestedCategory } = payload;

    // Only save confirmed-correct feedback
    if (!isCorrect) {
        console.log(`[Feedback] ${queryId} — marked INCORRECT, not saving`);
        return { success: true, action: 'skipped_incorrect', message: 'Negative feedback recorded — SQL not added to examples.' };
    }

    // Basic SQL safety check
    const sqlUpper = (sql || '').trim().toUpperCase();
    if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
        return { success: false, action: 'skipped_invalid_sql', message: 'SQL must be a SELECT or WITH statement.' };
    }

    const modKey = (moduleCode || 'MARKET').toUpperCase().toLowerCase(); // 'market' or 'engineering'
    const filePath = path.resolve(
        __dirname,
        '../resources/smartquery',
        modKey,
        'few_shot_examples.json'
    );

    try {
        // Read current examples
        const raw  = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        const examples = data.examples || [];

        // Cap check
        if (examples.length >= MAX_TOTAL_EXAMPLES) {
            console.log(`[Feedback] ${queryId} — cap reached (${examples.length}/${MAX_TOTAL_EXAMPLES})`);
            return {
                success: false,
                action:  'skipped_cap',
                message: `Example cap (${MAX_TOTAL_EXAMPLES}) reached. Remove old examples first.`
            };
        }

        // Duplicate detection — normalised token overlap
        const qNorm = _normalise(question);
        const isDuplicate = examples.some(ex => {
            const sim = _similarity(qNorm, _normalise(ex.question));
            return sim >= SIMILARITY_THRESHOLD;
        });

        if (isDuplicate) {
            console.log(`[Feedback] ${queryId} — duplicate question detected, skipping`);
            return {
                success: true,
                action:  'skipped_duplicate',
                message: 'A very similar question already exists in the examples.'
            };
        }

        // Build new example entry
        const newId = (examples.length > 0 ? Math.max(...examples.map(e => e.id || 0)) : 0) + 1;
        const category = suggestedCategory || _inferCategory(question);

        const newExample = {
            id:       newId,
            category,
            source:   'feedback',
            queryId:  queryId || null,
            addedAt:  new Date().toISOString(),
            question: question.trim(),
            sql:      sql.trim()
        };

        examples.push(newExample);
        data.examples = examples;

        // Atomic write — write to .tmp first, then rename
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);

        console.log(`[Feedback] ${queryId} — saved as example #${newId} | category: ${category} | total: ${examples.length}`);

        // Hot-reload RAG retriever — no server restart needed
        reloadModule(moduleCode);

        return {
            success:       true,
            action:        'saved',
            message:       `Example #${newId} added to ${category}. RAG retriever updated.`,
            totalExamples: examples.length,
            newExampleId:  newId
        };

    } catch (e) {
        console.error(`[Feedback] ${queryId} — error:`, e.message);
        return { success: false, action: 'error', message: `Failed to save: ${e.message}` };
    }
}

/**
 * Get feedback statistics for a module.
 */
function getFeedbackStats(moduleCode) {
    const modKey = (moduleCode || 'MARKET').toLowerCase();
    const filePath = path.resolve(
        __dirname, '../resources/smartquery', modKey, 'few_shot_examples.json'
    );

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const examples = data.examples || [];
        const feedbackExamples = examples.filter(e => e.source === 'feedback');

        const byCategory = examples.reduce((acc, e) => {
            acc[e.category || 'Uncategorised'] = (acc[e.category || 'Uncategorised'] || 0) + 1;
            return acc;
        }, {});

        return {
            moduleCode:         modKey.toUpperCase(),
            totalExamples:      examples.length,
            feedbackExamples:   feedbackExamples.length,
            staticExamples:     examples.length - feedbackExamples.length,
            capacityUsed:       `${examples.length}/${MAX_TOTAL_EXAMPLES}`,
            capacityPct:        Math.round(examples.length / MAX_TOTAL_EXAMPLES * 100) + '%',
            byCategory
        };
    } catch (e) {
        return { error: e.message };
    }
}

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

/** Normalise question to token set */
function _normalise(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1)
        .sort();
}

/** Jaccard similarity between two token arrays */
function _similarity(tokensA, tokensB) {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const intersection = tokensA.filter(t => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

/** Infer category from question keywords */
function _inferCategory(question) {
    const q = question.toLowerCase();
    if (q.includes('electric') || q.includes('meter') || q.includes('unit')) return 'Electricity Reports';
    if (q.includes('mutation') || q.includes('transfer'))                     return 'Mutation Reports';
    if (q.includes('demand'))                                                  return 'Demand Reports';
    if (q.includes('collect') || q.includes('receipt') || q.includes('paid')) return 'Collection Reports';
    if (q.includes('stall') || q.includes('stallage') || q.includes('rent'))  return 'Stallage Reports';
    return 'General Reports';
}

module.exports = { submitFeedback, getFeedbackStats };

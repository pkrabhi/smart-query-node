const express = require('express');
const router = express.Router();
const orchestrator = require('../services/orchestrator');
const explainService = require('../services/explainService');
const nvidiaService = require('../services/nvidiaLlmService');
const ollamaService = require('../services/ollamaLlmService');
const queryCache = require('../services/queryCache');
const dashboardService = require('../services/dashboardService');
const { submitFeedback, getFeedbackStats } = require('../services/feedbackService');
const schemaCacheService = require('../services/schemaCacheService');
const { generatePdf } = require('../services/pdfService');
const { reloadModule: reloadPromptBuilder } = require('../utils/promptBuilder');

// ─────────────────────────────────────────────
//  POST /ask — Standard query (cache + follow-up)
// ─────────────────────────────────────────────
router.post('/ask', async (req, res) => {
    // ✅ FIX: Added try-catch — unhandled promise rejection would hang the request
    try {
        const request    = req.body;
        const moduleCode = (request.moduleCode || 'MARKET').toUpperCase();

        console.log(`[Controller] Module: ${moduleCode} | User: '${request.userId || 'anonymous'}' | Q: '${request.question}'`);

        if (!request.question || !request.question.trim()) {
            return res.status(400).json({
                success: false,
                errorType: 'BAD_REQUEST',
                errorDetail: 'Question is required.'
            });
        }

        const response = await orchestrator.processQuery(request);

        if (!response.success) {
            console.warn(`[Controller] Query failed — ${response.errorType}: ${response.errorDetail}`);
        }

        res.json(response);
    } catch (e) {
        console.error('[Controller] /ask unhandled error:', e.message);
        res.status(500).json({ success: false, errorType: 'SERVER_ERROR', errorDetail: e.message });
    }
});

// ─────────────────────────────────────────────
//  POST /ask-stream — SSE streaming query
// ─────────────────────────────────────────────
router.post('/ask-stream', async (req, res) => {
    const request    = req.body;
    const moduleCode = (request.moduleCode || 'MARKET').toUpperCase();

    console.log(`[Controller][SSE] Module: ${moduleCode} | Q: '${request.question}'`);

    if (!request.question || !request.question.trim()) {
        return res.status(400).json({
            success: false,
            errorType: 'BAD_REQUEST',
            errorDetail: 'Question is required.'
        });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Content-Encoding': 'none',
    });

    // ✅ FIX: Disable TCP Nagle's algorithm so every res.write() is sent
    // immediately over the wire. Without this, Node.js coalesces small packets
    // and holds step events in a buffer until NVIDIA responds (40–60s later),
    // making the UI appear frozen on "Connecting to streaming endpoint…".
    if (res.socket) res.socket.setNoDelay(true);

    res.write(':heartbeat\n\n');
    res.flushHeaders();

    let disconnected = false;

    const keepAlive = setInterval(() => {
        if (!disconnected) {
            try { res.write(':keepalive\n\n'); } catch {}
        }
    }, 15000);

    // ✅ FIX: emit accepts a single object — matches how orchestrator calls it:
    //   emit({ type: 'step', step: 2, label: '...' })
    // The old (type, data) signature made type=the whole object, data=undefined,
    // so JSON became {"type":{"type":"step",...}} — switch(evt.type) never matched
    // any case string, silently dropping ALL pipeline step + result events.
    const emit = (eventObj) => {
        if (disconnected) return;
        try {
            const payload = JSON.stringify(eventObj);
            res.write(`data: ${payload}\n\n`);
            if (res.socket && !res.socket.destroyed) {
                res.socket.setNoDelay(true);
            }
        } catch (e) {
            console.warn('[SSE] Write failed:', e.message);
        }
    };

    // FIX: res.on('close') fires when client actually closes HTTP response (correct for SSE).
    // req.on('close') fires when POST body is consumed (immediately), silently killing all emits.
    res.on('close', () => {
        disconnected = true;
        clearInterval(keepAlive);
        console.log('[SSE] Client disconnected');
    });

    try {
        await orchestrator.processQueryStreaming(request, emit);
    } catch (e) {
        if (!disconnected) {
            emit({ type: 'error', errorType: 'STREAM_ERROR', errorDetail: e.message });
        }
    } finally {
        clearInterval(keepAlive);
        if (!disconnected) {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

// ─────────────────────────────────────────────
//  POST /explain — AI insight summary
// ─────────────────────────────────────────────
router.post('/explain', async (req, res) => {
    // ✅ FIX: Added try-catch
    try {
        const { question, moduleCode, columns, sampleData, generatedSql, rowCount } = req.body;

        if (!question || !columns || !sampleData) {
            return res.status(400).json({
                success: false,
                errorDetail: 'question, columns, and sampleData are required.'
            });
        }

        console.log(`[Controller] Explain request: "${question.slice(0, 60)}…" (${rowCount} rows)`);

        const result = await explainService.generateInsight({
            question, moduleCode, columns, sampleData, generatedSql, rowCount
        });

        res.json(result);
    } catch (e) {
        console.error('[Controller] /explain unhandled error:', e.message);
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

// ─────────────────────────────────────────────
//  GET /status — Service health + cache stats
// ─────────────────────────────────────────────
router.get('/status', async (req, res) => {
    // ✅ FIX: Added try-catch
    try {
        const [nvidiaAvail, ollamaAvail] = await Promise.all([
            nvidiaService.isAvailable().catch(() => false),
            ollamaService.isAvailable().catch(() => false)
        ]);

        res.json({
            service: 'smart-query-service',
            status: 'UP',
            version: '3.0.0',
            supported_modules: ['MARKET', 'ENGINEERING'],
            nvidia_available: nvidiaAvail,
            nvidia_provider: nvidiaService.getProviderName(),
            ollama_available: ollamaAvail,
            ollama_provider: ollamaService.getProviderName(),
            cache: queryCache.getStats(),
            features: ['streaming', 'explain', 'follow-up', 'cache', 'dashboards'],
        });
    } catch (e) {
        console.error('[Controller] /status error:', e.message);
        res.status(500).json({ status: 'DOWN', error: e.message });
    }
});

// ─────────────────────────────────────────────
//  GET /cache/stats — Cache statistics
// ─────────────────────────────────────────────
router.get('/cache/stats', (req, res) => {
    res.json(queryCache.getStats());
});

// ─────────────────────────────────────────────
//  POST /cache/flush — Clear all cached queries
// ─────────────────────────────────────────────
router.post('/cache/flush', (req, res) => {
    const count = queryCache.flush();
    res.json({ flushed: count, message: `Cleared ${count} cached entries.` });
});

// ─────────────────────────────────────────────
//  POST /feedback — Self-improving feedback loop
//  Body: { question, sql, moduleCode, queryId,
//          isCorrect: true/false, suggestedCategory? }
// ─────────────────────────────────────────────
router.post('/feedback', async (req, res) => {
    try {
        const { question, sql, moduleCode, queryId, isCorrect, suggestedCategory } = req.body;
        if (!question || !sql || !moduleCode) {
            return res.status(400).json({ success: false, errorDetail: 'question, sql, and moduleCode are required.' });
        }
        if (typeof isCorrect !== 'boolean') {
            return res.status(400).json({ success: false, errorDetail: 'isCorrect must be a boolean.' });
        }
        console.log(`[Controller] Feedback: queryId=${queryId} | module=${moduleCode} | isCorrect=${isCorrect}`);
        const result = await submitFeedback({ question, sql, moduleCode, queryId, isCorrect, suggestedCategory });
        res.json(result);
    } catch (e) {
        console.error('[Controller] /feedback error:', e.message);
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

// GET /feedback/stats?moduleCode=MARKET
router.get('/feedback/stats', (req, res) => {
    try {
        const stats = getFeedbackStats(req.query.moduleCode || 'MARKET');
        res.json({ success: true, ...stats });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

// ─────────────────────────────────────────────
//  POST /export-pdf — KMC branded PDF report
//  Body: { columns, data, question, moduleCode,
//          queryId, source, executionTimeMs, generatedSql }
// ─────────────────────────────────────────────
router.post('/export-pdf', async (req, res) => {
    try {
        const {
            columns, data, question, moduleCode,
            queryId, source, executionTimeMs, generatedSql,
        } = req.body;

        if (!columns || !data) {
            return res.status(400).json({ error: 'columns and data are required' });
        }

        console.log(`[PDF] Generating report — module: ${moduleCode} | rows: ${data.length} | cols: ${columns.length}`);

        generatePdf(res, {
            question, moduleCode, queryId,
            source, executionTimeMs, generatedSql,
            columns, data,
        });

    } catch (e) {
        console.error('[PDF] Generation error:', e.message);
        // Only send error if headers not already sent (PDF stream not started)
        if (!res.headersSent) {
            res.status(500).json({ error: `PDF generation failed: ${e.message}` });
        }
    }
});

// ─────────────────────────────────────────────
//  POST /export-csv — CSV download
// ─────────────────────────────────────────────
router.post('/export-csv', (req, res) => {
    try {
        const { columns, data, queryId } = req.body;

        if (!columns || !data) {
            return res.status(400).json({ error: 'columns and data are required' });
        }

        let csv = columns.map(escapeCsv).join(',') + '\n';
        for (const row of data) {
            csv += columns.map(col => escapeCsv(row[col] != null ? String(row[col]) : '')).join(',') + '\n';
        }

        const filename = `SmartQuery_${queryId || 'export'}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(csv);

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
//  ✅ FIX: Dashboard routes were MISSING from controller
//  (dashboardService existed but had no HTTP endpoints)
// ─────────────────────────────────────────────

// GET  /dashboards          — list dashboards for user
// POST /dashboards          — create dashboard
// GET  /dashboards/:id      — get single dashboard
// PUT  /dashboards/:id      — update dashboard
// DELETE /dashboards/:id    — delete dashboard
// POST /dashboards/:id/run  — run all queries in dashboard

router.get('/dashboards', async (req, res) => {
    try {
        const userId = req.query.userId || 'erp_user';
        const list = await dashboardService.list(userId);
        res.json({ success: true, dashboards: list, count: list.length });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.post('/dashboards', async (req, res) => {
    try {
        const { name, description, userId, moduleCode, queries, layout } = req.body;
        if (!name) return res.status(400).json({ success: false, errorDetail: 'name is required' });
        const dashboard = await dashboardService.create({ name, description, userId, moduleCode, queries, layout });
        res.status(201).json({ success: true, dashboard });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.get('/dashboards/:id', async (req, res) => {
    try {
        const dashboard = await dashboardService.getById(req.params.id);
        if (!dashboard) return res.status(404).json({ success: false, errorDetail: 'Dashboard not found' });
        res.json({ success: true, dashboard });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.put('/dashboards/:id', async (req, res) => {
    try {
        const updated = await dashboardService.update(req.params.id, req.body);
        if (!updated) return res.status(404).json({ success: false, errorDetail: 'Dashboard not found' });
        res.json({ success: true, dashboard: updated });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.delete('/dashboards/:id', async (req, res) => {
    try {
        const deleted = await dashboardService.remove(req.params.id);
        if (!deleted) return res.status(404).json({ success: false, errorDetail: 'Dashboard not found' });
        res.json({ success: true, message: `Dashboard ${req.params.id} deleted` });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.post('/dashboards/:id/run', async (req, res) => {
    try {
        const result = await dashboardService.runDashboard(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

router.post('/dashboards/:id/schedule/start', async (req, res) => {
    try {
        const result = await dashboardService.startSchedule(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, errorDetail: e.message });
    }
});

router.post('/dashboards/:id/schedule/stop', async (req, res) => {
    try {
        dashboardService.stopSchedule(req.params.id);
        res.json({ success: true, message: 'Schedule stopped' });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

// ─────────────────────────────────────────────
//  SCHEMA AUTO-DISCOVERY ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /schema/discover?moduleCode=MARKET
 * Returns the discovered schema (from cache or triggers discovery).
 */
router.get('/schema/discover', async (req, res) => {
    try {
        const moduleCode = (req.query.moduleCode || 'MARKET').toUpperCase();
        const entry = await schemaCacheService.getSchema(moduleCode);
        res.json({
            success:      true,
            moduleCode,
            fromCache:    entry.fromCache,
            discoveredAt: new Date(entry.discoveredAt).toISOString(),
            discoveryMs:  entry.discoveryMs,
            hash:         entry.hash,
            tableCount:   Object.keys(entry.schema.tables || {}).length,
            schema:       entry.schema,
        });
    } catch (e) {
        console.error('[Controller] /schema/discover error:', e.message);
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

/**
 * POST /schema/refresh?moduleCode=MARKET
 * Force re-introspects the DB and updates the cache.
 */
router.post('/schema/refresh', async (req, res) => {
    try {
        const moduleCode = (req.query.moduleCode || req.body?.moduleCode || 'MARKET').toUpperCase();
        console.log(`[Controller] Schema refresh requested for ${moduleCode}`);
        const entry = await schemaCacheService.refresh(moduleCode);
        // Also hot-reload promptBuilder (schema_context.json + few_shot_examples.json)
        reloadPromptBuilder(moduleCode);
        res.json({
            success:       true,
            moduleCode,
            discoveryMs:   entry.discoveryMs,
            hash:          entry.hash,
            tableCount:    Object.keys(entry.schema.tables || {}).length,
            schemaChanged: entry.changed,
            promptReloaded: true,
            message:       entry.changed
                ? `Schema refreshed + prompt builder reloaded — changes detected (hash changed)`
                : `Schema refreshed + prompt builder reloaded — no structural changes detected`,
        });
    } catch (e) {
        console.error('[Controller] /schema/refresh error:', e.message);
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

/**
 * GET /schema/status
 * Returns cache metadata for all modules (age, TTL, table count, hash).
 */
router.get('/schema/status', (req, res) => {
    try {
        const status = schemaCacheService.getStatus();
        res.json({ success: true, modules: status });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

/**
 * GET /schema/diff?moduleCode=MARKET
 * Compares latest snapshot with previous — shows added/removed/modified tables and columns.
 */
router.get('/schema/diff', (req, res) => {
    try {
        const moduleCode = (req.query.moduleCode || 'MARKET').toUpperCase();
        const diff = schemaCacheService.getDiff(moduleCode);
        res.json({ success: true, moduleCode, diff });
    } catch (e) {
        res.status(500).json({ success: false, errorDetail: e.message });
    }
});

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function escapeCsv(value) {
    if (!value) return '';
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

module.exports = router;

// ─────────────────────────────────────────────
//  GET /examples — Return example questions for autocomplete
//  Query: ?moduleCode=MARKET
//  Returns question list from few_shot_examples.json
// ─────────────────────────────────────────────
const path = require('path')
const fsSync = require('fs')
router.get('/examples', (req, res) => {
  try {
    const moduleCode = (req.query.moduleCode || 'MARKET').toLowerCase()
    const allowed = ['market', 'engineering']
    if (!allowed.includes(moduleCode)) {
      return res.status(400).json({ success: false, errorDetail: 'Invalid moduleCode' })
    }
    const filePath = path.resolve(
      __dirname, '../resources/smartquery', moduleCode, 'few_shot_examples.json'
    )
    const data = JSON.parse(fsSync.readFileSync(filePath, 'utf8'))
    const questions = (data.examples || []).map(e => ({
      question: e.question,
      category: e.category || 'General',
    }))
    res.json({ success: true, moduleCode: moduleCode.toUpperCase(), questions })
  } catch (e) {
    console.error('[Controller] /examples error:', e.message)
    res.status(500).json({ success: false, errorDetail: e.message })
  }
})

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const smartQueryController = require('./controllers/smartQueryController');
const { preloadAll } = require('./utils/promptBuilder');
const schedulerService = require('./services/schedulerService');
const schemaCacheService = require('./services/schemaCacheService');
const pool = require('./config/database');

const app = express();

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));

// ==================== ROUTES ====================
const basePath = config.server.contextPath;

app.use(`${basePath}/api/smart-query`, smartQueryController);

// Health check (actuator-style)
app.get(`${basePath}/actuator/health`, (req, res) => {
    res.json({ status: 'UP', service: 'smart-query-service', version: '3.0.0', timestamp: new Date().toISOString() });
});

// Root info
app.get(`${basePath}/`, (req, res) => {
    res.json({
        service: 'KMC Smart Query Service',
        version: '3.0.0',
        description: 'AI-powered NL-to-SQL query engine for KMC ERP (Market + Engineering)',
        modules: ['MARKET', 'ENGINEERING'],
        features: ['query-cache', 'follow-up-context', 'ai-explain', 'sse-streaming', 'dashboards', 'scheduled-reports', 'zero-shot-schema-discovery'],
        endpoints: {
            ask:              `${basePath}/api/smart-query/ask [POST]`,
            askStream:        `${basePath}/api/smart-query/ask-stream [POST] (SSE)`,
            explain:          `${basePath}/api/smart-query/explain [POST]`,
            status:           `${basePath}/api/smart-query/status [GET]`,
            exportCsv:        `${basePath}/api/smart-query/export-csv [POST]`,
            exportPdf:        `${basePath}/api/smart-query/export-pdf [POST]`,
            cacheFlush:       `${basePath}/api/smart-query/cache/flush [POST]`,
            dashboards:       `${basePath}/api/smart-query/dashboards [GET/POST]`,
            scheduledReports: `${basePath}/api/smart-query/scheduled-reports [GET/POST]`,
            health:           `${basePath}/actuator/health [GET]`,
            schemaDiscover:   `${basePath}/api/smart-query/schema/discover [GET]`,
            schemaRefresh:    `${basePath}/api/smart-query/schema/refresh [POST]`,
            schemaStatus:     `${basePath}/api/smart-query/schema/status [GET]`,
            schemaDiff:       `${basePath}/api/smart-query/schema/diff [GET]`,
        }
    });
});

// ==================== START SERVER ====================
const server = app.listen(config.server.port, async () => {
    console.log('===========================================');
    console.log('  KMC Smart Query Service — Node.js v3.0');
    console.log('===========================================');
    console.log(`  Port:      ${config.server.port}`);
    console.log(`  Base:      ${basePath}`);
    console.log(`  Modules:   MARKET, ENGINEERING`);
    console.log('  ─────────────────────────────────────');
    console.log(`  Ask:       http://localhost:${config.server.port}${basePath}/api/smart-query/ask`);
    console.log(`  Stream:    http://localhost:${config.server.port}${basePath}/api/smart-query/ask-stream`);
    console.log(`  Explain:   http://localhost:${config.server.port}${basePath}/api/smart-query/explain`);
    console.log(`  Status:    http://localhost:${config.server.port}${basePath}/api/smart-query/status`);
    console.log(`  Health:    http://localhost:${config.server.port}${basePath}/actuator/health`);
    console.log('  ─────────────────────────────────────');
    console.log(`  Model:     ${config.nvidia.model}`);
    console.log(`  Ollama:    ${config.ollama.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Cache:     ${config.cache.enabled ? `ENABLED (TTL: ${config.cache.ttlSeconds}s)` : 'DISABLED'}`);
    console.log(`  Scheduler: ${config.scheduler.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log('===========================================');

    // Pre-warm module context loaders (static schema + examples)
    preloadAll();

    // Pre-warm zero-shot schema discovery (async — doesn't block server start)
    if (config.schemaDiscovery.enabled && config.schemaDiscovery.warmOnStartup) {
        schemaCacheService.warmAll().catch(e =>
            console.warn('[Startup] Schema discovery pre-warm error:', e.message)
        );
    }

    // Start scheduled report cron jobs
    if (config.scheduler.enabled) {
        await schedulerService.startAll();
    }
});

// ==================== GRACEFUL SHUTDOWN ====================
async function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully...`);

    // Stop accepting new connections
    server.close(() => {
        console.log('[Shutdown] HTTP server closed');
    });

    // Stop scheduler
    schedulerService.stopAll();

    // Close database pool
    try {
        await pool.end();
        console.log('[Shutdown] Database pool closed');
    } catch (e) {
        console.error('[Shutdown] Pool close error:', e.message);
    }

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;

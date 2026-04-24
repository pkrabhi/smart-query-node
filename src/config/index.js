const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
    server: {
        port: parseInt(process.env.PORT) || 8101,
        contextPath: process.env.CONTEXT_PATH || '/smart-query-service'
    },

    db: {
        host:     process.env.DB_HOST     || '192.168.0.132',
        port:     parseInt(process.env.DB_PORT) || 5444,
        database: process.env.DB_NAME     || 'digit',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',

        // Per-module schemas
        schemas: {
            market:      process.env.DB_SCHEMA_MARKET      || 'mrkt_kmc2_data',
            engineering: process.env.DB_SCHEMA_ENGINEERING || 'public'
        },

        // Keep single schema for backward compatibility
        schema: process.env.DB_SCHEMA || 'mrkt_kmc2_data',

        max: parseInt(process.env.DB_POOL_MAX) || 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    },

    nvidia: {
        apiUrl:    process.env.NVIDIA_API_URL  || 'https://integrate.api.nvidia.com/v1/chat/completions',
        apiKey:    process.env.NVIDIA_API_KEY  || '',
        model:     process.env.NVIDIA_MODEL    || 'meta/llama-3.3-70b-instruct',
        timeoutMs: parseInt(process.env.NVIDIA_TIMEOUT_MS)  || 60000,
        maxTokens: parseInt(process.env.NVIDIA_MAX_TOKENS)  || 2048,
        temperature: parseFloat(process.env.NVIDIA_TEMPERATURE) || 0.0
    },

    ollama: {
        apiUrl:    process.env.OLLAMA_API_URL  || 'http://localhost:11434/v1/chat/completions',
        model:     process.env.OLLAMA_MODEL    || 'sqlcoder:7b',
        timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS)  || 180000,
        maxTokens: parseInt(process.env.OLLAMA_MAX_TOKENS)  || 2048,
        temperature: parseFloat(process.env.OLLAMA_TEMPERATURE) || 0.0,
        enabled: process.env.OLLAMA_ENABLED === 'true'
    },

    validation: {
        maxRows: parseInt(process.env.MAX_ROWS) || 5000,
        queryTimeoutSeconds: parseInt(process.env.QUERY_TIMEOUT_SECONDS) || 30
    },

    cache: {
        enabled: process.env.CACHE_ENABLED !== 'false',
        ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS) || 600,
        maxKeys: parseInt(process.env.CACHE_MAX_KEYS) || 200
    },

    explain: {
        maxSampleRows: parseInt(process.env.EXPLAIN_MAX_SAMPLE_ROWS) || 30,
        maxTokens: parseInt(process.env.EXPLAIN_MAX_TOKENS) || 1024
    },

    email: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        password: process.env.SMTP_PASSWORD || '',
        from: process.env.SMTP_FROM || 'KMC Smart Query <noreply@kmc.gov.in>'
    },

    dashboard: {
        schema: process.env.DASHBOARD_SCHEMA || 'mrkt_kmc2_data'
    },

    // ✅ FIX: config.scheduler was missing — caused app.js to crash at startup
    // app.js references config.scheduler.enabled at lines 67 and 74
    scheduler: {
        enabled: process.env.SCHEDULER_ENABLED === 'true'
    },

    schemaDiscovery: {
        // When true: auto-discover DB schema at startup and use it to augment/override static files
        enabled:    process.env.SCHEMA_DISCOVERY_ENABLED !== 'false', // on by default
        ttlSeconds: parseInt(process.env.SCHEMA_DISCOVERY_TTL_SECONDS) || 3600, // 1 hour cache
        warmOnStartup: process.env.SCHEMA_DISCOVERY_WARM_ON_STARTUP !== 'false', // pre-warm on boot
    }
};

module.exports = config;

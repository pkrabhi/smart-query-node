/**
 * Smart Query Service v3 — API Test Suite
 * Run: node src/test/apiTest.js
 * Make sure the service is running first: npm start
 */
const http = require('http');

const BASE = 'http://localhost:8101/smart-query-service/api/smart-query';

const tests = [
    // ── Existing endpoints ──
    {
        name: '1. Health Check (GET /status)',
        method: 'GET',
        url: `${BASE}/status`,
        body: null,
        validate: (r) => r.status === 'UP' && r.cache !== undefined ? '✓ Status UP + cache stats present' : '✗ Missing fields'
    },
    {
        name: '2. Simple Query (POST /ask)',
        method: 'POST',
        url: `${BASE}/ask`,
        body: {
            question: 'Show total collection market wise for FY 2024-2025',
            moduleCode: 'MARKET',
            finYear: '2024-2025',
            userId: 'test'
        },
        validate: (r) => r.success ? `✓ ${r.rowCount} rows, ${r.executionTimeMs}ms, fromCache: ${r.fromCache}` : `✗ ${r.errorType}`
    },
    {
        name: '3. Same Query Again (Cache Test)',
        method: 'POST',
        url: `${BASE}/ask`,
        body: {
            question: 'Show total collection market wise for FY 2024-2025',
            moduleCode: 'MARKET',
            finYear: '2024-2025',
            userId: 'test'
        },
        validate: (r) => r.success && r.fromCache ? `✓ CACHE HIT — ${r.executionTimeMs}ms (should be faster)` : `○ No cache hit (fromCache=${r.fromCache})`
    },

    // ── Follow-up context ──
    {
        name: '4. Follow-Up Query',
        method: 'POST',
        url: `${BASE}/ask`,
        body: {
            question: 'Now show only for market 101',
            moduleCode: 'MARKET',
            userId: 'test',
            previousQuestion: 'Show total collection market wise for FY 2024-2025',
            previousSql: 'SELECT mrkt_code, SUM(amount) FROM demands GROUP BY mrkt_code'
        },
        validate: (r) => r.success ? `✓ Follow-up: ${r.rowCount} rows` : `✗ ${r.errorType}: ${r.errorDetail}`
    },

    // ── AI Explain ──
    {
        name: '5. AI Explain (POST /explain)',
        method: 'POST',
        url: `${BASE}/explain`,
        body: {
            question: 'Show top 5 markets by collection',
            moduleCode: 'MARKET',
            columns: ['market_name', 'total_collection'],
            sampleData: [
                { market_name: 'Hogg Market', total_collection: 450000 },
                { market_name: 'New Market', total_collection: 380000 },
                { market_name: 'Lake Market', total_collection: 320000 },
            ],
            generatedSql: 'SELECT market_name, SUM(amount) as total_collection FROM ...',
            rowCount: 3
        },
        validate: (r) => r.success ? `✓ Insight (${r.insight?.length || 0} chars): "${r.insight?.slice(0, 80)}…"` : `✗ ${r.errorDetail}`
    },

    // ── Irrelevant question ──
    {
        name: '6. Irrelevant Question (UNABLE_TO_GENERATE)',
        method: 'POST',
        url: `${BASE}/ask`,
        body: {
            question: 'What is the weather today in Kolkata?',
            userId: 'test'
        },
        validate: (r) => !r.success && r.errorType === 'UNABLE_TO_GENERATE' ? '✓ Correctly rejected' : `✗ Unexpected: ${r.errorType}`
    },

    // ── Cache stats ──
    {
        name: '7. Cache Stats (via /status)',
        method: 'GET',
        url: `${BASE}/status`,
        body: null,
        validate: (r) => `✓ Cache: ${r.cache?.entries} entries, ${r.cache?.hitRate} hit rate`
    },

    // ── Cache Flush ──
    {
        name: '8. Cache Flush (POST /cache/flush)',
        method: 'POST',
        url: `${BASE}/cache/flush`,
        body: {},
        validate: (r) => r.success ? '✓ Cache flushed' : '✗ Flush failed'
    },

    // ── Dashboard CRUD ──
    {
        name: '9. Create Dashboard',
        method: 'POST',
        url: `${BASE}/dashboards`,
        body: {
            name: 'Daily Market Overview',
            description: 'Key market metrics for daily review',
            userId: 'test',
            moduleCode: 'MARKET'
        },
        validate: (r) => r.success ? `✓ Dashboard #${r.dashboard?.id} created` : `✗ ${r.error}`
    },
    {
        name: '10. List Dashboards',
        method: 'GET',
        url: `${BASE}/dashboards?userId=test`,
        body: null,
        validate: (r) => r.success ? `✓ ${r.dashboards?.length} dashboard(s) found` : `✗ ${r.error}`
    },

    // ── Scheduled Reports ──
    {
        name: '11. Create Scheduled Report',
        method: 'POST',
        url: `${BASE}/scheduled-reports`,
        body: {
            name: 'Weekly Market Collection',
            question: 'Show total collection market wise for current FY',
            moduleCode: 'MARKET',
            cronExpression: '0 8 * * 1',
            emailTo: 'admin@kmc.gov.in',
            format: 'csv',
            userId: 'test'
        },
        validate: (r) => r.success ? `✓ Report #${r.report?.id} scheduled (${r.report?.cron_expression})` : `✗ ${r.error}`
    },
    {
        name: '12. List Scheduled Reports',
        method: 'GET',
        url: `${BASE}/scheduled-reports?userId=test`,
        body: null,
        validate: (r) => r.success ? `✓ ${r.reports?.length} report(s) found` : `✗ ${r.error}`
    },
];

// ── SSE Streaming Test (special handling) ──
async function testStreaming() {
    console.log(`\n--- 13. SSE Streaming (POST /ask-stream) ---`);
    return new Promise((resolve) => {
        const body = JSON.stringify({
            question: 'Show top 5 markets by stall count',
            moduleCode: 'MARKET',
            userId: 'test'
        });

        const urlObj = new URL(`${BASE}/ask-stream`);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 120000
        };

        const events = [];
        const req = http.request(options, (res) => {
            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                        try {
                            const evt = JSON.parse(line.slice(6));
                            events.push(evt.type);
                            if (evt.type === 'step') process.stdout.write(`  → Step ${evt.step}: ${evt.label}\n`);
                            if (evt.type === 'result') process.stdout.write(`  → Result: ${evt.success ? evt.rowCount + ' rows' : evt.errorDetail}\n`);
                        } catch {}
                    }
                }
            });
            res.on('end', () => {
                const hasSteps = events.includes('step');
                const hasResult = events.includes('result');
                console.log(`Events received: [${events.join(', ')}]`);
                console.log(hasSteps && hasResult ? 'PASS ✓ Streaming pipeline works' : 'PARTIAL — some events missing');
                resolve();
            });
        });

        req.on('error', (e) => { console.log(`FAIL — ${e.message}`); resolve(); });
        req.on('timeout', () => { console.log('FAIL — Timeout'); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ── Runner ──
async function runTests() {
    console.log('==============================================');
    console.log('  Smart Query Service v3.0 — API Test Suite');
    console.log('==============================================\n');

    for (const test of tests) {
        console.log(`--- ${test.name} ---`);
        try {
            const t0 = Date.now();
            const result = await makeRequest(test.method, test.url, test.body);
            const elapsed = Date.now() - t0;
            console.log(`Time: ${elapsed}ms`);
            console.log(test.validate(result));
            console.log('');
        } catch (e) {
            console.log(`FAIL — ${e.message}\n`);
        }
    }

    // SSE test
    await testStreaming();

    console.log('\n==============================================');
    console.log('  All tests completed');
    console.log('==============================================');
}

function makeRequest(method, url, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ raw: data }); }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Timeout')));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

runTests();

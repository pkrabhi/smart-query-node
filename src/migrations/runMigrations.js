require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    host:     process.env.DB_HOST     || '192.168.0.132',
    port:     parseInt(process.env.DB_PORT) || 5444,
    database: process.env.DB_NAME     || 'digit',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    connectionTimeoutMillis: 10000
});

const migrations = [
    '001_niyantrak_runs.sql',
    '002_niyantrak_audit.sql',
    '003_niyantrak_action_queue.sql'
];

async function run() {
    const client = await pool.connect();
    try {
        for (const file of migrations) {
            const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
            console.log(`\n[MIGRATE] Running ${file}...`);
            await client.query(sql);
            console.log(`[MIGRATE] ✓ ${file} applied`);
        }

        // Verify tables exist
        const res = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('niyantrak_runs','niyantrak_audit','niyantrak_action_queue')
            ORDER BY table_name
        `);
        console.log('\n[MIGRATE] Tables verified:', res.rows.map(r => r.table_name));
        console.log('[MIGRATE] ✓ All migrations complete');
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(err => {
    console.error('[MIGRATE] FAILED:', err.message);
    process.exit(1);
});

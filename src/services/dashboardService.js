const pool = require('../config/database');
const config = require('../config');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { processQuery } = require('./orchestrator');

// ─────────────────────────────────────────────
//  Dashboard Service
//  • Save/load/delete dashboards (PostgreSQL-backed)
//  • Schedule reports with cron
//  • Email results as CSV
//
//  DB table: smart_query_dashboards
//  Created auto on first use.
// ─────────────────────────────────────────────

const SCHEMA = config.dashboard.schema;
const TABLE  = `${SCHEMA}.smart_query_dashboards`;

let tableReady = false;
const activeJobs = new Map();   // cronId → cron.ScheduledTask

class DashboardService {

    // ── Ensure table exists ──────────────────
    async ensureTable() {
        if (tableReady) return;
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ${TABLE} (
                    id              SERIAL PRIMARY KEY,
                    name            VARCHAR(200) NOT NULL,
                    description     TEXT,
                    user_id         VARCHAR(100) DEFAULT 'erp_user',
                    module_code     VARCHAR(20) NOT NULL DEFAULT 'MARKET',
                    queries         JSONB NOT NULL DEFAULT '[]',
                    layout          JSONB DEFAULT '{}',
                    schedule_cron   VARCHAR(50),
                    schedule_email  VARCHAR(200),
                    schedule_active BOOLEAN DEFAULT false,
                    created_at      TIMESTAMP DEFAULT NOW(),
                    updated_at      TIMESTAMP DEFAULT NOW()
                )
            `);
            tableReady = true;
            console.log(`[Dashboard] Table ${TABLE} ready`);
        } catch (e) {
            console.error(`[Dashboard] Table creation failed: ${e.message}`);
            // Non-fatal — may not have CREATE permission
        }
    }

    // ── Create a dashboard ───────────────────
    async create({ name, description, userId, moduleCode, queries, layout }) {
        await this.ensureTable();
        const result = await pool.query(
            `INSERT INTO ${TABLE} (name, description, user_id, module_code, queries, layout)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [name, description || '', userId || 'erp_user', moduleCode || 'MARKET',
             JSON.stringify(queries || []), JSON.stringify(layout || {})]
        );
        return result.rows[0];
    }

    // ── List dashboards for a user ───────────
    async list(userId) {
        await this.ensureTable();
        const result = await pool.query(
            `SELECT id, name, description, module_code, schedule_cron, schedule_active,
                    jsonb_array_length(queries) as query_count, created_at, updated_at
             FROM ${TABLE}
             WHERE user_id = $1
             ORDER BY updated_at DESC`,
            [userId || 'erp_user']
        );
        return result.rows;
    }

    // ── Get single dashboard ─────────────────
    async getById(id) {
        await this.ensureTable();
        const result = await pool.query(
            `SELECT * FROM ${TABLE} WHERE id = $1`, [id]
        );
        return result.rows[0] || null;
    }

    // ── Update dashboard ─────────────────────
    async update(id, fields) {
        await this.ensureTable();
        const sets = [];
        const vals = [];
        let idx = 1;

        for (const [key, val] of Object.entries(fields)) {
            if (['name', 'description', 'module_code', 'schedule_cron', 'schedule_email', 'schedule_active'].includes(key)) {
                sets.push(`${key} = $${idx++}`);
                vals.push(val);
            } else if (['queries', 'layout'].includes(key)) {
                sets.push(`${key} = $${idx++}`);
                vals.push(JSON.stringify(val));
            }
        }

        if (sets.length === 0) return null;

        sets.push(`updated_at = NOW()`);
        vals.push(id);

        const result = await pool.query(
            `UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
            vals
        );
        return result.rows[0] || null;
    }

    // ── Delete dashboard ─────────────────────
    async remove(id) {
        await this.ensureTable();
        this.stopSchedule(id);
        const result = await pool.query(
            `DELETE FROM ${TABLE} WHERE id = $1 RETURNING id`, [id]
        );
        return result.rows.length > 0;
    }

    // ── Run all queries in a dashboard ───────
    async runDashboard(id) {
        const dashboard = await this.getById(id);
        if (!dashboard) throw new Error(`Dashboard ${id} not found`);

        const queries = dashboard.queries || [];
        const results = [];

        for (const q of queries) {
            const result = await processQuery({
                question: q.question,
                moduleCode: dashboard.module_code,
                userId: dashboard.user_id,
                ...q.filters,
            });
            results.push({
                question: q.question,
                success: result.success,
                rowCount: result.rowCount,
                columns: result.columns,
                data: result.data,
                generatedSql: result.generatedSql,
                executionTimeMs: result.executionTimeMs,
                error: result.success ? null : result.errorDetail,
            });
        }

        return { dashboard: dashboard.name, moduleCode: dashboard.module_code, results };
    }

    // ── Schedule a dashboard report ──────────
    async startSchedule(id) {
        const dashboard = await this.getById(id);
        if (!dashboard) throw new Error(`Dashboard ${id} not found`);
        if (!dashboard.schedule_cron) throw new Error('No cron expression set');
        if (!cron.validate(dashboard.schedule_cron)) throw new Error(`Invalid cron: ${dashboard.schedule_cron}`);

        // Stop existing schedule if any
        this.stopSchedule(id);

        const job = cron.schedule(dashboard.schedule_cron, async () => {
            console.log(`[Scheduler] Running dashboard ${id}: "${dashboard.name}"`);
            try {
                const { results } = await this.runDashboard(id);
                if (dashboard.schedule_email) {
                    await this._sendReportEmail(dashboard, results);
                }
            } catch (e) {
                console.error(`[Scheduler] Dashboard ${id} failed: ${e.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });

        activeJobs.set(id, job);
        await this.update(id, { schedule_active: true });
        console.log(`[Scheduler] Started cron for dashboard ${id}: ${dashboard.schedule_cron}`);

        return { started: true, cron: dashboard.schedule_cron };
    }

    // ── Stop a scheduled report ──────────────
    stopSchedule(id) {
        const job = activeJobs.get(id);
        if (job) {
            job.stop();
            activeJobs.delete(id);
            console.log(`[Scheduler] Stopped cron for dashboard ${id}`);
        }
    }

    // ── Send report via email ────────────────
    async _sendReportEmail(dashboard, results) {
        if (!config.email.user || !config.email.password) {
            console.warn('[Email] SMTP not configured — skipping email');
            return;
        }

        const transporter = nodemailer.createTransport({
            host: config.email.host,
            port: config.email.port,
            secure: config.email.secure,
            auth: { user: config.email.user, pass: config.email.password },
        });

        // Build CSV attachments
        const attachments = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (!r.success || !r.columns || !r.data) continue;

            let csv = r.columns.join(',') + '\n';
            for (const row of r.data) {
                csv += r.columns.map(c => {
                    const v = row[c] != null ? String(row[c]) : '';
                    return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
                }).join(',') + '\n';
            }

            attachments.push({
                filename: `${dashboard.name}_query${i + 1}_${new Date().toISOString().slice(0, 10)}.csv`,
                content: csv,
                contentType: 'text/csv',
            });
        }

        // Build summary
        const summary = results.map((r, i) => 
            `${i + 1}. ${r.question} — ${r.success ? `${r.rowCount} rows (${r.executionTimeMs}ms)` : `FAILED: ${r.error}`}`
        ).join('\n');

        await transporter.sendMail({
            from: config.email.from,
            to: dashboard.schedule_email,
            subject: `[KMC Smart Query] Scheduled Report — ${dashboard.name}`,
            text: `Dashboard: ${dashboard.name}\nModule: ${dashboard.module_code}\nGenerated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\nQuery Results:\n${summary}\n\nCSV files attached.`,
            attachments,
        });

        console.log(`[Email] Sent report for "${dashboard.name}" to ${dashboard.schedule_email}`);
    }

    // ── Restore scheduled jobs on startup ────
    async restoreSchedules() {
        try {
            await this.ensureTable();
            const result = await pool.query(
                `SELECT id FROM ${TABLE} WHERE schedule_active = true AND schedule_cron IS NOT NULL`
            );
            for (const row of result.rows) {
                try {
                    await this.startSchedule(row.id);
                } catch (e) {
                    console.warn(`[Scheduler] Could not restore dashboard ${row.id}: ${e.message}`);
                }
            }
            console.log(`[Scheduler] Restored ${result.rows.length} scheduled dashboard(s)`);
        } catch (e) {
            console.warn(`[Scheduler] Restore failed (table may not exist): ${e.message}`);
        }
    }
}

module.exports = new DashboardService();

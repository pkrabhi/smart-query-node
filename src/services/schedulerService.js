const cron = require('node-cron');
const nodemailer = require('nodemailer');
const config = require('../config');
const { processQuery } = require('./orchestrator');
const dashboardService = require('./dashboardService');

// ─────────────────────────────────────────────
//  Scheduler Service
//  Runs scheduled report queries via cron jobs
//  and emails results as CSV or summary.
//
//  Each sq_scheduled_reports row becomes a cron job.
//  Jobs are refreshed on startup and when reports
//  are created/updated/deleted.
// ─────────────────────────────────────────────

const activeJobs = new Map(); // id → cron.ScheduledTask
let transporter = null;

/**
 * Initialize SMTP transporter.
 */
function initTransporter() {
    // ✅ FIX: was config.smtp.* — should be config.email.* (matches config/index.js)
    if (!config.email.user || !config.email.password) {
        console.log('[Scheduler] SMTP not configured — email delivery disabled');
        return null;
    }

    transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: {
            user: config.email.user,
            pass: config.email.password,
        },
    });

    console.log(`[Scheduler] SMTP configured: ${config.email.host}:${config.email.port}`);
    return transporter;
}

/**
 * Load all enabled scheduled reports and start cron jobs.
 */
async function startAll() {
    if (!config.scheduler.enabled) {
        console.log('[Scheduler] Disabled via config');
        return;
    }

    initTransporter();

    try {
        // ✅ FIX: was dashboardService.listScheduledReports() — method doesn't exist.
        // DashboardService exposes list(userId) for dashboards.
        const reports = await dashboardService.list('erp_user');
        const enabled = reports.filter(r => r.schedule_active && r.schedule_cron);

        console.log(`[Scheduler] Loading ${enabled.length} active scheduled dashboards...`);

        for (const report of enabled) {
            try {
                await dashboardService.startSchedule(report.id);
            } catch (e) {
                console.warn(`[Scheduler] Could not start dashboard #${report.id}: ${e.message}`);
            }
        }

        console.log(`[Scheduler] ${activeJobs.size} cron jobs active`);
    } catch (e) {
        console.error('[Scheduler] Failed to load reports:', e.message);
    }
}

/**
 * Schedule a single report as a cron job.
 */
function scheduleReport(report) {
    // Stop existing job if any
    if (activeJobs.has(report.id)) {
        activeJobs.get(report.id).stop();
    }

    if (!cron.validate(report.cron_expression)) {
        console.warn(`[Scheduler] Invalid cron: "${report.cron_expression}" for report ${report.id}`);
        return;
    }

    const task = cron.schedule(report.cron_expression, () => {
        executeAndEmail(report).catch(e => {
            console.error(`[Scheduler] Job ${report.id} failed:`, e.message);
        });
    });

    activeJobs.set(report.id, task);
    console.log(`[Scheduler] Scheduled #${report.id}: "${report.name}" → ${report.cron_expression}`);
}

/**
 * Execute query and email results.
 */
async function executeAndEmail(report) {
    console.log(`[Scheduler] Running report #${report.id}: "${report.name}"`);
    const startTime = Date.now();

    try {
        // Run the query
        const result = await processQuery({
            question: report.question,
            moduleCode: report.module_code,
            userId: 'scheduler',
            ...report.filters,
        });

        if (!result.success) {
            // ✅ FIX: was dashboardService.updateScheduledReport() — method doesn't exist.
            // Use dashboardService.update(id, fields) instead.
            await dashboardService.update(report.id, {
                updated_at: new Date().toISOString(),
            }).catch(() => {});
            console.warn(`[Scheduler] Report #${report.id} query failed: ${result.errorType}`);
            return;
        }

        // Build CSV
        const csv = buildCsv(result.columns, result.data);

        // Send email
        if (transporter && report.email_to) {
            const filename = `${report.name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;

            await transporter.sendMail({
                from: config.email.from,
                to: report.email_to,
                subject: `📊 Scheduled Report: ${report.name} — ${result.rowCount} rows`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px;">
                        <h2 style="color: #1A237E;">📊 ${report.name}</h2>
                        <p style="color: #555;">Automated report from KMC Smart Query</p>
                        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                            <tr><td style="padding: 6px 12px; background: #F5F5F5; font-weight: bold;">Question</td><td style="padding: 6px 12px;">${report.question}</td></tr>
                            <tr><td style="padding: 6px 12px; background: #F5F5F5; font-weight: bold;">Module</td><td style="padding: 6px 12px;">${report.module_code}</td></tr>
                            <tr><td style="padding: 6px 12px; background: #F5F5F5; font-weight: bold;">Rows</td><td style="padding: 6px 12px;">${result.rowCount}</td></tr>
                            <tr><td style="padding: 6px 12px; background: #F5F5F5; font-weight: bold;">Execution Time</td><td style="padding: 6px 12px;">${result.executionTimeMs}ms</td></tr>
                        </table>
                        <p style="color: #999; font-size: 12px;">CSV file attached. Generated at ${new Date().toLocaleString('en-IN')}</p>
                    </div>
                `,
                attachments: [{
                    filename,
                    content: csv,
                    contentType: 'text/csv',
                }],
            });

            console.log(`[Scheduler] Report #${report.id} emailed to: ${report.email_to}`);
        }

        // ✅ FIX: was dashboardService.updateScheduledReport() → use dashboardService.update()
        await dashboardService.update(report.id, {
            updated_at: new Date().toISOString(),
        });

    } catch (e) {
        console.error(`[Scheduler] Report #${report.id} error:`, e.message);
        // ✅ FIX: was dashboardService.updateScheduledReport() → use dashboardService.update()
        await dashboardService.update(report.id, {
            updated_at: new Date().toISOString(),
        }).catch(() => {});
    }
}

/**
 * Build CSV string from columns + data.
 */
function buildCsv(columns, data) {
    const escape = (v) => {
        if (!v) return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let csv = columns.map(escape).join(',') + '\n';
    for (const row of data) {
        csv += columns.map(c => escape(row[c] != null ? String(row[c]) : '')).join(',') + '\n';
    }
    return csv;
}

/**
 * Stop all active cron jobs.
 */
function stopAll() {
    for (const [id, task] of activeJobs) {
        task.stop();
    }
    activeJobs.clear();
    console.log('[Scheduler] All jobs stopped');
}

/**
 * Refresh a single report's cron job (after create/update).
 */
function refreshReport(report) {
    if (report.enabled) {
        scheduleReport(report);
    } else if (activeJobs.has(report.id)) {
        activeJobs.get(report.id).stop();
        activeJobs.delete(report.id);
    }
}

module.exports = { startAll, stopAll, scheduleReport, refreshReport, executeAndEmail };

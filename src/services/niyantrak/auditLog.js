const crypto = require('crypto');
const pool = require('../../config/database');

const GENESIS = 'GENESIS';

/**
 * Compute sha256 of (prev_hash + canonical_json_of_payload).
 * Keys in payload are sorted to ensure determinism.
 */
function computeHash(prev_hash, payload) {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(prev_hash + canonical).digest('hex');
}

/**
 * Append one audit entry to niyantrak_audit.
 * Automatically computes prev_hash and payload_hash.
 *
 * @param {object} opts
 * @param {string} opts.run_id
 * @param {number} opts.step_index
 * @param {string} opts.agent_name
 * @param {object} opts.payload     - arbitrary JSON describing what the agent did
 * @param {string} [opts.status]    - PENDING | APPROVED | REJECTED | EXECUTED
 * @returns {object} the inserted row
 */
async function appendAudit({ run_id, step_index, agent_name, payload, status = 'PENDING' }) {
    // Fetch the hash of the previous entry in this run
    const prevRes = await pool.query(
        `SELECT payload_hash FROM niyantrak_audit
          WHERE run_id = $1
          ORDER BY step_index DESC
          LIMIT 1`,
        [run_id]
    );
    const prev_hash = prevRes.rows.length > 0 ? prevRes.rows[0].payload_hash : GENESIS;
    const payload_hash = computeHash(prev_hash, payload);

    const res = await pool.query(
        `INSERT INTO niyantrak_audit
           (run_id, step_index, agent_name, prev_hash, payload_json, payload_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [run_id, step_index, agent_name, prev_hash, JSON.stringify(payload), payload_hash, status]
    );
    return res.rows[0];
}

/**
 * Update an existing audit entry's status (e.g. PENDING → APPROVED/REJECTED).
 */
async function updateAuditStatus({ run_id, step_index, status, approved_by, rejection_reason }) {
    const res = await pool.query(
        `UPDATE niyantrak_audit
            SET status = $3,
                approved_by = $4,
                approved_at = CASE WHEN $3 = 'APPROVED' THEN NOW() ELSE NULL END,
                rejection_reason = $5
          WHERE run_id = $1 AND step_index = $2
          RETURNING *`,
        [run_id, step_index, status, approved_by || null, rejection_reason || null]
    );
    return res.rows[0];
}

/**
 * Walk all audit entries for a run and verify the hash chain.
 * Returns { valid, entries_checked, broken_at_step, expected_hash, actual_hash }
 */
async function verifyChain(run_id) {
    const res = await pool.query(
        `SELECT * FROM niyantrak_audit
          WHERE run_id = $1
          ORDER BY step_index ASC`,
        [run_id]
    );
    const entries = res.rows;

    if (entries.length === 0) {
        return { valid: true, entries_checked: 0, broken_at_step: null };
    }

    let prev_hash = GENESIS;

    for (const entry of entries) {
        const expected = computeHash(prev_hash, entry.payload_json);
        if (expected !== entry.payload_hash) {
            return {
                valid: false,
                entries_checked: entries.length,
                broken_at_step: entry.step_index,
                expected_hash: expected,
                actual_hash: entry.payload_hash
            };
        }
        // Verify internal prev_hash linkage
        if (entry.prev_hash !== prev_hash) {
            return {
                valid: false,
                entries_checked: entries.length,
                broken_at_step: entry.step_index,
                expected_hash: prev_hash,
                actual_hash: entry.prev_hash
            };
        }
        prev_hash = entry.payload_hash;
    }

    return {
        valid: true,
        entries_checked: entries.length,
        broken_at_step: null,
        final_hash: prev_hash
    };
}

/**
 * Fetch all audit entries for a run (ordered by step_index).
 */
async function getAuditEntries(run_id) {
    const res = await pool.query(
        `SELECT * FROM niyantrak_audit WHERE run_id = $1 ORDER BY step_index ASC`,
        [run_id]
    );
    return res.rows;
}

module.exports = { appendAudit, updateAuditStatus, verifyChain, getAuditEntries, computeHash };

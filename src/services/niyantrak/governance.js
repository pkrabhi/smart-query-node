const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const POLICY_PATH = path.resolve(__dirname, '../../config/governance.yaml');

let policy = null;

function loadPolicy() {
    const raw = fs.readFileSync(POLICY_PATH, 'utf8');
    policy = yaml.load(raw);
    console.log('[Governance] Policy loaded from', POLICY_PATH);
}

// Load on first require
loadPolicy();

/**
 * Returns true if the action_type requires human approval per policy.
 */
function requiresApproval(action_type) {
    const action = policy.actions[action_type];
    if (!action) return true; // unknown action → always require approval
    return action.requires_approval === true;
}

/**
 * Checks policy constraints for a proposed action.
 * Returns { allowed: boolean, reasons: string[] }
 */
function checkPolicy(action_type, payload, user) {
    const reasons = [];
    const action = policy.actions[action_type];

    if (!action) {
        return { allowed: false, reasons: [`Unknown action type: ${action_type}`] };
    }

    // Batch size check
    if (action.max_per_batch !== undefined && payload && Array.isArray(payload.items)) {
        if (payload.items.length > action.max_per_batch) {
            reasons.push(
                `Batch size ${payload.items.length} exceeds max_per_batch of ${action.max_per_batch}`
            );
        }
    }

    // Role check
    if (action.requires_role && action.requires_role.length > 0 && user) {
        const userRole = user.role || user.userId || user.user_id;
        const allowed = action.requires_role.some(r =>
            r === userRole || r === user.userId || r === user.user_id
        );
        if (!allowed) {
            reasons.push(
                `User '${userRole}' does not have required role. Allowed: ${action.requires_role.join(', ')}`
            );
        }
    }

    return { allowed: reasons.length === 0, reasons };
}

/**
 * Returns the full agent config block for a given agent name.
 */
function agentConfig(agent_name) {
    return (policy.agents && policy.agents[agent_name]) || {};
}

/**
 * Returns the full loaded policy object (for inspection / logging).
 */
function getPolicy() {
    return policy;
}

module.exports = { requiresApproval, checkPolicy, agentConfig, getPolicy, loadPolicy };

-- Migration 002: Niyantrak hash-chained audit log
-- Idempotent — safe to run multiple times

CREATE TABLE IF NOT EXISTS niyantrak_audit (
    id               BIGSERIAL PRIMARY KEY,
    run_id           UUID NOT NULL REFERENCES niyantrak_runs(run_id) ON DELETE CASCADE,
    step_index       INT NOT NULL,
    agent_name       TEXT NOT NULL,
    prev_hash        TEXT NOT NULL,
    payload_json     JSONB NOT NULL,
    payload_hash     TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXECUTED')),
    approved_by      TEXT,
    approved_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_niyantrak_audit_run     ON niyantrak_audit(run_id);
CREATE INDEX IF NOT EXISTS idx_niyantrak_audit_status  ON niyantrak_audit(status);
CREATE INDEX IF NOT EXISTS idx_niyantrak_audit_created ON niyantrak_audit(created_at DESC);

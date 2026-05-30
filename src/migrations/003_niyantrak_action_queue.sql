-- Migration 003: Niyantrak action queue (approved actions awaiting delivery)
-- Idempotent — safe to run multiple times

CREATE TABLE IF NOT EXISTS niyantrak_action_queue (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES niyantrak_runs(run_id) ON DELETE CASCADE,
    action_type     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    payload         JSONB NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (delivery_status IN ('QUEUED','SENT','FAILED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    failure_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_niyantrak_queue_status ON niyantrak_action_queue(delivery_status);
CREATE INDEX IF NOT EXISTS idx_niyantrak_queue_run    ON niyantrak_action_queue(run_id);

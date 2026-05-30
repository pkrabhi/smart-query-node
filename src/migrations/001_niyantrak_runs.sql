-- Migration 001: Niyantrak run tracking table
-- Idempotent — safe to run multiple times

CREATE TABLE IF NOT EXISTS niyantrak_runs (
    run_id        UUID PRIMARY KEY,
    user_prompt   TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    plan          JSONB,
    final_status  TEXT NOT NULL CHECK (final_status IN ('IN_PROGRESS','COMPLETED','REJECTED','ERROR')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_niyantrak_runs_user    ON niyantrak_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_niyantrak_runs_status  ON niyantrak_runs(final_status);
CREATE INDEX IF NOT EXISTS idx_niyantrak_runs_started ON niyantrak_runs(started_at DESC);

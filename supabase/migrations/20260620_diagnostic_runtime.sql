-- Runtime fields required by the anonymous adaptive diagnostic.
-- Safe to run repeatedly in Supabase SQL editor.

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS current_item_id UUID REFERENCES item_bank(id),
ADD COLUMN IF NOT EXISTS current_item_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS prior_mean FLOAT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS prior_sd FLOAT NOT NULL DEFAULT 1.5;

ALTER TABLE item_bank
ADD COLUMN IF NOT EXISTS requires_diagram BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS diagram_status VARCHAR(20) DEFAULT 'not_needed'
  CHECK (diagram_status IN ('not_needed','pending_creation','pending_conversion','complete')),
ADD COLUMN IF NOT EXISTS diagram_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_response_per_session_item
ON item_responses(session_id, item_id)
WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_current_item
ON sessions(current_item_id)
WHERE current_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_item_bank_diagnostic_ready
ON item_bank(domain, b_param)
WHERE calibration_status IN ('Warming','Calibrated','Anchored')
  AND flagged_for_review = FALSE
  AND b_param IS NOT NULL;

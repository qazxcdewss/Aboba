-- Moderation tables per ADR-005/009
CREATE TABLE IF NOT EXISTS moderation_tasks (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moderation_tasks_profile_status_idx ON moderation_tasks(profile_id, status);

CREATE TABLE IF NOT EXISTS moderation_decisions (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES moderation_tasks(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reason_code TEXT NULL,
  notes TEXT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_tg TEXT NULL
);

CREATE INDEX IF NOT EXISTS moderation_decisions_task_idx ON moderation_decisions(task_id);



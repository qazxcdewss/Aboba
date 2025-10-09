-- Create Profile table according to Prisma model
CREATE TABLE IF NOT EXISTS profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  nickname TEXT NOT NULL,
  is_visible BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles
  ADD CONSTRAINT profile_user_fk
  FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_profile_user_status ON profiles(user_id, status);

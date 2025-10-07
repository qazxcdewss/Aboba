-- Create Profile table according to Prisma model
CREATE TABLE IF NOT EXISTS "Profile" (
  id BIGSERIAL PRIMARY KEY,
  "userId" BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  nickname TEXT NOT NULL,
  "isVisible" BOOLEAN NOT NULL DEFAULT FALSE,
  "publishedAt" TIMESTAMPTZ NULL,
  "expiresAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "Profile"
  ADD CONSTRAINT profile_user_fk
  FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_profile_user_status ON "Profile"("userId", status);

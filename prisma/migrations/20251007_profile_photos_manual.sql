CREATE TABLE IF NOT EXISTS "ProfilePhoto" (
  id BIGSERIAL PRIMARY KEY,
  "profileId" BIGINT NOT NULL,
  "storageKey" TEXT NOT NULL UNIQUE,
  "sha256Hex" TEXT NOT NULL,
  "isCover" BOOLEAN NOT NULL DEFAULT FALSE,
  position INT NOT NULL DEFAULT 100,
  "sizeBytes" INT NOT NULL,
  mime TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "ProfilePhoto"
  ADD CONSTRAINT profile_photo_profile_fk
  FOREIGN KEY ("profileId") REFERENCES "Profile"(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_photo_sha ON "ProfilePhoto"("profileId", "sha256Hex");
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_photo_position ON "ProfilePhoto"("profileId", position);
CREATE INDEX IF NOT EXISTS idx_profile_photo_profile ON "ProfilePhoto"("profileId");

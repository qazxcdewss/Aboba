CREATE TABLE IF NOT EXISTS profile_photos (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  sha256_hex TEXT NOT NULL,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  position INT NOT NULL DEFAULT 100,
  size_bytes INT NOT NULL,
  mime TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  virus_scanned BOOLEAN NOT NULL DEFAULT FALSE,
  exif_stripped BOOLEAN NOT NULL DEFAULT FALSE,
  watermark_applied BOOLEAN NOT NULL DEFAULT FALSE,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  processing_error TEXT NULL,
  nsfw_score NUMERIC(4,3) NULL,
  processed_at TIMESTAMPTZ NULL
);

ALTER TABLE profile_photos
  ADD CONSTRAINT profile_photo_profile_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_photo_sha ON profile_photos(profile_id, sha256_hex);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_photo_position ON profile_photos(profile_id, position);
CREATE INDEX IF NOT EXISTS idx_profile_photo_profile ON profile_photos(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_cover_one ON profile_photos(profile_id)
  WHERE is_cover = TRUE;
CREATE INDEX IF NOT EXISTS idx_profile_photo_processing_state ON profile_photos(processing_state);

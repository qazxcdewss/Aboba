-- Copy data from legacy PascalCase tables to snake_case and drop legacy

-- Copy Profile → profiles
DO $$
BEGIN
  IF to_regclass('"Profile"') IS NOT NULL THEN
    INSERT INTO profiles (id, user_id, status, nickname, is_visible, published_at, expires_at, created_at, updated_at)
    SELECT id, "userId", status, nickname, "isVisible", "publishedAt", "expiresAt", "createdAt", "updatedAt"
    FROM "Profile"
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- Copy ProfilePhoto → profile_photos
DO $$
BEGIN
  IF to_regclass('"ProfilePhoto"') IS NOT NULL THEN
    INSERT INTO profile_photos (id, profile_id, storage_key, sha256_hex, is_cover, position, size_bytes, mime, created_at, updated_at)
    SELECT id, "profileId", "storageKey", "sha256Hex", "isCover", position, "sizeBytes", mime, "createdAt", "updatedAt"
    FROM "ProfilePhoto"
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- Drop legacy tables if present
DROP TABLE IF EXISTS "ProfilePhoto";
DROP TABLE IF EXISTS "Profile";



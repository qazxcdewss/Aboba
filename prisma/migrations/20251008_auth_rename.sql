-- Safe rename of PascalCase auth tables/columns to snake_case per DB Spec

DO $$
BEGIN
  IF to_regclass('"User"') IS NOT NULL AND to_regclass('users') IS NULL THEN
    EXECUTE 'ALTER TABLE "User" RENAME TO users';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"Session"') IS NOT NULL AND to_regclass('sessions') IS NULL THEN
    EXECUTE 'ALTER TABLE "Session" RENAME TO sessions';
  END IF;
END $$;

-- users columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='emailVerified'
  ) THEN
    EXECUTE 'ALTER TABLE users RENAME COLUMN "emailVerified" TO email_verified';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='lastLoginAt'
  ) THEN
    EXECUTE 'ALTER TABLE users RENAME COLUMN "lastLoginAt" TO last_login_at';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='createdAt'
  ) THEN
    EXECUTE 'ALTER TABLE users RENAME COLUMN "createdAt" TO created_at';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='updatedAt'
  ) THEN
    EXECUTE 'ALTER TABLE users RENAME COLUMN "updatedAt" TO updated_at';
  END IF;
END $$;

-- sessions columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='userId'
  ) THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN "userId" TO user_id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='issuedAt'
  ) THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN "issuedAt" TO issued_at';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='expiresAt'
  ) THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN "expiresAt" TO expires_at';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='revokedAt'
  ) THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN "revokedAt" TO revoked_at';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='userAgent'
  ) THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN "userAgent" TO user_agent';
  END IF;
  -- Add token_hash if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessions' AND column_name='token_hash'
  ) THEN
    EXECUTE 'ALTER TABLE sessions ADD COLUMN token_hash TEXT';
  END IF;
END $$;



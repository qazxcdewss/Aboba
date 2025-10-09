-- Safe rename auth_challenges.userId -> user_id (PowerShell-safe via -f)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='auth_challenges' AND column_name='userId'
  ) THEN
    EXECUTE 'ALTER TABLE auth_challenges RENAME COLUMN "userId" TO user_id';
  END IF;
END $$;



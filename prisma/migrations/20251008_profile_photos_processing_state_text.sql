-- Ensure processing_state is TEXT (drop enum dependency if any)
ALTER TABLE profile_photos
  ALTER COLUMN processing_state TYPE TEXT USING processing_state::text,
  ALTER COLUMN processing_state SET DEFAULT 'pending';



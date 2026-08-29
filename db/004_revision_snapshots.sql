BEGIN;

ALTER TABLE revisions ALTER COLUMN blocks DROP NOT NULL;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS artifact_snapshot jsonb;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS runtime_state_snapshot jsonb;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS snapshot_bytes bigint;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS snapshot_pruned boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='revisions' AND column_name='snapshot_available' AND is_generated='ALWAYS'
  ) THEN
    ALTER TABLE revisions DROP COLUMN snapshot_available;
  END IF;
END $$;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS snapshot_available boolean NOT NULL DEFAULT false;
UPDATE revisions
SET snapshot_available = artifact_snapshot IS NOT NULL AND runtime_state_snapshot IS NOT NULL AND NOT snapshot_pruned
WHERE snapshot_available IS DISTINCT FROM (artifact_snapshot IS NOT NULL AND runtime_state_snapshot IS NOT NULL AND NOT snapshot_pruned);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='revisions_source_check' AND conrelid='revisions'::regclass
      AND pg_get_constraintdef(oid) LIKE '%delete_blocks%' AND pg_get_constraintdef(oid) LIKE '%restore_revision%'
  ) THEN
    ALTER TABLE revisions DROP CONSTRAINT IF EXISTS revisions_source_check;
    ALTER TABLE revisions ADD CONSTRAINT revisions_source_check
      CHECK (source IN ('set_artifact', 'update_blocks', 'delete_blocks', 'restore_revision')) NOT VALID;
    ALTER TABLE revisions VALIDATE CONSTRAINT revisions_source_check;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revisions_artifact_snapshot_object' AND conrelid = 'revisions'::regclass) THEN
    ALTER TABLE revisions ADD CONSTRAINT revisions_artifact_snapshot_object
      CHECK (artifact_snapshot IS NULL OR jsonb_typeof(artifact_snapshot) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revisions_runtime_snapshot_object' AND conrelid = 'revisions'::regclass) THEN
    ALTER TABLE revisions ADD CONSTRAINT revisions_runtime_snapshot_object
      CHECK (runtime_state_snapshot IS NULL OR jsonb_typeof(runtime_state_snapshot) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revisions_snapshot_bytes_nonnegative' AND conrelid = 'revisions'::regclass) THEN
    ALTER TABLE revisions ADD CONSTRAINT revisions_snapshot_bytes_nonnegative
      CHECK (snapshot_bytes IS NULL OR snapshot_bytes >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revisions_snapshot_availability_consistent' AND conrelid = 'revisions'::regclass) THEN
    ALTER TABLE revisions ADD CONSTRAINT revisions_snapshot_availability_consistent
      CHECK (snapshot_available = (artifact_snapshot IS NOT NULL AND runtime_state_snapshot IS NOT NULL AND NOT snapshot_pruned));
  END IF;
END $$;

-- Legacy rows retain their honest block-only payload but are not restorable: a historical
-- artifact title and runtime state cannot be reconstructed without inventing data.

ALTER TABLE final_versions ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE final_versions ADD COLUMN IF NOT EXISTS title text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'final_versions_format_v1' AND conrelid = 'final_versions'::regclass) THEN
    ALTER TABLE final_versions ADD CONSTRAINT final_versions_format_v1
      CHECK (format IS NULL OR format = 'buildparty.artifact/v1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'final_versions_title_length' AND conrelid = 'final_versions'::regclass) THEN
    ALTER TABLE final_versions ADD CONSTRAINT final_versions_title_length
      CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200);
  END IF;
END $$;

COMMIT;

BEGIN;

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE artifacts ALTER COLUMN format SET DEFAULT 'buildparty.artifact/v1';
UPDATE artifacts SET format = 'buildparty.artifact/v1' WHERE format IS NULL;
ALTER TABLE artifacts ALTER COLUMN format SET NOT NULL;

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS title text;
UPDATE artifacts SET title = parties.title FROM parties WHERE artifacts.party_id = parties.id AND artifacts.title IS NULL;
ALTER TABLE artifacts ALTER COLUMN title SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_format_v1' AND conrelid = 'artifacts'::regclass) THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_format_v1 CHECK (format = 'buildparty.artifact/v1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_title_length' AND conrelid = 'artifacts'::regclass) THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_title_length CHECK (char_length(title) BETWEEN 1 AND 200);
  END IF;
END $$;

COMMIT;

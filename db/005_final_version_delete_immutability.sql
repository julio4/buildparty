BEGIN;

CREATE OR REPLACE FUNCTION reject_final_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'final versions are immutable'; END $$;

DROP TRIGGER IF EXISTS final_versions_immutable ON final_versions;
CREATE TRIGGER final_versions_immutable
BEFORE UPDATE OR DELETE ON final_versions
FOR EACH ROW EXECUTE FUNCTION reject_final_version_update();

COMMIT;

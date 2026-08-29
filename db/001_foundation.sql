BEGIN;

CREATE TABLE IF NOT EXISTS parties (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  lifecycle text NOT NULL DEFAULT 'initialized'
    CHECK (lifecycle IN ('initialized', 'in_review', 'revising', 'finalized')),
  owner_capability_hash text NOT NULL CHECK (char_length(owner_capability_hash) = 64),
  share_capability_hash text NOT NULL CHECK (char_length(share_capability_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);

CREATE TABLE IF NOT EXISTS participants (
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  identity_id text NOT NULL CHECK (char_length(identity_id) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, identity_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  party_id uuid PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
  format text NOT NULL DEFAULT 'buildparty.artifact/v1',
  title text NOT NULL,
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  runtime_state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(runtime_state) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revisions (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('set_artifact', 'update_blocks')),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  changed_block_ids text[] NOT NULL,
  feedback_ids uuid[] NOT NULL DEFAULT '{}',
  summary text,
  actor_identity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id, version)
);

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  block_id text,
  kind text NOT NULL CHECK (kind IN ('comment', 'question', 'change', 'approval', 'disagreement')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  actor_identity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_identity_id text
);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id uuid PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 10000),
  revision_id uuid REFERENCES revisions(id),
  resolved boolean NOT NULL DEFAULT false,
  actor_identity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR revision_id IS NOT NULL OR resolved)
);

CREATE TABLE IF NOT EXISTS final_versions (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL UNIQUE REFERENCES parties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  source_version integer NOT NULL CHECK (source_version > 0),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  runtime_state jsonb NOT NULL CHECK (jsonb_typeof(runtime_state) = 'object'),
  html text NOT NULL,
  actor_identity_id text NOT NULL,
  open_feedback_overridden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_final_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'final versions are immutable'; END $$;

DROP TRIGGER IF EXISTS final_versions_immutable ON final_versions;
CREATE TRIGGER final_versions_immutable BEFORE UPDATE ON final_versions
FOR EACH ROW EXECUTE FUNCTION reject_final_version_update();

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_identity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_party_status_idx ON feedback (party_id, status, created_at);
CREATE INDEX IF NOT EXISTS revisions_party_created_idx ON revisions (party_id, created_at);
CREATE INDEX IF NOT EXISTS audit_party_created_idx ON audit_events (party_id, created_at);

COMMIT;

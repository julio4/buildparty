BEGIN;

CREATE TABLE IF NOT EXISTS participant_sessions (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL,
  identity_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (party_id, identity_id) REFERENCES participants (party_id, identity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS participant_sessions_party_idx ON participant_sessions (party_id, identity_id);

COMMIT;

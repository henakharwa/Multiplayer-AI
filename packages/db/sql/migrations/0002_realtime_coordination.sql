-- Coordination tables so more than one chat-server process can serve the
-- same workspaces: live events fan out through Postgres LISTEN/NOTIFY
-- (payloads stored here because NOTIFY payloads are size-limited), and
-- the one-agent-turn-at-a-time rule is enforced with a shared lock row.
CREATE TABLE IF NOT EXISTS realtime_events (
  id BIGSERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realtime_events_created_idx ON realtime_events (created_at);

CREATE TABLE IF NOT EXISTS agent_turn_locks (
  room TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Durable B2G requests. Each new attempt has a different immutable identity;
-- accepting an old notification cannot accept a later request between the pair.
CREATE TABLE player_friendships (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','cancelled','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_id <> recipient_id)
);
CREATE UNIQUE INDEX player_friendships_live_pair
  ON player_friendships (LEAST(requester_id,recipient_id),GREATEST(requester_id,recipient_id))
  WHERE status IN ('pending','accepted');
CREATE INDEX player_friendships_requester ON player_friendships (requester_id,status,updated_at DESC,id);
CREATE INDEX player_friendships_recipient ON player_friendships (recipient_id,status,updated_at DESC,id);

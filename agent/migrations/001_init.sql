-- Autumn agent schema. Purchase decisions come from the chain; these tables
-- hold plans, the encrypted session keys, an attempt lock and a run log.

CREATE TABLE owners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL UNIQUE CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES owners(id),
  wallet_address        text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  amount_per_week       numeric(78, 0) NOT NULL CHECK (amount_per_week > 0),
  fee_allowance_per_buy numeric(78, 0) NOT NULL CHECK (fee_allowance_per_buy >= 0),
  dip_buy               boolean NOT NULL DEFAULT false,
  day_of_week           smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour_utc              smallint NOT NULL CHECK (hour_utc BETWEEN 0 AND 23),
  expires_at            bigint NOT NULL,
  status                text NOT NULL DEFAULT 'pending_grant' CHECK (status IN ('pending_grant', 'active', 'stopped')),
  stopped_reason        text,
  session_public_key    text NOT NULL UNIQUE CHECK (session_public_key ~ '^0x04[0-9a-f]{128}$'),
  session               jsonb,
  created_at            bigint NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR session IS NOT NULL)
);
CREATE INDEX plans_active ON plans (status) WHERE status = 'active';

-- AES-256-GCM ciphertext of each plan's session private key; plan id is the AAD.
CREATE TABLE session_keys (
  plan_id     uuid PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  ciphertext  bytea NOT NULL,
  iv          bytea NOT NULL CHECK (length(iv) = 12),
  auth_tag    bytea NOT NULL CHECK (length(auth_tag) = 16),
  key_version integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_attempts (
  id          bigserial PRIMARY KEY,
  plan_id     uuid NOT NULL REFERENCES plans(id),
  week_id     date NOT NULL,
  slot        text NOT NULL CHECK (slot IN ('weekly', 'dip')),
  status      text NOT NULL CHECK (status IN ('submitting', 'ambiguous', 'bought', 'not_bought')),
  started_at  bigint NOT NULL,
  amount_in   numeric(78, 0) NOT NULL,
  min_out     numeric(78, 0) NOT NULL,
  calls_id    text,
  tx_hash     text,
  out_amount  numeric(78, 0),
  reason      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The lock: at most one open or successful attempt per plan, week and slot.
CREATE UNIQUE INDEX purchase_attempts_one_live
  ON purchase_attempts (plan_id, week_id, slot)
  WHERE status IN ('submitting', 'ambiguous', 'bought');
CREATE INDEX purchase_attempts_open ON purchase_attempts (plan_id) WHERE status IN ('submitting', 'ambiguous');

CREATE TABLE run_log (
  id         bigserial PRIMARY KEY,
  plan_id    uuid NOT NULL REFERENCES plans(id),
  week_id    date NOT NULL,
  at         bigint NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('bought', 'skipped', 'failed', 'ambiguous', 'stopped')),
  reason     text NOT NULL,
  tx_hash    text,
  amount_in  numeric(78, 0),
  out_amount numeric(78, 0)
);
CREATE INDEX run_log_plan ON run_log (plan_id, id DESC);

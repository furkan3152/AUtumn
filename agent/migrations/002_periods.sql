-- Daily plans, period-neutral names, and the facts the app shows from the
-- server: grant and revoke transactions, the creation block, and a
-- machine-readable kind for each run-log entry.

ALTER TABLE plans RENAME COLUMN amount_per_week TO amount_per_buy;
ALTER TABLE plans ADD COLUMN period text NOT NULL DEFAULT 'week' CHECK (period IN ('day', 'week'));
ALTER TABLE plans ADD COLUMN created_block numeric(78, 0);
ALTER TABLE plans ADD COLUMN grant_tx_hash text CHECK (grant_tx_hash ~ '^0x[0-9a-f]{64}$');
ALTER TABLE plans ADD COLUMN stop_tx_hash text CHECK (stop_tx_hash ~ '^0x[0-9a-f]{64}$');
ALTER TABLE plans ADD COLUMN stopped_at bigint;
CREATE INDEX plans_wallet ON plans (wallet_address, created_at DESC);

ALTER TABLE purchase_attempts RENAME COLUMN week_id TO period_id;
ALTER TABLE purchase_attempts DROP CONSTRAINT purchase_attempts_status_check;
ALTER TABLE purchase_attempts ADD CONSTRAINT purchase_attempts_status_check
  CHECK (status IN ('submitting', 'ambiguous', 'bought', 'not_bought', 'deferred'));

ALTER TABLE run_log RENAME COLUMN week_id TO period_id;
ALTER TABLE run_log ADD COLUMN kind text;

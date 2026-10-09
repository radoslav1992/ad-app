-- Withdrawals within 14 days, the request for immediate start, operations and retention (docs/OPERATIONS.md,
-- docs/PRIVACY.md). Additive only (new tables, one nullable column, indexes and one trigger), so the version already
-- running keeps working once it is applied.

-- The consumer's express request, given before a first checkout, for the plan to start at once (CRD Art. 14(3) and
-- 16(m); ЗЗП чл. 55): one row per Stripe Checkout session, with the version of the text agreed to. `completed_at`:
-- Stripe reported the checkout complete; `confirmed_at`: the confirmation email was sent. No foreign key to users:
-- kept as evidence after the account is deleted (`account_deleted_at`), then removed by retention.
CREATE TABLE IF NOT EXISTS checkout_consents (
 session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan TEXT NOT NULL, version TEXT NOT NULL,
 created_at INTEGER NOT NULL, completed_at INTEGER, confirmed_at INTEGER, account_deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS checkout_consents_user ON checkout_consents(user_id);
CREATE INDEX IF NOT EXISTS checkout_consents_pending ON checkout_consents(completed_at) WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS checkout_consents_deleted ON checkout_consents(account_deleted_at) WHERE account_deleted_at IS NOT NULL;

-- A withdrawal handled by an administrator: the plan ends, its posts and AI credits stop, and what was paid comes back
-- less the share of the plan used (the larger of the posts share and the credits share). Amounts in cents of
-- `currency`. One per subscription; kept as evidence (no foreign key), then removed by retention.
CREATE TABLE IF NOT EXISTS withdrawals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription_id TEXT NOT NULL UNIQUE, currency TEXT NOT NULL DEFAULT 'usd',
 paid INTEGER NOT NULL CHECK(paid>=0), refund INTEGER NOT NULL CHECK(refund>=0), refunded INTEGER NOT NULL DEFAULT 0,
 used INTEGER NOT NULL, quota INTEGER NOT NULL, posts_used INTEGER NOT NULL, posts_quota INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('started','completed','refund_failed')), error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_recent ON withdrawals(created_at);

-- Small records kept by maintenance (the last hourly run, failed stages, the last operator alert, the last Stripe
-- reconciliation), and provider work or storage cleanup set aside for a manual check.
CREATE TABLE IF NOT EXISTS operations_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS manual_reviews (
 area TEXT NOT NULL, ref TEXT NOT NULL, request_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(area, ref)
);
CREATE INDEX IF NOT EXISTS manual_reviews_recent ON manual_reviews(created_at);

-- Terms acceptances and checkout consents outlive the account as evidence; their 5 years start when it is deleted.
ALTER TABLE terms_acceptances ADD COLUMN account_deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS terms_acceptances_deleted ON terms_acceptances(account_deleted_at) WHERE account_deleted_at IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS evidence_account_deleted BEFORE DELETE ON users BEGIN
 UPDATE terms_acceptances SET account_deleted_at=unixepoch() WHERE user_id=OLD.id AND account_deleted_at IS NULL;
 UPDATE checkout_consents SET account_deleted_at=unixepoch() WHERE user_id=OLD.id AND account_deleted_at IS NULL;
END;

-- Retention (server/retention.ts) and the operations summary (server/operations.ts) run hourly; these keep every
-- statement they make on an index.
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_tokens_expires ON auth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS contact_messages_created ON contact_messages(created_at);
CREATE INDEX IF NOT EXISTS billing_events_created ON billing_events(created_at);
CREATE INDEX IF NOT EXISTS checkout_intents_expires ON checkout_intents(expires_at);
CREATE INDEX IF NOT EXISTS trial_history_updated ON trial_history(updated_at);
CREATE INDEX IF NOT EXISTS cleanup_tasks_created ON cleanup_tasks(created_at);
CREATE INDEX IF NOT EXISTS users_unconfirmed ON users(created_at) WHERE verified=0;
-- Finished runs whose provider state (tickets, input-link token, voice timings) has not been cleared yet.
CREATE INDEX IF NOT EXISTS runs_uncleared ON runs(updated_at) WHERE provider<>'{}';
-- Publications that still hold a media-link token or a provider ticket (published ones drop both at once).
CREATE INDEX IF NOT EXISTS publications_spent ON publications(updated_at) WHERE token IS NOT NULL OR ticket IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_accounts_status ON social_accounts(status, updated_at);
CREATE INDEX IF NOT EXISTS link_clicks_day ON link_clicks(day);
CREATE INDEX IF NOT EXISTS conversions_created ON conversions(created_at);

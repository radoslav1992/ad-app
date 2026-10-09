-- Post performance and click / sale attribution (server/metrics.ts, server/tracking.ts, server/analytics.ts).
-- Additive only (new columns and tables), so the code deployed before it keeps working once this is applied.

-- Lifetime counts of a published post as its network reports them; NULL means not read (or not shared by the network).
-- `metrics_at`: when the counts were last read; `metrics_checked_at`: the last attempt (schedules the next one);
-- `metrics_error`: why the last attempt read nothing: 'scope' (reconnect to allow stats), 'reconnect', 'not_found', 'failed'.
ALTER TABLE publications ADD COLUMN views INTEGER;
ALTER TABLE publications ADD COLUMN likes INTEGER;
ALTER TABLE publications ADD COLUMN comments INTEGER;
ALTER TABLE publications ADD COLUMN shares INTEGER;
ALTER TABLE publications ADD COLUMN metrics_at INTEGER;
ALTER TABLE publications ADD COLUMN metrics_checked_at INTEGER;
ALTER TABLE publications ADD COLUMN metrics_error TEXT;
CREATE INDEX publications_published ON publications(status, published_at);

-- A workspace's click and sale tracking: the public key its site's script sends sales with, where tracked links lead
-- (`target_url`, else the workspace's website), whether post captions get one, and when the script last checked in.
CREATE TABLE analytics_sites (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, site_key TEXT NOT NULL UNIQUE, target_url TEXT, links_enabled INTEGER NOT NULL DEFAULT 0, tested_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- Short links ${SITE_URL}/go/<code>: one per post and network (in captions), or per network with post_id '' (link in bio).
-- post_id has no foreign key on purpose: a published link keeps working after the post is deleted here.
CREATE TABLE tracked_links (code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, post_id TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(workspace_id, platform, post_id));
-- Clicks per link and UTC day (`day` = unix seconds / 86400). Counts only: nothing about the visitor is stored.
CREATE TABLE link_clicks (code TEXT NOT NULL REFERENCES tracked_links(code) ON DELETE CASCADE, day INTEGER NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(code, day));
-- Sales and sign-ups reported by the customer's site or server. `code`/`post_id`/`platform`: the last tracked click
-- within 30 days (NULL when none). `amount` is in hundredths of `currency`; `order_hash` is a SHA-256 of the order ID
-- (dedupes repeats without keeping the ID).
CREATE TABLE conversions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, code TEXT, post_id TEXT, platform TEXT, order_hash TEXT, amount INTEGER NOT NULL DEFAULT 0, currency TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX conversions_order ON conversions(workspace_id, order_hash) WHERE order_hash IS NOT NULL;
CREATE INDEX conversions_workspace ON conversions(workspace_id, created_at);

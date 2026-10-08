PRAGMA foreign_keys = ON;

-- Accounts ---------------------------------------------------------------------------------------------------------
-- `onboarding`: answers from the first-run questions (role, team size, revenue) and when it was finished.
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, stripe_customer TEXT UNIQUE, onboarding TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('verify','reset')), expires_at INTEGER NOT NULL);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- Evidence of accepted terms; kept after the account is deleted (no foreign key).
CREATE TABLE terms_acceptances (user_id TEXT NOT NULL, version TEXT NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(user_id, version));
CREATE TABLE contact_messages (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);
-- R2 keys (or key prefixes) still to delete; drained by maintenance.
CREATE TABLE cleanup_tasks (prefix TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

-- Billing ----------------------------------------------------------------------------------------------------------
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, status TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, event_created INTEGER NOT NULL DEFAULT 0);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE stripe_status (subscription_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE stripe_reconciled (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, checked_at INTEGER NOT NULL);
CREATE TABLE billing_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE checkout_intents (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, intent_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
-- One usage window per paid period (user:subscription:period_start) or the lasting free window (user:trial).
-- `quota`/`used` are AI credits; `posts_quota`/`posts_used` count generated posts.
CREATE TABLE usage_windows (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT, quota INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0), posts_quota INTEGER NOT NULL DEFAULT 0, posts_used INTEGER NOT NULL DEFAULT 0 CHECK(posts_used>=0));
-- The free allowance is once per mailbox, also across deleted accounts (keyed HMAC of the mailbox).
CREATE TABLE trial_history (email_hash TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, posts_used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE media_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, max_bytes INTEGER NOT NULL);

-- Workspaces (one brand each) --------------------------------------------------------------------------------------
-- The brand comes from a website / app store link (`website`) or a written `description`; the scan runs in the
-- background (`scan_step`: website → profile → images) while the owner answers the onboarding questions.
CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, website TEXT, description TEXT, logo_asset TEXT, profile TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}', scan_status TEXT NOT NULL DEFAULT 'idle' CHECK(scan_status IN ('idle','scanning','ready','failed')), scan_step TEXT, scan_error TEXT, scanned_at INTEGER, automated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX workspaces_user ON workspaces(user_id, created_at);

-- Posts and their generation runs -----------------------------------------------------------------------------------
-- `status` is the review (Blitz) state; `render_status` the state of the finished media.
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), batch_id TEXT, format TEXT NOT NULL CHECK(format IN ('slideshow','text','ugc','hook_demo','green_screen')), spec TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), render_status TEXT NOT NULL DEFAULT 'queued' CHECK(render_status IN ('queued','running','ready','failed')), render_error TEXT, video_asset TEXT, cover_asset TEXT, slides TEXT NOT NULL DEFAULT '[]', duration REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX posts_workspace ON posts(workspace_id, created_at DESC);
CREATE INDEX posts_review ON posts(workspace_id, status, render_status);
CREATE TRIGGER post_quota BEFORE INSERT ON posts BEGIN
 SELECT RAISE(ABORT,'POSTS_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND posts_used<posts_quota);
END;
CREATE TRIGGER post_count AFTER INSERT ON posts BEGIN UPDATE usage_windows SET posts_used=posts_used+1 WHERE id=NEW.window_id; END;

-- A run generates (AI media, voice, avatar video) and renders a post, or makes a standalone AI image/character.
-- Credits are reserved in the same transaction as the insert and refunded exactly once when it fails.
CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), idempotency_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('post','image','character')), initial INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT, payload TEXT NOT NULL DEFAULT '{}', provider TEXT NOT NULL DEFAULT '{}', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key));
CREATE INDEX runs_user ON runs(user_id, created_at DESC);
CREATE INDEX runs_active ON runs(status, created_at);
CREATE UNIQUE INDEX one_active_run_per_post ON runs(post_id) WHERE status IN ('queued','running') AND post_id IS NOT NULL;
CREATE TRIGGER run_active_limit BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'RUNS_BUSY') WHERE (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND status IN ('queued','running'))>=20;
END;
CREATE TRIGGER run_credit_reserve BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota);
END;
CREATE TRIGGER run_credit_charge AFTER INSERT ON runs WHEN NEW.credits>0 BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER run_refund AFTER UPDATE OF status ON runs WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN
 UPDATE usage_windows SET used=MAX(0,used-NEW.credits), posts_used=MAX(0,posts_used-NEW.initial) WHERE id=NEW.window_id;
END;

-- Media ------------------------------------------------------------------------------------------------------------
-- Uploads, website images, AI images/clips, voices, avatar videos and rendered outputs. Files generated for a post
-- belong to it (post_id) and go with it.
CREATE TABLE media_assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('upload','brand','ai_image','ai_clip','voice','avatar','render','slide','portrait')), name TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('uploading','checking','ready','failed')), upload_id TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX media_user ON media_assets(user_id, created_at DESC);
CREATE INDEX media_workspace ON media_assets(workspace_id, kind);
CREATE INDEX media_post ON media_assets(post_id);
CREATE TRIGGER media_storage_limit BEFORE INSERT ON media_assets BEGIN
 SELECT RAISE(ABORT,'STORAGE_FULL') WHERE NEW.bytes + COALESCE((SELECT SUM(bytes) FROM media_assets WHERE user_id=NEW.user_id),0) > COALESCE((SELECT max_bytes FROM media_limits WHERE user_id=NEW.user_id),0);
END;
CREATE TRIGGER media_file_limit BEFORE INSERT ON media_assets BEGIN
 SELECT RAISE(ABORT,'STORAGE_FULL') WHERE (SELECT COUNT(*) FROM media_assets WHERE user_id=NEW.user_id)>=5000;
END;
CREATE TRIGGER media_cleanup AFTER DELETE ON media_assets BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES(OLD.object_key,unixepoch()); END;
CREATE TABLE media_parts (asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, part INTEGER NOT NULL, etag TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(asset_id, part));

-- AI UGC characters: the library (user_id NULL, set up by administrators) and people's own (`consent`: the version of
-- the confirmation given for a photo of a real person).
CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '', image_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, look_id TEXT, engines TEXT NOT NULL DEFAULT '[]', consent TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX characters_user ON characters(user_id, created_at);
CREATE TRIGGER character_cleanup AFTER DELETE ON characters BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES(OLD.image_key,unixepoch()); END;
-- The shared library administrators fill: music, short video clips (reactions, activity, filler; tagged) and green-screen
-- clips for memes. Posts reference them without a copy.
CREATE TABLE library_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('music','clip','greenscreen')), name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', object_key TEXT NOT NULL UNIQUE, thumb_key TEXT, mime TEXT NOT NULL, bytes INTEGER NOT NULL, duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
-- Each item's files live under library/{id}/ (the file and its thumbnail).
CREATE TRIGGER library_cleanup AFTER DELETE ON library_items BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('library/'||OLD.id||'/',unixepoch()); END;

-- Social accounts and publishing -----------------------------------------------------------------------------------
-- `credentials` is AES-GCM encrypted JSON (TOKEN_ENCRYPTION_KEY); never returned to the browser.
CREATE TABLE social_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube','linkedin')), external_id TEXT NOT NULL, name TEXT NOT NULL, handle TEXT, avatar_url TEXT, credentials TEXT NOT NULL, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id, platform, external_id));
CREATE INDEX social_accounts_user ON social_accounts(user_id);
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, platform TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
-- A disconnected account leaves its published history (account_id NULL, `account_name` kept).
CREATE TABLE publications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL, account_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL, scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','publishing','published','failed','canceled')), attempts INTEGER NOT NULL DEFAULT 0, token TEXT, ticket TEXT, external_id TEXT, url TEXT, error TEXT, claimed_at INTEGER, published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX publications_due ON publications(status, scheduled_at);
CREATE INDEX publications_workspace ON publications(workspace_id, scheduled_at);
CREATE INDEX publications_post ON publications(post_id);
CREATE UNIQUE INDEX publication_once ON publications(post_id, account_id) WHERE status IN ('scheduled','publishing','published');

-- Nothing in progress is deleted from under its worker.
CREATE TRIGGER post_busy BEFORE DELETE ON posts WHEN EXISTS(SELECT 1 FROM runs WHERE post_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE post_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'POST_BUSY'); END;
CREATE TRIGGER account_busy BEFORE DELETE ON social_accounts WHEN EXISTS(SELECT 1 FROM publications WHERE account_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'ACCOUNT_BUSY'); END;
CREATE TRIGGER user_busy BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM runs WHERE user_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE user_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'USER_BUSY'); END;
CREATE TRIGGER user_cleanup BEFORE DELETE ON users BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('media/'||OLD.id||'/',unixepoch()); END;

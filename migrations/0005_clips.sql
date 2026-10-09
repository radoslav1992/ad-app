-- Clips from long videos and paid speech to text (server/shorts.ts, server/speech.ts): posts may be of format 'clip',
-- runs of kind 'speech' (a long video transcribed for AI credits, at most one at a time per file). The format 'story'
-- is allowed too, for the narrated story format that follows, so production's posts table is rebuilt only once.
--
-- SQLite cannot change a CHECK constraint, so `posts` and `runs` are rebuilt with every row, index and trigger.
-- D1 always enforces foreign keys and runs a migration in one transaction (PRAGMA foreign_keys cannot be turned off),
-- and DROP TABLE first deletes every row of the table, which cascades: runs, media_assets and publications rows of
-- every post would be deleted (and their files queued for deletion), even with defer_foreign_keys. So before a table
-- is dropped its keys are moved aside ('~' prefix): no child row matches them, nothing cascades, and the violations
-- this leaves are deferred (defer_foreign_keys) until the copy is put back under the original keys, which resolves
-- them all before the commit. Rows are copied before the triggers are created, so no quota or credit counts twice.
-- Proven with rows in every child table in tests/shorts.test.ts.
PRAGMA defer_foreign_keys = ON;

-- Posts ------------------------------------------------------------------------------------------------------------
CREATE TABLE posts_copy AS SELECT * FROM posts;
UPDATE posts SET id='~'||id;
DROP TABLE posts;
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), batch_id TEXT, format TEXT NOT NULL CHECK(format IN ('slideshow','text','ugc','hook_demo','green_screen','clip','story')), spec TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), render_status TEXT NOT NULL DEFAULT 'queued' CHECK(render_status IN ('queued','running','ready','failed')), render_error TEXT, video_asset TEXT, cover_asset TEXT, slides TEXT NOT NULL DEFAULT '[]', duration REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO posts(id,user_id,workspace_id,window_id,batch_id,format,spec,hook,caption,title,status,render_status,render_error,video_asset,cover_asset,slides,duration,revision,reviewed_at,created_at,updated_at)
  SELECT id,user_id,workspace_id,window_id,batch_id,format,spec,hook,caption,title,status,render_status,render_error,video_asset,cover_asset,slides,duration,revision,reviewed_at,created_at,updated_at FROM posts_copy;
DROP TABLE posts_copy;
CREATE INDEX posts_workspace ON posts(workspace_id, created_at DESC);
CREATE INDEX posts_review ON posts(workspace_id, status, render_status);
CREATE TRIGGER post_quota BEFORE INSERT ON posts BEGIN
 SELECT RAISE(ABORT,'POSTS_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND posts_used<posts_quota);
END;
CREATE TRIGGER post_count AFTER INSERT ON posts BEGIN UPDATE usage_windows SET posts_used=posts_used+1 WHERE id=NEW.window_id; END;

-- Runs (after posts: their post_id rows must find the new posts) -----------------------------------------------------
CREATE TABLE runs_copy AS SELECT * FROM runs;
UPDATE runs SET id='~'||id;
DROP TABLE runs;
CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), idempotency_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('post','image','character','speech')), initial INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT, payload TEXT NOT NULL DEFAULT '{}', provider TEXT NOT NULL DEFAULT '{}', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key));
INSERT INTO runs(id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,phase,payload,provider,error,created_at,updated_at)
  SELECT id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,phase,payload,provider,error,created_at,updated_at FROM runs_copy;
DROP TABLE runs_copy;
CREATE INDEX runs_user ON runs(user_id, created_at DESC);
CREATE INDEX runs_active ON runs(status, created_at);
CREATE UNIQUE INDEX one_active_run_per_post ON runs(post_id) WHERE status IN ('queued','running') AND post_id IS NOT NULL;
-- A file is transcribed for credits once at a time (two requests cannot both pay).
CREATE UNIQUE INDEX one_active_speech_per_asset ON runs(json_extract(payload,'$.assetId')) WHERE kind='speech' AND status IN ('queued','running');
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

-- Dropped with the old posts table; recreated after runs, which its condition reads.
CREATE TRIGGER post_busy BEFORE DELETE ON posts WHEN EXISTS(SELECT 1 FROM runs WHERE post_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE post_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'POST_BUSY'); END;

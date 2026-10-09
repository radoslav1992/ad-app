-- Carousels (designed picture posts, shared/carousel.ts) and Instagram saves.
--
-- posts.format loses its CHECK list: the app validates every format with zod on every write (shared/formats.ts,
-- specSchema), so a new format needs no rebuild of posts again. SQLite cannot drop a CHECK constraint, so `posts` is
-- rebuilt exactly as 0005 rebuilt it (see there why): copied aside, its keys moved ('~' prefix) so DROP TABLE cascades
-- to no child row (runs, media_assets, publications), dropped, recreated, and copied back under the
-- original keys before the commit, which resolves the deferred foreign key violations. Its indexes and triggers
-- (0001: posts_workspace, posts_review, post_quota, post_count, post_busy) are recreated word for word, after the
-- rows are back so no post counts twice. Proven with rows in every child table in tests/carousel.test.ts.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE posts_copy AS SELECT * FROM posts;
UPDATE posts SET id='~'||id;
DROP TABLE posts;
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), batch_id TEXT, format TEXT NOT NULL, spec TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), render_status TEXT NOT NULL DEFAULT 'queued' CHECK(render_status IN ('queued','running','ready','failed')), render_error TEXT, video_asset TEXT, cover_asset TEXT, slides TEXT NOT NULL DEFAULT '[]', duration REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO posts(id,user_id,workspace_id,window_id,batch_id,format,spec,hook,caption,title,status,render_status,render_error,video_asset,cover_asset,slides,duration,revision,reviewed_at,created_at,updated_at)
  SELECT id,user_id,workspace_id,window_id,batch_id,format,spec,hook,caption,title,status,render_status,render_error,video_asset,cover_asset,slides,duration,revision,reviewed_at,created_at,updated_at FROM posts_copy;
DROP TABLE posts_copy;
CREATE INDEX posts_workspace ON posts(workspace_id, created_at DESC);
CREATE INDEX posts_review ON posts(workspace_id, status, render_status);
CREATE TRIGGER post_quota BEFORE INSERT ON posts BEGIN
 SELECT RAISE(ABORT,'POSTS_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND posts_used<posts_quota);
END;
CREATE TRIGGER post_count AFTER INSERT ON posts BEGIN UPDATE usage_windows SET posts_used=posts_used+1 WHERE id=NEW.window_id; END;
CREATE TRIGGER post_busy BEFORE DELETE ON posts WHEN EXISTS(SELECT 1 FROM runs WHERE post_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE post_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'POST_BUSY'); END;

-- How often a published post was saved (Instagram's `saved` insight; other networks do not report it: NULL).
ALTER TABLE publications ADD COLUMN saves INTEGER;

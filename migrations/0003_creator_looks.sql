-- A HeyGen look belongs to at most one library creator, also when two imports of it run at the same time.
CREATE UNIQUE INDEX characters_library_look ON characters(look_id) WHERE user_id IS NULL AND look_id IS NOT NULL;
-- The creator picker pages through active creators, newest first.
CREATE INDEX characters_active ON characters(active, user_id, created_at);

ALTER TABLE books ADD COLUMN cover_thumbnail_small_path TEXT;
ALTER TABLE books ADD COLUMN cover_thumbnail_large_path TEXT;
ALTER TABLE books ADD COLUMN cover_thumbnail_version TEXT;

CREATE TABLE library_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

INSERT INTO library_revision (id, revision)
VALUES (1, 1)
ON CONFLICT(id) DO NOTHING;

CREATE TRIGGER books_library_revision_insert
AFTER INSERT ON books
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER books_library_revision_update
AFTER UPDATE ON books
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER books_library_revision_delete
AFTER DELETE ON books
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER folders_library_revision_insert
AFTER INSERT ON folders
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER folders_library_revision_update
AFTER UPDATE ON folders
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER folders_library_revision_delete
AFTER DELETE ON folders
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER reading_progress_library_revision_insert
AFTER INSERT ON reading_progress
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER reading_progress_library_revision_update
AFTER UPDATE ON reading_progress
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER reading_progress_library_revision_delete
AFTER DELETE ON reading_progress
BEGIN
  UPDATE library_revision SET revision = revision + 1 WHERE id = 1;
END;

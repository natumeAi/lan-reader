CREATE TABLE reading_hourly_activity (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  local_hour INTEGER NOT NULL CHECK (local_hour >= 0 AND local_hour <= 23),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  PRIMARY KEY (book_id, local_date, local_hour)
);

CREATE INDEX idx_reading_hourly_activity_date ON reading_hourly_activity(local_date);

CREATE TABLE reading_completion_observations (
  event_id TEXT PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_reading_completion_observations_date ON reading_completion_observations(local_date);
CREATE INDEX idx_reading_completion_observations_book ON reading_completion_observations(book_id);

-- Only completions with a known captured local date. Undated legacy
-- membership, positions and acknowledgment times are never turned into dates.
INSERT OR IGNORE INTO reading_completion_observations (event_id, book_id, local_date, occurred_at)
SELECT event_id, book_id, local_date, occurred_at FROM reading_completions;

ALTER TABLE reading_stats_settings ADD COLUMN detail_tracking_started_at TEXT;

UPDATE reading_stats_settings
SET detail_tracking_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1;

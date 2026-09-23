CREATE TABLE reading_stats_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  daily_goal_minutes INTEGER NOT NULL DEFAULT 10 CHECK (daily_goal_minutes >= 1 AND daily_goal_minutes <= 1440),
  annual_book_goal INTEGER NOT NULL DEFAULT 9 CHECK (annual_book_goal >= 1 AND annual_book_goal <= 9999),
  tracking_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO reading_stats_settings (
  id,
  daily_goal_minutes,
  annual_book_goal,
  tracking_started_at,
  updated_at
)
VALUES (
  1,
  10,
  9,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE reading_activity_events (
  id TEXT PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  local_date TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  characters_added INTEGER NOT NULL CHECK (characters_added >= 0),
  skipped_sections TEXT NOT NULL DEFAULT '[]',
  accepted_at TEXT NOT NULL
);

CREATE INDEX idx_reading_activity_events_book ON reading_activity_events(book_id);

CREATE TABLE reading_daily_activity (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  characters INTEGER NOT NULL DEFAULT 0 CHECK (characters >= 0),
  PRIMARY KEY (book_id, local_date)
);

CREATE INDEX idx_reading_daily_activity_date ON reading_daily_activity(local_date);

CREATE TABLE reading_section_coverage (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  normalization_version INTEGER NOT NULL CHECK (normalization_version > 0),
  section_index INTEGER NOT NULL CHECK (section_index >= 0),
  signature TEXT NOT NULL,
  section_length INTEGER NOT NULL CHECK (section_length > 0),
  intervals TEXT NOT NULL,
  covered_characters INTEGER NOT NULL CHECK (covered_characters >= 0 AND covered_characters <= section_length),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (book_id, normalization_version, section_index)
);

CREATE TABLE reading_completions (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (book_id, year)
);

CREATE INDEX idx_reading_completions_year ON reading_completions(year, local_date);

CREATE TABLE reading_legacy_completions (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE
);

INSERT INTO reading_legacy_completions (book_id)
SELECT book_id FROM reading_progress WHERE progress >= 1;

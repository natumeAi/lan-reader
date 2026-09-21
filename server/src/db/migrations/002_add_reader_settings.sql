CREATE TABLE reader_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  font_size INTEGER NOT NULL DEFAULT 100 CHECK (font_size >= 80 AND font_size <= 140),
  font_family_id TEXT NOT NULL DEFAULT 'system',
  horizontal_margin INTEGER NOT NULL DEFAULT 24 CHECK (horizontal_margin >= 12 AND horizontal_margin <= 48),
  vertical_margin INTEGER NOT NULL DEFAULT 20 CHECK (vertical_margin >= 12 AND vertical_margin <= 48),
  line_height REAL NOT NULL DEFAULT 1.6 CHECK (line_height >= 1.3 AND line_height <= 2),
  letter_spacing REAL NOT NULL DEFAULT 0 CHECK (letter_spacing >= 0 AND letter_spacing <= 0.12),
  theme_id TEXT NOT NULL DEFAULT 'light',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO reader_settings (
  id,
  font_size,
  font_family_id,
  horizontal_margin,
  vertical_margin,
  line_height,
  letter_spacing,
  theme_id
)
VALUES (1, 100, 'system', 24, 20, 1.6, 0, 'light')
ON CONFLICT(id) DO NOTHING;

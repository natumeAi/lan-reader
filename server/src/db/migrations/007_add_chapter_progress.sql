ALTER TABLE reading_progress ADD COLUMN chapter_count INTEGER;
ALTER TABLE reading_progress ADD COLUMN chapter_index INTEGER
CHECK ((chapter_count IS NULL AND chapter_index IS NULL) OR
       (chapter_count IS NOT NULL AND chapter_index IS NOT NULL AND
        typeof(chapter_count) = 'integer' AND chapter_count BETWEEN 1 AND 9007199254740991 AND
        typeof(chapter_index) = 'integer' AND chapter_index >= -1 AND chapter_index < chapter_count));

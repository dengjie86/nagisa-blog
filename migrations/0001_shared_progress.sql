CREATE TABLE IF NOT EXISTS study_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    reset_stamp TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO study_meta (id) VALUES (1);

CREATE TABLE IF NOT EXISTS study_progress (
    field_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    stamp TEXT NOT NULL,
    revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS study_progress_revision ON study_progress (revision);

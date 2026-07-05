-- Migration 005: Fix incident status constraint to include maintenance statuses
-- SQLite doesn't support ALTER TABLE to modify constraints, so we need to recreate the table

-- Step 1: Create new table with corrected constraint
CREATE TABLE IF NOT EXISTS incidents_new (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'investigating' CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'verifying', 'completed')),
    impact TEXT DEFAULT 'none' CHECK (impact IN ('none', 'minor', 'major', 'critical')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    scheduled_for TEXT,
    scheduled_until TEXT,
    is_scheduled INTEGER DEFAULT 0,
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
);

-- Step 2: Copy data from old table
INSERT INTO incidents_new SELECT * FROM incidents;

-- Step 3: Drop old table
DROP TABLE incidents;

-- Step 4: Rename new table
ALTER TABLE incidents_new RENAME TO incidents;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_incidents_page ON incidents(status_page_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

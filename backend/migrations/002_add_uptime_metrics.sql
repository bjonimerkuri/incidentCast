-- Migration: Add uptime tracking and metrics tables
-- Apply: npx wrangler d1 execute incidentcast-db --remote --file=migrations/002_add_uptime_metrics.sql

-- Component uptime history (hourly snapshots)
CREATE TABLE IF NOT EXISTS uptime_history (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    status TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
);

-- Daily uptime summary for faster queries
CREATE TABLE IF NOT EXISTS uptime_daily (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    date TEXT NOT NULL,
    uptime_minutes INTEGER DEFAULT 0,
    downtime_minutes INTEGER DEFAULT 0,
    degraded_minutes INTEGER DEFAULT 0,
    incidents_count INTEGER DEFAULT 0,
    uptime_percentage REAL DEFAULT 100.0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    UNIQUE(component_id, date)
);

-- Custom metrics for status pages
CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    name TEXT NOT NULL,
    suffix TEXT DEFAULT '',
    display_order INTEGER DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
);

-- Metric data points
CREATE TABLE IF NOT EXISTS metric_data (
    id TEXT PRIMARY KEY,
    metric_id TEXT NOT NULL,
    value REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (metric_id) REFERENCES metrics(id) ON DELETE CASCADE
);

-- End user incident reports
CREATE TABLE IF NOT EXISTS incident_reports (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    reporter_email TEXT,
    reporter_name TEXT,
    component_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'converted', 'dismissed')),
    incident_id TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by TEXT,
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE SET NULL,
    FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_uptime_history_component ON uptime_history(component_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_uptime_daily_component ON uptime_daily(component_id, date);
CREATE INDEX IF NOT EXISTS idx_metrics_page ON metrics(status_page_id);
CREATE INDEX IF NOT EXISTS idx_metric_data_metric ON metric_data(metric_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_incident_reports_page ON incident_reports(status_page_id, status);

-- Migration: Add webhooks, webhook_deliveries, and notification_queue tables
-- Apply to production database: npx wrangler d1 execute incidentcast-db --remote --file=migrations/001_add_webhooks_notifications.sql

-- Webhooks for external integrations
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT DEFAULT '["incident.created","incident.updated","incident.resolved","component.status_changed","maintenance.scheduled"]',
    is_active INTEGER DEFAULT 1,
    last_triggered_at TEXT,
    last_status_code INTEGER,
    failure_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    delivered_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

-- Email notification queue
CREATE TABLE IF NOT EXISTS notification_queue (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('email', 'sms', 'webhook')),
    subject TEXT,
    body TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    scheduled_for TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

-- Indexes for the new tables
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_notification_queue_page ON notification_queue(status_page_id);

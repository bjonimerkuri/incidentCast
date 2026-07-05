-- IncidentCast Database Schema for Cloudflare D1

-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    email_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Organizations/Teams
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    logo_url TEXT,
    website_url TEXT,
    support_url TEXT,
    timezone TEXT DEFAULT 'UTC',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Organization members
CREATE TABLE IF NOT EXISTS organization_members (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(organization_id, user_id)
);

-- Status pages (public facing pages)
CREATE TABLE IF NOT EXISTS status_pages (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subdomain TEXT UNIQUE NOT NULL,
    custom_domain TEXT,
    description TEXT,
    logo_url TEXT,
    favicon_url TEXT,
    header_bg_color TEXT DEFAULT '#ffffff',
    header_text_color TEXT DEFAULT '#111827',
    accent_color TEXT DEFAULT '#3b82f6',
    show_subscribe_button INTEGER DEFAULT 1,
    show_incident_history_days INTEGER DEFAULT 90,
    google_analytics_id TEXT,
    custom_css TEXT,
    custom_html_head TEXT,
    is_public INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Component groups for organizing components
CREATE TABLE IF NOT EXISTS component_groups (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    collapsed_by_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
);

-- Components (services/systems being monitored)
CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    group_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'operational' CHECK (status IN ('operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance')),
    display_order INTEGER DEFAULT 0,
    show_uptime INTEGER DEFAULT 1,
    start_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE SET NULL
);

-- Incidents
CREATE TABLE IF NOT EXISTS incidents (
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

-- Incident updates (timeline)
CREATE TABLE IF NOT EXISTS incident_updates (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    user_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'verifying', 'completed')),
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Incident affected components
CREATE TABLE IF NOT EXISTS incident_components (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    status TEXT DEFAULT 'degraded_performance' CHECK (status IN ('operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance')),
    FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    UNIQUE(incident_id, component_id)
);

-- Subscribers for notifications
CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    webhook_url TEXT,
    is_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    unsubscribe_token TEXT NOT NULL,
    notify_incidents INTEGER DEFAULT 1,
    notify_maintenance INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
    UNIQUE(status_page_id, email)
);

-- Subscriber component preferences (which components to watch)
CREATE TABLE IF NOT EXISTS subscriber_components (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    UNIQUE(subscriber_id, component_id)
);

-- Component uptime metrics (daily aggregates)
CREATE TABLE IF NOT EXISTS component_metrics (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    date TEXT NOT NULL,
    uptime_percentage REAL DEFAULT 100.0,
    total_incidents INTEGER DEFAULT 0,
    total_downtime_minutes INTEGER DEFAULT 0,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    UNIQUE(component_id, date)
);

-- API keys for programmatic access
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_preview TEXT NOT NULL,
    permissions TEXT DEFAULT '["read"]',
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Session tokens for web auth
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit log for tracking changes
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    old_data TEXT,
    new_data TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

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

-- Notification queue for emails
CREATE TABLE IF NOT EXISTS notification_queue (
    id TEXT PRIMARY KEY,
    status_page_id TEXT NOT NULL,
    subscriber_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('incident', 'maintenance', 'component_status', 'verification')),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    metadata TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    scheduled_for TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_status_pages_org ON status_pages(organization_id);
CREATE INDEX IF NOT EXISTS idx_components_page ON components(status_page_id);
CREATE INDEX IF NOT EXISTS idx_components_group ON components(group_id);
CREATE INDEX IF NOT EXISTS idx_incidents_page ON incidents(status_page_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_page ON subscribers(status_page_id);
CREATE INDEX IF NOT EXISTS idx_component_metrics_component ON component_metrics(component_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notification_queue_page ON notification_queue(status_page_id);

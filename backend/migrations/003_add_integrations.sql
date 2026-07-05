-- Migration 003: Add integrations and email templates
-- Run: npx wrangler d1 execute incidentcast-db --remote --file=./migrations/003_add_integrations.sql

-- Integrations table (Slack, Teams, etc.)
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'slack', 'teams', 'pagerduty', etc.
  webhook_url TEXT NOT NULL,
  channel TEXT, -- Optional channel name
  enabled INTEGER DEFAULT 1,
  settings TEXT, -- JSON for additional settings
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, type)
);

-- Email templates table
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  template_type TEXT NOT NULL, -- 'incident_created', 'incident_updated', etc.
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, template_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations(organization_id);
CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(organization_id, type);
CREATE INDEX IF NOT EXISTS idx_email_templates_org ON email_templates(organization_id);
CREATE INDEX IF NOT EXISTS idx_email_templates_type ON email_templates(organization_id, template_type);

-- Migration: Add playbooks and private status pages support

-- Playbooks/Runbooks table
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT DEFAULT 'manual', -- manual, auto_on_incident, auto_on_component_status
  trigger_conditions TEXT, -- JSON: conditions for auto-trigger
  steps TEXT NOT NULL, -- JSON array of steps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playbooks_org ON playbooks(organization_id);

-- Playbook usage tracking
CREATE TABLE IF NOT EXISTS playbook_executions (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
  executed_by TEXT NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'in_progress', -- in_progress, completed, cancelled
  started_at TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_playbook_executions_playbook ON playbook_executions(playbook_id);
CREATE INDEX IF NOT EXISTS idx_playbook_executions_incident ON playbook_executions(incident_id);

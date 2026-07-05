import { Hono } from 'hono';
import { Env, Organization } from '../types';
import { orgAuthMiddleware, adminMiddleware } from '../middleware';
import { generateId } from '../utils';

interface Playbook {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  trigger_type: 'manual' | 'auto_on_incident' | 'auto_on_component_status';
  trigger_conditions: string | null;
  steps: string; // JSON array
  created_at: string;
  updated_at: string;
}

interface PlaybookStep {
  id: string;
  order: number;
  title: string;
  description: string;
  type: 'action' | 'check' | 'notify' | 'wait' | 'decision';
  config?: Record<string, any>;
  required: boolean;
}

interface PlaybookExecution {
  id: string;
  playbook_id: string;
  incident_id: string | null;
  executed_by: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  started_at: string;
  completed_at: string | null;
  notes: string | null;
}

const playbooks = new Hono<{ Bindings: Env }>();

// Apply auth middleware
playbooks.use('*', orgAuthMiddleware);

// ============ Static Routes (must be before /:id) ============

// Get execution history
playbooks.get('/executions', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const limit = parseInt(c.req.query('limit') || '50');
  const status = c.req.query('status');

  try {
    let query = `
      SELECT pe.*, p.name as playbook_name, u.name as executed_by_name, i.title as incident_title
      FROM playbook_executions pe
      JOIN playbooks p ON p.id = pe.playbook_id
      LEFT JOIN users u ON u.id = pe.executed_by
      LEFT JOIN incidents i ON i.id = pe.incident_id
      WHERE p.organization_id = ?
    `;
    const params: unknown[] = [org.id];

    if (status) {
      query += ' AND pe.status = ?';
      params.push(status);
    }

    query += ' ORDER BY pe.started_at DESC LIMIT ?';
    params.push(limit);

    const results = await db.prepare(query).bind(...params).all();

    return c.json({ success: true, data: results.results });
  } catch (error) {
    console.error('Failed to fetch executions:', error);
    return c.json({ success: false, error: 'Failed to fetch executions' }, 500);
  }
});

// Update execution status
playbooks.patch('/executions/:executionId', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const executionId = c.req.param('executionId');
  const body = await c.req.json<{
    status?: 'in_progress' | 'completed' | 'cancelled';
    notes?: string;
  }>();

  try {
    // Verify execution belongs to org
    const execution = await db.prepare(`
      SELECT pe.* FROM playbook_executions pe
      JOIN playbooks p ON p.id = pe.playbook_id
      WHERE pe.id = ? AND p.organization_id = ?
    `).bind(executionId, org.id).first<PlaybookExecution>();

    if (!execution) {
      return c.json({ success: false, error: 'Execution not found' }, 404);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) {
      updates.push('status = ?');
      values.push(body.status);
      if (body.status === 'completed' || body.status === 'cancelled') {
        updates.push('completed_at = ?');
        values.push(new Date().toISOString());
      }
    }
    if (body.notes !== undefined) {
      updates.push('notes = ?');
      values.push(body.notes);
    }

    if (updates.length > 0) {
      values.push(executionId);
      await db.prepare(`
        UPDATE playbook_executions SET ${updates.join(', ')} WHERE id = ?
      `).bind(...values).run();
    }

    const updated = await db.prepare(`
      SELECT * FROM playbook_executions WHERE id = ?
    `).bind(executionId).first();

    return c.json({ success: true, data: updated });
  } catch (error) {
    console.error('Failed to update execution:', error);
    return c.json({ success: false, error: 'Failed to update execution' }, 500);
  }
});

// Get suggested playbook templates
playbooks.get('/templates/suggested', async (c) => {
  const templates = [
    {
      name: 'Website Down Response',
      description: 'Standard response procedure for website outages',
      trigger_type: 'manual',
      steps: [
        { id: '1', order: 1, title: 'Acknowledge Incident', description: 'Confirm the incident and assign an owner', type: 'action', required: true },
        { id: '2', order: 2, title: 'Check Server Status', description: 'Verify server health and resource usage', type: 'check', required: true },
        { id: '3', order: 3, title: 'Notify Team', description: 'Alert the on-call engineer via Slack/PagerDuty', type: 'notify', required: true },
        { id: '4', order: 4, title: 'Check Recent Deployments', description: 'Review recent code changes or deployments', type: 'check', required: false },
        { id: '5', order: 5, title: 'Restart Services', description: 'If needed, restart affected services', type: 'action', required: false },
        { id: '6', order: 6, title: 'Post Status Update', description: 'Communicate status to affected users', type: 'notify', required: true },
        { id: '7', order: 7, title: 'Monitor Recovery', description: 'Monitor systems for 15 minutes to confirm stability', type: 'wait', required: true },
        { id: '8', order: 8, title: 'Resolve Incident', description: 'Mark incident as resolved once confirmed stable', type: 'action', required: true }
      ]
    },
    {
      name: 'Database Performance Degradation',
      description: 'Response procedure for database slowdowns',
      trigger_type: 'manual',
      steps: [
        { id: '1', order: 1, title: 'Check Database Metrics', description: 'Review CPU, memory, and connection counts', type: 'check', required: true },
        { id: '2', order: 2, title: 'Identify Slow Queries', description: 'Check slow query logs and active queries', type: 'check', required: true },
        { id: '3', order: 3, title: 'Kill Long-Running Queries', description: 'Terminate queries running longer than threshold', type: 'action', required: false },
        { id: '4', order: 4, title: 'Scale Resources', description: 'Increase database resources if needed', type: 'action', required: false },
        { id: '5', order: 5, title: 'Notify Development Team', description: 'Alert devs about potential code issues', type: 'notify', required: true },
        { id: '6', order: 6, title: 'Update Status Page', description: 'Post update about performance issues', type: 'action', required: true }
      ]
    },
    {
      name: 'Security Incident Response',
      description: 'Procedure for handling security incidents',
      trigger_type: 'manual',
      steps: [
        { id: '1', order: 1, title: 'Assess Severity', description: 'Determine the scope and severity of the incident', type: 'check', required: true },
        { id: '2', order: 2, title: 'Isolate Affected Systems', description: 'Quarantine compromised systems immediately', type: 'action', required: true },
        { id: '3', order: 3, title: 'Notify Security Team', description: 'Escalate to security team and leadership', type: 'notify', required: true },
        { id: '4', order: 4, title: 'Preserve Evidence', description: 'Capture logs and system state for analysis', type: 'action', required: true },
        { id: '5', order: 5, title: 'Investigate Root Cause', description: 'Analyze how the breach occurred', type: 'check', required: true },
        { id: '6', order: 6, title: 'Remediate Vulnerability', description: 'Fix the security vulnerability', type: 'action', required: true },
        { id: '7', order: 7, title: 'Notify Affected Users', description: 'If required, communicate to affected parties', type: 'notify', required: false },
        { id: '8', order: 8, title: 'Document Incident', description: 'Complete post-incident documentation', type: 'action', required: true }
      ]
    },
    {
      name: 'API Rate Limit Exceeded',
      description: 'Handle API rate limiting issues',
      trigger_type: 'auto_on_component_status',
      trigger_conditions: { component_status: 'degraded_performance', component_name_contains: 'API' },
      steps: [
        { id: '1', order: 1, title: 'Identify High-Traffic Source', description: 'Find which clients are sending excessive requests', type: 'check', required: true },
        { id: '2', order: 2, title: 'Contact Customer', description: 'Reach out to customer about their usage', type: 'notify', required: false },
        { id: '3', order: 3, title: 'Temporarily Increase Limits', description: 'If legitimate, temporarily increase rate limits', type: 'action', required: false },
        { id: '4', order: 4, title: 'Scale API Infrastructure', description: 'Add more API instances if needed', type: 'action', required: false },
        { id: '5', order: 5, title: 'Update Status Page', description: 'Communicate API performance status', type: 'action', required: true }
      ]
    },
    {
      name: 'Scheduled Maintenance Checklist',
      description: 'Pre and post maintenance verification steps',
      trigger_type: 'manual',
      steps: [
        { id: '1', order: 1, title: 'Notify Users in Advance', description: 'Send maintenance notification 24h before', type: 'notify', required: true },
        { id: '2', order: 2, title: 'Backup Critical Data', description: 'Ensure all databases are backed up', type: 'action', required: true },
        { id: '3', order: 3, title: 'Update Status Page', description: 'Change status to Under Maintenance', type: 'action', required: true },
        { id: '4', order: 4, title: 'Perform Maintenance', description: 'Execute the planned maintenance tasks', type: 'action', required: true },
        { id: '5', order: 5, title: 'Run Health Checks', description: 'Verify all services are functioning', type: 'check', required: true },
        { id: '6', order: 6, title: 'Smoke Test Critical Flows', description: 'Test key user journeys', type: 'check', required: true },
        { id: '7', order: 7, title: 'Monitor for 30 Minutes', description: 'Watch metrics for any issues', type: 'wait', required: true },
        { id: '8', order: 8, title: 'Complete Maintenance', description: 'Mark maintenance as completed on status page', type: 'action', required: true }
      ]
    }
  ];

  return c.json({ success: true, data: templates });
});

// ============ Playbook CRUD ============

// List all playbooks
playbooks.get('/', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;

  try {
    const results = await db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM playbook_executions WHERE playbook_id = p.id) as execution_count,
        (SELECT MAX(started_at) FROM playbook_executions WHERE playbook_id = p.id) as last_executed
      FROM playbooks p 
      WHERE p.organization_id = ?
      ORDER BY p.updated_at DESC
    `).bind(org.id).all<Playbook & { execution_count: number; last_executed: string | null }>();

    return c.json({ 
      success: true, 
      data: results.results.map(p => ({
        ...p,
        steps: JSON.parse(p.steps),
        trigger_conditions: p.trigger_conditions ? JSON.parse(p.trigger_conditions) : null
      }))
    });
  } catch (error) {
    console.error('Failed to fetch playbooks:', error);
    return c.json({ success: false, error: 'Failed to fetch playbooks' }, 500);
  }
});

// Get single playbook
playbooks.get('/:id', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const playbookId = c.req.param('id');

  try {
    const playbook = await db.prepare(`
      SELECT * FROM playbooks WHERE id = ? AND organization_id = ?
    `).bind(playbookId, org.id).first<Playbook>();

    if (!playbook) {
      return c.json({ success: false, error: 'Playbook not found' }, 404);
    }

    // Get recent executions
    const executions = await db.prepare(`
      SELECT pe.*, u.name as executed_by_name, i.title as incident_title
      FROM playbook_executions pe
      LEFT JOIN users u ON u.id = pe.executed_by
      LEFT JOIN incidents i ON i.id = pe.incident_id
      WHERE pe.playbook_id = ?
      ORDER BY pe.started_at DESC
      LIMIT 10
    `).bind(playbookId).all();

    return c.json({ 
      success: true, 
      data: {
        ...playbook,
        steps: JSON.parse(playbook.steps),
        trigger_conditions: playbook.trigger_conditions ? JSON.parse(playbook.trigger_conditions) : null,
        recent_executions: executions.results
      }
    });
  } catch (error) {
    console.error('Failed to fetch playbook:', error);
    return c.json({ success: false, error: 'Failed to fetch playbook' }, 500);
  }
});

// Create playbook
playbooks.post('/', adminMiddleware, async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const body = await c.req.json<{
    name: string;
    description?: string;
    trigger_type?: 'manual' | 'auto_on_incident' | 'auto_on_component_status';
    trigger_conditions?: Record<string, any>;
    steps: PlaybookStep[];
  }>();

  const { name, description, trigger_type, trigger_conditions, steps } = body;

  if (!name || !steps || steps.length === 0) {
    return c.json({ success: false, error: 'Name and at least one step are required' }, 400);
  }

  try {
    const id = generateId();
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO playbooks (id, organization_id, name, description, trigger_type, trigger_conditions, steps, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      org.id,
      name,
      description || null,
      trigger_type || 'manual',
      trigger_conditions ? JSON.stringify(trigger_conditions) : null,
      JSON.stringify(steps),
      now,
      now
    ).run();

    const playbook = await db.prepare(`
      SELECT * FROM playbooks WHERE id = ?
    `).bind(id).first<Playbook>();

    return c.json({ 
      success: true, 
      data: {
        ...playbook,
        steps: JSON.parse(playbook!.steps),
        trigger_conditions: playbook!.trigger_conditions ? JSON.parse(playbook!.trigger_conditions) : null
      }
    }, 201);
  } catch (error) {
    console.error('Failed to create playbook:', error);
    return c.json({ success: false, error: 'Failed to create playbook' }, 500);
  }
});

// Update playbook
playbooks.put('/:id', adminMiddleware, async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const playbookId = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    description?: string;
    trigger_type?: 'manual' | 'auto_on_incident' | 'auto_on_component_status';
    trigger_conditions?: Record<string, any>;
    steps?: PlaybookStep[];
  }>();

  try {
    const existing = await db.prepare(`
      SELECT id FROM playbooks WHERE id = ? AND organization_id = ?
    `).bind(playbookId, org.id).first();

    if (!existing) {
      return c.json({ success: false, error: 'Playbook not found' }, 404);
    }

    const updates: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description || null);
    }
    if (body.trigger_type !== undefined) {
      updates.push('trigger_type = ?');
      values.push(body.trigger_type);
    }
    if (body.trigger_conditions !== undefined) {
      updates.push('trigger_conditions = ?');
      values.push(body.trigger_conditions ? JSON.stringify(body.trigger_conditions) : null);
    }
    if (body.steps !== undefined) {
      updates.push('steps = ?');
      values.push(JSON.stringify(body.steps));
    }

    values.push(playbookId);

    await db.prepare(`
      UPDATE playbooks SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    const playbook = await db.prepare(`
      SELECT * FROM playbooks WHERE id = ?
    `).bind(playbookId).first<Playbook>();

    return c.json({ 
      success: true, 
      data: {
        ...playbook,
        steps: JSON.parse(playbook!.steps),
        trigger_conditions: playbook!.trigger_conditions ? JSON.parse(playbook!.trigger_conditions) : null
      }
    });
  } catch (error) {
    console.error('Failed to update playbook:', error);
    return c.json({ success: false, error: 'Failed to update playbook' }, 500);
  }
});

// Delete playbook
playbooks.delete('/:id', adminMiddleware, async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const playbookId = c.req.param('id');

  try {
    const existing = await db.prepare(`
      SELECT id FROM playbooks WHERE id = ? AND organization_id = ?
    `).bind(playbookId, org.id).first();

    if (!existing) {
      return c.json({ success: false, error: 'Playbook not found' }, 404);
    }

    await db.prepare(`DELETE FROM playbooks WHERE id = ?`).bind(playbookId).run();

    return c.json({ success: true, message: 'Playbook deleted' });
  } catch (error) {
    console.error('Failed to delete playbook:', error);
    return c.json({ success: false, error: 'Failed to delete playbook' }, 500);
  }
});

// ============ Playbook Execution ============

// Start playbook execution
playbooks.post('/:id/execute', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const user = c.get('user');
  const playbookId = c.req.param('id');
  const body = await c.req.json<{ incident_id?: string; notes?: string }>();

  try {
    const playbook = await db.prepare(`
      SELECT * FROM playbooks WHERE id = ? AND organization_id = ?
    `).bind(playbookId, org.id).first<Playbook>();

    if (!playbook) {
      return c.json({ success: false, error: 'Playbook not found' }, 404);
    }

    const executionId = generateId();
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO playbook_executions (id, playbook_id, incident_id, executed_by, status, started_at, notes)
      VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
    `).bind(
      executionId,
      playbookId,
      body.incident_id || null,
      user.id,
      now,
      body.notes || null
    ).run();

    const execution = await db.prepare(`
      SELECT * FROM playbook_executions WHERE id = ?
    `).bind(executionId).first();

    return c.json({ 
      success: true, 
      data: {
        execution,
        playbook: {
          ...playbook,
          steps: JSON.parse(playbook.steps)
        }
      }
    }, 201);
  } catch (error) {
    console.error('Failed to start playbook execution:', error);
    return c.json({ success: false, error: 'Failed to start execution' }, 500);
  }
});

export default playbooks;

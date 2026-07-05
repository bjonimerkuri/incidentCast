import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Env } from '../types';
import { generateId, hashToken } from '../utils';
import { triggerWebhooks } from './webhooks';

const externalApi = new Hono<{ Bindings: Env }>();

// API Key validation middleware
const apiKeyAuth = async (c: any, next: () => Promise<void>) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'API key required' }, 401);
  }

  const apiKey = authHeader.substring(7);
  const keyHash = await hashToken(apiKey);

  const keyRecord = await c.env.DB.prepare(`
    SELECT ak.*, o.id as org_id, o.name as org_name, o.slug as org_slug
    FROM api_keys ak
    JOIN organizations o ON o.id = ak.organization_id
    WHERE ak.key_hash = ? AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))
  `).bind(keyHash).first();

  if (!keyRecord) {
    return c.json({ success: false, error: 'Invalid or expired API key' }, 401);
  }

  // Update last used
  await c.env.DB.prepare(`
    UPDATE api_keys SET last_used_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), keyRecord.id).run();

  c.set('apiKey', keyRecord);
  c.set('organization', {
    id: keyRecord.org_id,
    name: keyRecord.org_name,
    slug: keyRecord.org_slug
  });

  await next();
};

// Schemas
const updateComponentStatusSchema = z.object({
  status: z.enum(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance'])
});

const createIncidentSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1),
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  impact: z.enum(['none', 'minor', 'major', 'critical']).optional(),
  component_ids: z.array(z.string()).optional()
});

const updateIncidentSchema = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  message: z.string().min(1)
});

// ============ Component Status API ============

// Get all components
externalApi.get('/components', apiKeyAuth, async (c) => {
  const organization = c.get('organization');

  const components = await c.env.DB.prepare(`
    SELECT c.*, sp.name as status_page_name, sp.subdomain 
    FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE sp.organization_id = ?
    ORDER BY c.display_order ASC
  `).bind(organization.id).all();

  return c.json({
    success: true,
    data: components.results
  });
});

// Get single component
externalApi.get('/components/:id', apiKeyAuth, async (c) => {
  const organization = c.get('organization');
  const componentId = c.req.param('id');

  const component = await c.env.DB.prepare(`
    SELECT c.*, sp.name as status_page_name, sp.subdomain 
    FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, organization.id).first();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  return c.json({
    success: true,
    data: component
  });
});

// Update component status (main monitoring endpoint)
externalApi.patch('/components/:id/status', apiKeyAuth, zValidator('json', updateComponentStatusSchema), async (c) => {
  const organization = c.get('organization');
  const componentId = c.req.param('id');
  const { status } = c.req.valid('json');

  const component = await c.env.DB.prepare(`
    SELECT c.*, sp.organization_id 
    FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, organization.id).first<{ id: string; name: string; status: string; status_page_id: string }>();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  const oldStatus = component.status;
  const now = new Date().toISOString();

  // Update component status
  await c.env.DB.prepare(`
    UPDATE components SET status = ?, updated_at = ? WHERE id = ?
  `).bind(status, now, componentId).run();

  // Trigger webhooks if status changed
  if (oldStatus !== status) {
    await triggerWebhooks(c.env.DB, organization.id, 'component.status_changed', {
      component_id: componentId,
      component_name: component.name,
      old_status: oldStatus,
      new_status: status,
      timestamp: now
    });
  }

  return c.json({
    success: true,
    data: {
      id: componentId,
      name: component.name,
      old_status: oldStatus,
      new_status: status,
      updated_at: now
    }
  });
});

// Bulk update component statuses
externalApi.post('/components/bulk-status', apiKeyAuth, async (c) => {
  const organization = c.get('organization');
  const body = await c.req.json() as { updates: Array<{ id: string; status: string }> };

  if (!body.updates || !Array.isArray(body.updates)) {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  const results = [];
  const now = new Date().toISOString();

  for (const update of body.updates) {
    const component = await c.env.DB.prepare(`
      SELECT c.*, sp.organization_id 
      FROM components c
      JOIN status_pages sp ON sp.id = c.status_page_id
      WHERE c.id = ? AND sp.organization_id = ?
    `).bind(update.id, organization.id).first<{ id: string; name: string; status: string }>();

    if (component) {
      const oldStatus = component.status;
      await c.env.DB.prepare(`
        UPDATE components SET status = ?, updated_at = ? WHERE id = ?
      `).bind(update.status, now, update.id).run();

      if (oldStatus !== update.status) {
        await triggerWebhooks(c.env.DB, organization.id, 'component.status_changed', {
          component_id: update.id,
          component_name: component.name,
          old_status: oldStatus,
          new_status: update.status,
          timestamp: now
        });
      }

      results.push({ id: update.id, success: true, old_status: oldStatus, new_status: update.status });
    } else {
      results.push({ id: update.id, success: false, error: 'Not found' });
    }
  }

  return c.json({
    success: true,
    data: results
  });
});

// ============ Incidents API ============

// List incidents
externalApi.get('/incidents', apiKeyAuth, async (c) => {
  const organization = c.get('organization');
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '50');

  let query = `
    SELECT i.*, sp.name as status_page_name, sp.subdomain 
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE sp.organization_id = ?
  `;
  const params: (string | number)[] = [organization.id];

  if (status) {
    query += ' AND i.status = ?';
    params.push(status);
  }

  query += ' ORDER BY i.created_at DESC LIMIT ?';
  params.push(limit);

  const incidents = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({
    success: true,
    data: incidents.results
  });
});

// Create incident via API
externalApi.post('/incidents', apiKeyAuth, zValidator('json', createIncidentSchema), async (c) => {
  const organization = c.get('organization');
  const { title, message, status = 'investigating', impact = 'minor', component_ids } = c.req.valid('json');

  // Get the first status page for this org
  const statusPage = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE organization_id = ? LIMIT 1
  `).bind(organization.id).first<{ id: string }>();

  if (!statusPage) {
    return c.json({ success: false, error: 'No status page found' }, 404);
  }

  const incidentId = generateId();
  const now = new Date().toISOString();

  // Create incident
  await c.env.DB.prepare(`
    INSERT INTO incidents (id, status_page_id, title, status, impact, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(incidentId, statusPage.id, title, status, impact, now, now).run();

  // Create initial update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(generateId(), incidentId, status, message, now).run();

  // Link affected components
  if (component_ids && component_ids.length > 0) {
    for (const componentId of component_ids) {
      await c.env.DB.prepare(`
        INSERT OR IGNORE INTO incident_components (id, incident_id, component_id, status)
        VALUES (?, ?, ?, ?)
      `).bind(generateId(), incidentId, componentId, 'degraded_performance').run();
    }
  }

  // Trigger webhooks
  await triggerWebhooks(c.env.DB, organization.id, 'incident.created', {
    incident_id: incidentId,
    title,
    status,
    impact,
    message,
    component_ids: component_ids || [],
    timestamp: now
  });

  const incident = await c.env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();

  return c.json({
    success: true,
    data: incident
  }, 201);
});

// Update incident via API
externalApi.post('/incidents/:id/updates', apiKeyAuth, zValidator('json', updateIncidentSchema), async (c) => {
  const organization = c.get('organization');
  const incidentId = c.req.param('id');
  const { status, message } = c.req.valid('json');

  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.organization_id 
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, organization.id).first<{ id: string; title: string; status: string }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  const now = new Date().toISOString();
  const oldStatus = incident.status;

  // Create update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(generateId(), incidentId, status, message, now).run();

  // Update incident status
  const updateFields = ['status = ?', 'updated_at = ?'];
  const updateValues: (string | null)[] = [status, now];

  if (status === 'resolved') {
    updateFields.push('resolved_at = ?');
    updateValues.push(now);
  }

  updateValues.push(incidentId);

  await c.env.DB.prepare(`
    UPDATE incidents SET ${updateFields.join(', ')} WHERE id = ?
  `).bind(...updateValues).run();

  // Trigger webhooks
  const eventType = status === 'resolved' ? 'incident.resolved' : 'incident.updated';
  await triggerWebhooks(c.env.DB, organization.id, eventType, {
    incident_id: incidentId,
    title: incident.title,
    old_status: oldStatus,
    new_status: status,
    message,
    timestamp: now
  });

  const updated = await c.env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();

  return c.json({
    success: true,
    data: updated
  });
});

// Resolve incident quickly
externalApi.post('/incidents/:id/resolve', apiKeyAuth, async (c) => {
  const organization = c.get('organization');
  const incidentId = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { message?: string };

  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.organization_id 
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, organization.id).first<{ id: string; title: string; status: string }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  const now = new Date().toISOString();
  const message = body.message || 'This incident has been resolved.';

  // Create resolve update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, status, message, created_at)
    VALUES (?, ?, 'resolved', ?, ?)
  `).bind(generateId(), incidentId, message, now).run();

  // Update incident
  await c.env.DB.prepare(`
    UPDATE incidents SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?
  `).bind(now, now, incidentId).run();

  // Reset affected components to operational
  await c.env.DB.prepare(`
    UPDATE components SET status = 'operational', updated_at = ?
    WHERE id IN (SELECT component_id FROM incident_components WHERE incident_id = ?)
  `).bind(now, incidentId).run();

  // Trigger webhooks
  await triggerWebhooks(c.env.DB, organization.id, 'incident.resolved', {
    incident_id: incidentId,
    title: incident.title,
    message,
    timestamp: now
  });

  return c.json({
    success: true,
    data: { resolved: true, resolved_at: now }
  });
});

// ============ API Keys Management ============

// Create API key (requires admin in org context - this is a special endpoint)
externalApi.post('/keys', async (c) => {
  // This endpoint uses normal auth, not API key auth
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Authentication required' }, 401);
  }

  // Verify JWT... simplified for now
  // In production, use the full authMiddleware

  const body = await c.req.json() as { 
    name: string; 
    organization_id: string; 
    user_id: string;
    permissions?: string[];
    expires_in_days?: number;
  };

  const apiKeyId = generateId();
  const rawKey = `ic_${generateId()}${generateId()}`; // Generate a long random key
  const keyHash = await hashToken(rawKey);
  const keyPreview = rawKey.substring(0, 12) + '...' + rawKey.substring(rawKey.length - 4);
  const now = new Date().toISOString();

  let expiresAt = null;
  if (body.expires_in_days) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + body.expires_in_days);
    expiresAt = expDate.toISOString();
  }

  await c.env.DB.prepare(`
    INSERT INTO api_keys (id, organization_id, user_id, name, key_hash, key_preview, permissions, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    apiKeyId,
    body.organization_id,
    body.user_id,
    body.name,
    keyHash,
    keyPreview,
    JSON.stringify(body.permissions || ['read', 'write']),
    expiresAt,
    now
  ).run();

  return c.json({
    success: true,
    data: {
      id: apiKeyId,
      name: body.name,
      key: rawKey, // Only returned once!
      key_preview: keyPreview,
      expires_at: expiresAt,
      created_at: now
    },
    warning: 'Save this API key securely. It will not be shown again.'
  }, 201);
});

export default externalApi;

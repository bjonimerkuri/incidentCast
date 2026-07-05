import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Env, Incident, IncidentUpdate, Component } from '../types';
import { 
  createIncidentSchema, 
  updateIncidentSchema,
  addIncidentUpdateSchema,
  createMaintenanceSchema,
  updateMaintenanceSchema,
  paginationSchema
} from '../schemas';
import { generateId, sqliteBool } from '../utils';
import { orgAuthMiddleware, adminMiddleware } from '../middleware';
import { sendToIntegrations } from './integrations';
import { triggerWebhooks } from './webhooks';
import { queueNotification, processNotificationQueue } from '../services/notifications';

const incidents = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
incidents.use('*', orgAuthMiddleware);

// Helper to verify status page belongs to org
async function verifyStatusPage(c: any, pageId: string): Promise<boolean> {
  const org = c.get('organization');
  const page = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();
  return !!page;
}

// Helper: get custom template or return default
async function getEmailTemplate(
  db: D1Database,
  orgId: string,
  templateType: string
): Promise<{ subject: string; body_html: string; body_text?: string }> {
  const template = await db.prepare(
    'SELECT subject, body_html, body_text FROM email_templates WHERE organization_id = ? AND template_type = ?'
  ).bind(orgId, templateType).first<{ subject: string; body_html: string; body_text?: string }>();
  
  if (template) return template;
  
  // Defaults
  const defaults: Record<string, { subject: string; body_html: string }> = {
    'incident_created': {
      subject: '[{{company_name}}] New Incident: {{incident_title}}',
      body_html: `<h2>New Incident Reported</h2><p><strong>{{incident_title}}</strong></p><p>Status: <strong>{{status}}</strong></p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    },
    'incident_updated': {
      subject: '[{{company_name}}] Update: {{incident_title}}',
      body_html: `<h2>Incident Update</h2><p><strong>{{incident_title}}</strong></p><p>Status: <strong>{{status}}</strong></p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    },
    'incident_resolved': {
      subject: '[{{company_name}}] Resolved: {{incident_title}}',
      body_html: `<h2>Incident Resolved</h2><p><strong>{{incident_title}}</strong></p><p>This incident has been resolved.</p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    },
    'maintenance_scheduled': {
      subject: '[{{company_name}}] Scheduled Maintenance: {{maintenance_title}}',
      body_html: `<h2>Scheduled Maintenance</h2><p><strong>{{maintenance_title}}</strong></p><p>Scheduled for: <strong>{{date}}</strong></p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    },
    'maintenance_started': {
      subject: '[{{company_name}}] Maintenance Started: {{maintenance_title}}',
      body_html: `<h2>Maintenance In Progress</h2><p><strong>{{maintenance_title}}</strong></p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    },
    'maintenance_completed': {
      subject: '[{{company_name}}] Maintenance Completed: {{maintenance_title}}',
      body_html: `<h2>Maintenance Completed</h2><p><strong>{{maintenance_title}}</strong></p><p>The scheduled maintenance has been completed.</p><p>{{message}}</p><p><a href="{{status_page_url}}">View Status Page</a></p>`
    }
  };
  return defaults[templateType] || defaults['incident_updated'];
}

// Helper: replace template variables
function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// Helper: wrap HTML body in a styled email wrapper
function wrapEmailHtml(bodyHtml: string, companyName: string, statusPageUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">${companyName}</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Status Update</p>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    ${bodyHtml}
  </div>
  <p style="text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px;">
    You're receiving this because you subscribed to ${companyName} updates.<br>
    <a href="${statusPageUrl}" style="color: #6b7280;">View Status Page</a>
  </p>
</body>
</html>`;
}

// Send real email notifications to all verified subscribers
async function notifySubscribers(c: any, pageId: string, incident: Incident, update: IncidentUpdate) {
  const db = c.env.DB as D1Database;
  const org = c.get('organization');
  
  try {
    // Get status page info
    const statusPage = await db.prepare(
      'SELECT name, subdomain, custom_domain FROM status_pages WHERE id = ?'
    ).bind(pageId).first<{ name: string; subdomain: string; custom_domain?: string }>();
    
    if (!statusPage) return;
    
    const statusPageUrl = statusPage.custom_domain
      ? `https://${statusPage.custom_domain}`
      : `https://${statusPage.subdomain}.incidentcast.com`;
    
    // Determine template type
    let templateType: string;
    if (incident.is_scheduled) {
      if (update.status === 'completed') templateType = 'maintenance_completed';
      else if (update.status === 'in_progress') templateType = 'maintenance_started';
      else templateType = 'maintenance_scheduled';
    } else {
      if (update.status === 'resolved') templateType = 'incident_resolved';
      else if (incident.status === update.status && !incident.resolved_at) templateType = 'incident_created';
      else templateType = 'incident_updated';
    }
    
    // Get custom or default template
    const template = await getEmailTemplate(db, org.id, templateType);
    
    // Build template variables
    const vars: Record<string, string> = {
      company_name: statusPage.name,
      incident_title: incident.title,
      maintenance_title: incident.title,
      status: update.status.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      message: update.message,
      status_page_url: statusPageUrl,
      date: new Date().toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      })
    };
    
    const subject = renderTemplate(template.subject, vars);
    const bodyHtml = wrapEmailHtml(renderTemplate(template.body_html, vars), statusPage.name, statusPageUrl);
    
    // Get subscribers
    const notifyCol = incident.is_scheduled ? 'notify_maintenance' : 'notify_incidents';
    const subscribers = await db.prepare(`
      SELECT id, email FROM subscribers 
      WHERE status_page_id = ? AND is_verified = 1 AND ${notifyCol} = 1
    `).bind(pageId).all<{ id: string; email: string }>();
    
    // Queue notifications for each subscriber
    for (const subscriber of subscribers.results) {
      await queueNotification(db, {
        status_page_id: pageId,
        subscriber_id: subscriber.id,
        type: 'email',
        subject,
        body: bodyHtml,
        metadata: {
          template_type: templateType,
          incident_id: incident.id,
          status: update.status
        }
      });
    }
    
    console.log(`Queued ${subscribers.results.length} email notifications for ${templateType}: ${incident.title}`);
    
    // Process queue immediately (no cron worker available)
    if (subscribers.results.length > 0) {
      try {
        const result = await processNotificationQueue(c.env);
        console.log(`Processed notifications: ${result.processed} sent, ${result.failed} failed`);
      } catch (queueError) {
        console.error('Queue processing error (emails still queued for retry):', queueError);
      }
    }
  } catch (error) {
    console.error('Failed to notify subscribers:', error);
  }
}

// ============ Incidents ============

// List incidents for a status page
incidents.get('/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const { page, limit } = paginationSchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit')
  });
  const status = c.req.query('status');
  const type = c.req.query('type'); // 'incident' or 'maintenance'

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  let whereClause = 'WHERE i.status_page_id = ?';
  const params: unknown[] = [pageId];

  if (status) {
    whereClause += ' AND i.status = ?';
    params.push(status);
  }

  if (type === 'incident') {
    whereClause += ' AND i.is_scheduled = 0';
  } else if (type === 'maintenance') {
    whereClause += ' AND i.is_scheduled = 1';
  }

  // Get total count
  const countResult = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM incidents i ${whereClause}
  `).bind(...params).first<{ count: number }>();

  const total = countResult?.count || 0;
  const offset = (page - 1) * limit;

  // Get incidents
  const incidentsResult = await c.env.DB.prepare(`
    SELECT i.* FROM incidents i 
    ${whereClause}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all<Incident>();

  // Get updates and affected components for each incident
  const incidentIds = incidentsResult.results.map(i => i.id);
  let updates: IncidentUpdate[] = [];
  let affectedComponents: { incident_id: string; component_id: string; status: string; name: string }[] = [];

  if (incidentIds.length > 0) {
    const updatesResult = await c.env.DB.prepare(`
      SELECT * FROM incident_updates 
      WHERE incident_id IN (${incidentIds.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `).bind(...incidentIds).all<IncidentUpdate>();
    updates = updatesResult.results;

    const componentsResult = await c.env.DB.prepare(`
      SELECT ic.*, c.name FROM incident_components ic
      JOIN components c ON c.id = ic.component_id
      WHERE ic.incident_id IN (${incidentIds.map(() => '?').join(',')})
    `).bind(...incidentIds).all();
    affectedComponents = componentsResult.results as typeof affectedComponents;
  }

  const data = incidentsResult.results.map(incident => ({
    ...incident,
    is_scheduled: sqliteBool(incident.is_scheduled),
    updates: updates.filter(u => u.incident_id === incident.id),
    affected_components: affectedComponents
      .filter(ac => ac.incident_id === incident.id)
      .map(ac => ({ id: ac.component_id, name: ac.name, status: ac.status }))
  }));

  return c.json({
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Create incident
incidents.post('/pages/:pageId', adminMiddleware, zValidator('json', createIncidentSchema), async (c) => {
  const pageId = c.req.param('pageId');
  const user = c.get('user');
  const input = c.req.valid('json');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const incidentId = generateId();
  const updateId = generateId();
  const now = new Date().toISOString();

  // Create incident
  await c.env.DB.prepare(`
    INSERT INTO incidents (id, status_page_id, title, status, impact, is_scheduled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(incidentId, pageId, input.title, input.status, input.impact, now, now).run();

  // Create initial update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, user_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(updateId, incidentId, user.id, input.status, input.message, now).run();

  // Link affected components
  if (input.component_ids && input.component_ids.length > 0) {
    const componentStatus = input.component_status || 'degraded_performance';
    
    for (const componentId of input.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO incident_components (id, incident_id, component_id, status)
        VALUES (?, ?, ?, ?)
      `).bind(generateId(), incidentId, componentId, componentStatus).run();

      // Update component status
      await c.env.DB.prepare(
        'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
      ).bind(componentStatus, now, componentId).run();
    }
  }

  // Get the created incident with updates
  const incident = await c.env.DB.prepare(
    'SELECT * FROM incidents WHERE id = ?'
  ).bind(incidentId).first<Incident>();

  const incidentUpdate = await c.env.DB.prepare(
    'SELECT * FROM incident_updates WHERE id = ?'
  ).bind(updateId).first<IncidentUpdate>();

  // Notify subscribers
  if (input.notify_subscribers) {
    await notifySubscribers(c, pageId, incident!, incidentUpdate!);
  }

  // Send to Slack/Teams integrations
  const org = c.get('organization');
  await sendToIntegrations(c.env.DB, org.id, {
    type: 'incident_created',
    title: incident!.title,
    status: incident!.status,
    message: input.message,
    impact: incident!.impact
  });

  // Trigger custom webhooks
  await triggerWebhooks(c.env.DB, org.id, 'incident.created', {
    incident_id: incident!.id,
    title: incident!.title,
    status: incident!.status,
    impact: incident!.impact,
    message: input.message
  });

  return c.json({
    success: true,
    data: {
      ...incident,
      is_scheduled: false,
      updates: [incidentUpdate],
      affected_components: input.component_ids || []
    }
  }, 201);
});

// Get single incident
incidents.get('/:incidentId', async (c) => {
  const incidentId = c.req.param('incidentId');
  const org = c.get('organization');

  const incident = await c.env.DB.prepare(`
    SELECT i.* FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, org.id).first<Incident>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  // Get updates
  const updates = await c.env.DB.prepare(`
    SELECT iu.*, u.name as user_name FROM incident_updates iu
    LEFT JOIN users u ON u.id = iu.user_id
    WHERE iu.incident_id = ?
    ORDER BY iu.created_at DESC
  `).bind(incidentId).all<IncidentUpdate & { user_name: string }>();

  // Get affected components
  const components = await c.env.DB.prepare(`
    SELECT ic.*, c.name FROM incident_components ic
    JOIN components c ON c.id = ic.component_id
    WHERE ic.incident_id = ?
  `).bind(incidentId).all();

  return c.json({
    success: true,
    data: {
      ...incident,
      is_scheduled: sqliteBool(incident.is_scheduled),
      updates: updates.results,
      affected_components: components.results
    }
  });
});

// Update incident (add update)
incidents.post('/:incidentId/updates', adminMiddleware, zValidator('json', addIncidentUpdateSchema), async (c) => {
  const incidentId = c.req.param('incidentId');
  const org = c.get('organization');
  const user = c.get('user');
  const input = c.req.valid('json');

  // Verify incident belongs to org
  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.id as page_id FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, org.id).first<Incident & { page_id: string }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  const updateId = generateId();
  const now = new Date().toISOString();

  // Create update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, user_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(updateId, incidentId, user.id, input.status, input.message, now).run();

  // Update incident status
  const updateFields: string[] = ['status = ?', 'updated_at = ?'];
  const updateValues: unknown[] = [input.status, now];

  if (input.status === 'resolved') {
    updateFields.push('resolved_at = ?');
    updateValues.push(now);
  }

  updateValues.push(incidentId);
  await c.env.DB.prepare(`
    UPDATE incidents SET ${updateFields.join(', ')} WHERE id = ?
  `).bind(...updateValues).run();

  // Update affected component statuses
  if (input.component_status) {
    await c.env.DB.prepare(
      'UPDATE incident_components SET status = ? WHERE incident_id = ?'
    ).bind(input.component_status, incidentId).run();

    // If resolved, set components back to operational
    if (input.status === 'resolved') {
      const affectedComponents = await c.env.DB.prepare(
        'SELECT component_id FROM incident_components WHERE incident_id = ?'
      ).bind(incidentId).all<{ component_id: string }>();

      for (const { component_id } of affectedComponents.results) {
        await c.env.DB.prepare(
          'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
        ).bind('operational', now, component_id).run();
      }
    } else {
      const affectedComponents = await c.env.DB.prepare(
        'SELECT component_id FROM incident_components WHERE incident_id = ?'
      ).bind(incidentId).all<{ component_id: string }>();

      for (const { component_id } of affectedComponents.results) {
        await c.env.DB.prepare(
          'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
        ).bind(input.component_status, now, component_id).run();
      }
    }
  }

  const incidentUpdate = await c.env.DB.prepare(
    'SELECT * FROM incident_updates WHERE id = ?'
  ).bind(updateId).first<IncidentUpdate>();

  // Notify subscribers
  if (input.notify_subscribers) {
    const updatedIncident = await c.env.DB.prepare(
      'SELECT * FROM incidents WHERE id = ?'
    ).bind(incidentId).first<Incident>();
    await notifySubscribers(c, incident.page_id, updatedIncident!, incidentUpdate!);
  }

  // Send to Slack/Teams integrations
  const eventType = input.status === 'resolved' ? 'incident_resolved' : 'incident_updated';
  await sendToIntegrations(c.env.DB, org.id, {
    type: eventType,
    title: incident.title,
    status: input.status,
    message: input.message,
    impact: incident.impact
  });

  // Trigger custom webhooks
  const webhookEvent = input.status === 'resolved' ? 'incident.resolved' : 'incident.updated';
  await triggerWebhooks(c.env.DB, org.id, webhookEvent, {
    incident_id: incident.id,
    title: incident.title,
    status: input.status,
    impact: incident.impact,
    message: input.message
  });

  return c.json({
    success: true,
    data: incidentUpdate
  }, 201);
});

// Update incident metadata
incidents.patch('/:incidentId', adminMiddleware, zValidator('json', updateIncidentSchema), async (c) => {
  const incidentId = c.req.param('incidentId');
  const org = c.get('organization');
  const updates = c.req.valid('json');

  // Verify incident belongs to org
  const incident = await c.env.DB.prepare(`
    SELECT i.id FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, org.id).first();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.impact !== undefined) {
    fields.push('impact = ?');
    values.push(updates.impact);
  }
  if (updates.message !== undefined) {
    fields.push('message = ?');
    values.push(updates.message);
  }
  if (updates.scheduled_for !== undefined) {
    fields.push('scheduled_for = ?');
    values.push(updates.scheduled_for);
  }
  if (updates.scheduled_until !== undefined) {
    fields.push('scheduled_until = ?');
    values.push(updates.scheduled_until);
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(incidentId);

  await c.env.DB.prepare(`
    UPDATE incidents SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  // Handle component updates if provided
  if (updates.component_ids !== undefined) {
    // Delete existing affected components
    await c.env.DB.prepare(
      'DELETE FROM incident_affected_components WHERE incident_id = ?'
    ).bind(incidentId).run();

    // Insert new affected components
    for (const componentId of updates.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO incident_affected_components (incident_id, component_id)
        VALUES (?, ?)
      `).bind(incidentId, componentId).run();
    }
  }

  const updated = await c.env.DB.prepare(
    'SELECT * FROM incidents WHERE id = ?'
  ).bind(incidentId).first<Incident>();

  return c.json({
    success: true,
    data: {
      ...updated,
      is_scheduled: sqliteBool(updated!.is_scheduled)
    }
  });
});

// Delete incident
incidents.delete('/:incidentId', adminMiddleware, async (c) => {
  const incidentId = c.req.param('incidentId');
  const org = c.get('organization');

  // Verify incident belongs to org
  const incident = await c.env.DB.prepare(`
    SELECT i.id FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ?
  `).bind(incidentId, org.id).first();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM incidents WHERE id = ?').bind(incidentId).run();

  return c.json({
    success: true,
    message: 'Incident deleted successfully'
  });
});

// ============ Scheduled Maintenance ============

// Create scheduled maintenance
incidents.post('/pages/:pageId/maintenance', adminMiddleware, zValidator('json', createMaintenanceSchema), async (c) => {
  const pageId = c.req.param('pageId');
  const user = c.get('user');
  const input = c.req.valid('json');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const maintenanceId = generateId();
  const updateId = generateId();
  const now = new Date().toISOString();

  // Create maintenance
  await c.env.DB.prepare(`
    INSERT INTO incidents (id, status_page_id, title, status, impact, is_scheduled, scheduled_for, scheduled_until, created_at, updated_at)
    VALUES (?, ?, ?, 'scheduled', 'none', 1, ?, ?, ?, ?)
  `).bind(maintenanceId, pageId, input.title, input.scheduled_for, input.scheduled_until, now, now).run();

  // Create initial update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, user_id, status, message, created_at)
    VALUES (?, ?, ?, 'scheduled', ?, ?)
  `).bind(updateId, maintenanceId, user.id, input.message, now).run();

  // Link affected components
  if (input.component_ids && input.component_ids.length > 0) {
    for (const componentId of input.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO incident_components (id, incident_id, component_id, status)
        VALUES (?, ?, ?, 'under_maintenance')
      `).bind(generateId(), maintenanceId, componentId).run();
    }
  }

  // Get the created maintenance with updates
  const maintenance = await c.env.DB.prepare(
    'SELECT * FROM incidents WHERE id = ?'
  ).bind(maintenanceId).first<Incident>();

  const maintenanceUpdate = await c.env.DB.prepare(
    'SELECT * FROM incident_updates WHERE id = ?'
  ).bind(updateId).first<IncidentUpdate>();

  // Notify subscribers
  if (input.notify_subscribers) {
    await notifySubscribers(c, pageId, maintenance!, maintenanceUpdate!);
  }

  // Send to Slack/Teams integrations
  const org = c.get('organization');
  await sendToIntegrations(c.env.DB, org.id, {
    type: 'maintenance_scheduled',
    title: maintenance!.title,
    status: 'scheduled',
    message: input.message
  });

  // Trigger custom webhooks
  await triggerWebhooks(c.env.DB, org.id, 'maintenance.scheduled', {
    maintenance_id: maintenance!.id,
    title: maintenance!.title,
    status: 'scheduled',
    message: input.message
  });

  return c.json({
    success: true,
    data: {
      ...maintenance,
      is_scheduled: true,
      updates: [maintenanceUpdate],
      affected_components: input.component_ids || []
    }
  }, 201);
});

// Update maintenance status
incidents.post('/:maintenanceId/maintenance-updates', adminMiddleware, async (c) => {
  const maintenanceId = c.req.param('maintenanceId');
  const org = c.get('organization');
  const user = c.get('user');
  const { status, message, notify_subscribers } = await c.req.json<{
    status: string;
    message: string;
    notify_subscribers?: boolean;
  }>();

  const validStatuses = ['scheduled', 'in_progress', 'verifying', 'completed'];
  if (!validStatuses.includes(status)) {
    return c.json({ success: false, error: 'Invalid maintenance status' }, 400);
  }

  // Verify maintenance belongs to org
  const maintenance = await c.env.DB.prepare(`
    SELECT i.*, sp.id as page_id FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND sp.organization_id = ? AND i.is_scheduled = 1
  `).bind(maintenanceId, org.id).first<Incident & { page_id: string }>();

  if (!maintenance) {
    return c.json({ success: false, error: 'Maintenance not found' }, 404);
  }

  const updateId = generateId();
  const now = new Date().toISOString();

  // Create update
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, user_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(updateId, maintenanceId, user.id, status, message, now).run();

  // Update maintenance status
  const updateFields: string[] = ['status = ?', 'updated_at = ?'];
  const updateValues: unknown[] = [status, now];

  if (status === 'completed') {
    updateFields.push('resolved_at = ?');
    updateValues.push(now);
  }

  updateValues.push(maintenanceId);
  await c.env.DB.prepare(`
    UPDATE incidents SET ${updateFields.join(', ')} WHERE id = ?
  `).bind(...updateValues).run();

  // Update component statuses
  const affectedComponents = await c.env.DB.prepare(
    'SELECT component_id FROM incident_components WHERE incident_id = ?'
  ).bind(maintenanceId).all<{ component_id: string }>();

  if (status === 'in_progress') {
    // Set components to under maintenance
    for (const { component_id } of affectedComponents.results) {
      await c.env.DB.prepare(
        'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('under_maintenance', now, component_id).run();
    }
  } else if (status === 'completed') {
    // Set components back to operational
    for (const { component_id } of affectedComponents.results) {
      await c.env.DB.prepare(
        'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('operational', now, component_id).run();
    }
  }

  const maintenanceUpdate = await c.env.DB.prepare(
    'SELECT * FROM incident_updates WHERE id = ?'
  ).bind(updateId).first<IncidentUpdate>();

  // Notify subscribers
  if (notify_subscribers) {
    const updatedMaintenance = await c.env.DB.prepare(
      'SELECT * FROM incidents WHERE id = ?'
    ).bind(maintenanceId).first<Incident>();
    await notifySubscribers(c, maintenance.page_id, updatedMaintenance!, maintenanceUpdate!);
  }

  // Send to Slack/Teams integrations
  const maintenanceEventType = status === 'in_progress' ? 'maintenance_started' : 
                               status === 'completed' ? 'maintenance_completed' : 'maintenance_scheduled';
  await sendToIntegrations(c.env.DB, org.id, {
    type: maintenanceEventType,
    title: maintenance.title,
    status: status,
    message: message
  });

  // Trigger custom webhooks
  const webhookMaintEvent = status === 'in_progress' ? 'maintenance.started' : 
                            status === 'completed' ? 'maintenance.completed' : 'maintenance.scheduled';
  await triggerWebhooks(c.env.DB, org.id, webhookMaintEvent, {
    maintenance_id: maintenance.id,
    title: maintenance.title,
    status: status,
    message: message
  });

  return c.json({
    success: true,
    data: maintenanceUpdate
  }, 201);
});

export default incidents;

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Env } from '../types';
import { generateId, hashToken } from '../utils';
import { orgAuthMiddleware, adminMiddleware } from '../middleware';

const webhooks = new Hono<{ Bindings: Env }>();

// All routes require org auth
webhooks.use('*', orgAuthMiddleware);

// Webhook schemas
const createWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum([
    'incident.created',
    'incident.updated', 
    'incident.resolved',
    'component.status_changed',
    'maintenance.scheduled',
    'maintenance.started',
    'maintenance.completed'
  ])).optional()
});

const updateWebhookSchema = createWebhookSchema.partial().extend({
  is_active: z.boolean().optional()
});

// List webhooks for organization
webhooks.get('/', async (c) => {
  const organization = c.get('organization');

  const result = await c.env.DB.prepare(`
    SELECT * FROM webhooks 
    WHERE organization_id = ?
    ORDER BY created_at DESC
  `).bind(organization.id).all();

  return c.json({
    success: true,
    data: result.results
  });
});

// Create webhook
webhooks.post('/', adminMiddleware, zValidator('json', createWebhookSchema), async (c) => {
  const organization = c.get('organization');
  const { name, url, secret, events } = c.req.valid('json');

  const webhookId = generateId();
  const now = new Date().toISOString();
  const eventsList = events || ['incident.created', 'incident.updated', 'incident.resolved'];

  await c.env.DB.prepare(`
    INSERT INTO webhooks (id, organization_id, name, url, secret, events, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    webhookId,
    organization.id,
    name,
    url,
    secret || null,
    JSON.stringify(eventsList),
    now,
    now
  ).run();

  const webhook = await c.env.DB.prepare(
    'SELECT * FROM webhooks WHERE id = ?'
  ).bind(webhookId).first();

  return c.json({
    success: true,
    data: webhook
  }, 201);
});

// Get single webhook
webhooks.get('/:id', async (c) => {
  const organization = c.get('organization');
  const webhookId = c.req.param('id');

  const webhook = await c.env.DB.prepare(`
    SELECT * FROM webhooks WHERE id = ? AND organization_id = ?
  `).bind(webhookId, organization.id).first();

  if (!webhook) {
    return c.json({ success: false, error: 'Webhook not found' }, 404);
  }

  // Get recent deliveries
  const deliveries = await c.env.DB.prepare(`
    SELECT * FROM webhook_deliveries 
    WHERE webhook_id = ?
    ORDER BY delivered_at DESC
    LIMIT 20
  `).bind(webhookId).all();

  return c.json({
    success: true,
    data: {
      ...webhook,
      deliveries: deliveries.results
    }
  });
});

// Update webhook
webhooks.patch('/:id', adminMiddleware, zValidator('json', updateWebhookSchema), async (c) => {
  const organization = c.get('organization');
  const webhookId = c.req.param('id');
  const updates = c.req.valid('json');

  const existing = await c.env.DB.prepare(`
    SELECT * FROM webhooks WHERE id = ? AND organization_id = ?
  `).bind(webhookId, organization.id).first();

  if (!existing) {
    return c.json({ success: false, error: 'Webhook not found' }, 404);
  }

  const now = new Date().toISOString();
  const fields: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.url !== undefined) {
    fields.push('url = ?');
    values.push(updates.url);
  }
  if (updates.secret !== undefined) {
    fields.push('secret = ?');
    values.push(updates.secret);
  }
  if (updates.events !== undefined) {
    fields.push('events = ?');
    values.push(JSON.stringify(updates.events));
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }

  values.push(webhookId);

  await c.env.DB.prepare(`
    UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const webhook = await c.env.DB.prepare(
    'SELECT * FROM webhooks WHERE id = ?'
  ).bind(webhookId).first();

  return c.json({
    success: true,
    data: webhook
  });
});

// Delete webhook
webhooks.delete('/:id', adminMiddleware, async (c) => {
  const organization = c.get('organization');
  const webhookId = c.req.param('id');

  const existing = await c.env.DB.prepare(`
    SELECT * FROM webhooks WHERE id = ? AND organization_id = ?
  `).bind(webhookId, organization.id).first();

  if (!existing) {
    return c.json({ success: false, error: 'Webhook not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(webhookId).run();

  return c.json({ success: true });
});

// Test webhook
webhooks.post('/:id/test', adminMiddleware, async (c) => {
  const organization = c.get('organization');
  const webhookId = c.req.param('id');

  const webhook = await c.env.DB.prepare(`
    SELECT * FROM webhooks WHERE id = ? AND organization_id = ?
  `).bind(webhookId, organization.id).first<{
    id: string;
    url: string;
    secret: string | null;
  }>();

  if (!webhook) {
    return c.json({ success: false, error: 'Webhook not found' }, 404);
  }

  const testPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from IncidentCast',
      organization: organization.name
    }
  };

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'IncidentCast-Webhook/1.0'
    };

    // Add signature if secret is set
    if (webhook.secret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhook.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(JSON.stringify(testPayload))
      );
      const signatureHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      headers['X-IncidentCast-Signature'] = `sha256=${signatureHex}`;
    }

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload)
    });

    // Log delivery
    await c.env.DB.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, response_status, response_body, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      webhookId,
      'test',
      JSON.stringify(testPayload),
      response.status,
      (await response.text()).substring(0, 1000),
      new Date().toISOString()
    ).run();

    // Update webhook last triggered
    await c.env.DB.prepare(`
      UPDATE webhooks SET last_triggered_at = ?, last_status_code = ?, failure_count = ? WHERE id = ?
    `).bind(new Date().toISOString(), response.status, response.ok ? 0 : 1, webhookId).run();

    return c.json({
      success: true,
      data: {
        status: response.status,
        ok: response.ok
      }
    });
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to deliver webhook',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

export default webhooks;

// Helper function to trigger webhooks (used by other routes)
export async function triggerWebhooks(
  db: D1Database,
  organizationId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const webhooks = await db.prepare(`
    SELECT * FROM webhooks 
    WHERE organization_id = ? AND is_active = 1
  `).bind(organizationId).all<{
    id: string;
    url: string;
    secret: string | null;
    events: string;
  }>();

  for (const webhook of webhooks.results) {
    const events = JSON.parse(webhook.events) as string[];
    if (!events.includes(eventType)) continue;

    const webhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'IncidentCast-Webhook/1.0'
      };

      if (webhook.secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(webhook.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signature = await crypto.subtle.sign(
          'HMAC',
          key,
          encoder.encode(JSON.stringify(webhookPayload))
        );
        const signatureHex = Array.from(new Uint8Array(signature))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        headers['X-IncidentCast-Signature'] = `sha256=${signatureHex}`;
      }

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(webhookPayload)
      });

      // Log delivery
      await db.prepare(`
        INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, response_status, delivered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        generateId(),
        webhook.id,
        eventType,
        JSON.stringify(webhookPayload),
        response.status,
        new Date().toISOString()
      ).run();

      // Update webhook status
      await db.prepare(`
        UPDATE webhooks SET last_triggered_at = ?, last_status_code = ?, failure_count = ? WHERE id = ?
      `).bind(new Date().toISOString(), response.status, response.ok ? 0 : (webhook as any).failure_count + 1, webhook.id).run();

    } catch (error) {
      console.error('Webhook delivery failed:', error);
    }
  }
}

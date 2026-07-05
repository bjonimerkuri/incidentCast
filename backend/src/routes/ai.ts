// AI routes for IncidentCast
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Env } from '../types';
import { authMiddleware } from '../middleware';
import {
  generateIncidentSummary,
  suggestIncidentResponse,
  categorizeIncident,
  generatePostMortem,
  improveDraft
} from '../services/ai';

const ai = new Hono<{ Bindings: Env }>();

// All AI routes require authentication
ai.use('*', authMiddleware);

// Generate incident summary
ai.post('/incidents/:id/summary', async (c) => {
  const incidentId = c.req.param('id');
  const user = c.get('user');

  // Get incident with updates
  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.organization_id
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ?
  `).bind(incidentId).first<{
    id: string;
    title: string;
    status: string;
    impact: string;
    status_page_id: string;
    organization_id: string;
  }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  // Get updates
  const updates = await c.env.DB.prepare(`
    SELECT status, message, created_at FROM incident_updates 
    WHERE incident_id = ? ORDER BY created_at ASC
  `).bind(incidentId).all<{ status: string; message: string; created_at: string }>();

  // Get affected components
  const components = await c.env.DB.prepare(`
    SELECT c.name FROM components c
    JOIN incident_components ic ON ic.component_id = c.id
    WHERE ic.incident_id = ?
  `).bind(incidentId).all<{ name: string }>();

  try {
    const summary = await generateIncidentSummary(c.env, {
      title: incident.title,
      status: incident.status,
      impact: incident.impact,
      updates: updates.results,
      components: components.results.map(c => c.name)
    });

    return c.json({
      success: true,
      data: { summary }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI service unavailable';
    return c.json({ success: false, error: message }, 500);
  }
});

// Suggest incident update response
const suggestResponseSchema = z.object({
  targetStatus: z.enum(['investigating', 'identified', 'monitoring', 'resolved'])
});

ai.post('/incidents/:id/suggest-response', zValidator('json', suggestResponseSchema), async (c) => {
  const incidentId = c.req.param('id');
  const { targetStatus } = c.req.valid('json');

  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.organization_id
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ?
  `).bind(incidentId).first<{
    id: string;
    title: string;
    status: string;
    impact: string;
    organization_id: string;
  }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found' }, 404);
  }

  // Get previous updates
  const updates = await c.env.DB.prepare(`
    SELECT message FROM incident_updates 
    WHERE incident_id = ? ORDER BY created_at DESC LIMIT 3
  `).bind(incidentId).all<{ message: string }>();

  try {
    const suggestion = await suggestIncidentResponse(c.env, {
      title: incident.title,
      currentStatus: incident.status,
      impact: incident.impact,
      previousUpdates: updates.results.map(u => u.message),
      targetStatus
    });

    return c.json({
      success: true,
      data: { suggestion }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI service unavailable';
    return c.json({ success: false, error: message }, 500);
  }
});

// Categorize incident from description
const categorizeSchema = z.object({
  description: z.string().min(10),
  statusPageId: z.string()
});

ai.post('/categorize-incident', zValidator('json', categorizeSchema), async (c) => {
  const { description, statusPageId } = c.req.valid('json');

  // Get available components
  const components = await c.env.DB.prepare(`
    SELECT name FROM components WHERE status_page_id = ?
  `).bind(statusPageId).all<{ name: string }>();

  try {
    const categorization = await categorizeIncident(
      c.env,
      description,
      components.results.map(c => c.name)
    );

    return c.json({
      success: true,
      data: categorization
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI service unavailable';
    return c.json({ success: false, error: message }, 500);
  }
});

// Generate post-mortem
ai.post('/incidents/:id/post-mortem', async (c) => {
  const incidentId = c.req.param('id');

  const incident = await c.env.DB.prepare(`
    SELECT i.*, sp.organization_id
    FROM incidents i
    JOIN status_pages sp ON sp.id = i.status_page_id
    WHERE i.id = ? AND i.status = 'resolved'
  `).bind(incidentId).first<{
    id: string;
    title: string;
    impact: string;
    created_at: string;
    resolved_at: string;
    organization_id: string;
  }>();

  if (!incident) {
    return c.json({ success: false, error: 'Incident not found or not resolved' }, 404);
  }

  // Get updates
  const updates = await c.env.DB.prepare(`
    SELECT status, message, created_at FROM incident_updates 
    WHERE incident_id = ? ORDER BY created_at ASC
  `).bind(incidentId).all<{ status: string; message: string; created_at: string }>();

  // Get affected components
  const components = await c.env.DB.prepare(`
    SELECT c.name FROM components c
    JOIN incident_components ic ON ic.component_id = c.id
    WHERE ic.incident_id = ?
  `).bind(incidentId).all<{ name: string }>();

  try {
    const postMortem = await generatePostMortem(c.env, {
      title: incident.title,
      impact: incident.impact,
      startTime: incident.created_at,
      endTime: incident.resolved_at,
      updates: updates.results,
      components: components.results.map(c => c.name)
    });

    return c.json({
      success: true,
      data: { postMortem }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI service unavailable';
    return c.json({ success: false, error: message }, 500);
  }
});

// Improve draft text
const improveDraftSchema = z.object({
  draft: z.string().min(10),
  context: z.enum(['incident', 'maintenance', 'announcement'])
});

ai.post('/improve-draft', zValidator('json', improveDraftSchema), async (c) => {
  const { draft, context } = c.req.valid('json');

  try {
    const improved = await improveDraft(c.env, draft, context);

    return c.json({
      success: true,
      data: { improved }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI service unavailable';
    return c.json({ success: false, error: message }, 500);
  }
});

export default ai;

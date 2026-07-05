import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Env } from '../types';
import { generateId } from '../utils';
import { orgAuthMiddleware, adminMiddleware, optionalAuthMiddleware } from '../middleware';

const incidentReports = new Hono<{ Bindings: Env }>();

// Schema for creating incident report
const createReportSchema = z.object({
  status_page_id: z.string(),
  reporter_email: z.string().email().optional(),
  reporter_name: z.string().max(100).optional(),
  component_id: z.string().optional(),
  title: z.string().min(5).max(200),
  description: z.string().min(10).max(2000)
});

// Public endpoint - Submit incident report
incidentReports.post('/submit', optionalAuthMiddleware, zValidator('json', createReportSchema), async (c) => {
  const input = c.req.valid('json');
  
  // Verify status page exists and allows reports
  const statusPage = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE id = ? AND is_public = 1
  `).bind(input.status_page_id).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Verify component exists if provided
  if (input.component_id) {
    const component = await c.env.DB.prepare(`
      SELECT id FROM components WHERE id = ? AND status_page_id = ?
    `).bind(input.component_id, input.status_page_id).first();
    
    if (!component) {
      return c.json({ success: false, error: 'Component not found' }, 400);
    }
  }

  const reportId = generateId();
  const now = new Date().toISOString();
  
  // Get IP address from request
  const ipAddress = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0] || '';

  await c.env.DB.prepare(`
    INSERT INTO incident_reports (id, status_page_id, reporter_email, reporter_name, component_id, title, description, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    reportId,
    input.status_page_id,
    input.reporter_email || null,
    input.reporter_name || null,
    input.component_id || null,
    input.title,
    input.description,
    ipAddress,
    now
  ).run();

  return c.json({
    success: true,
    data: {
      id: reportId,
      message: 'Thank you for your report. Our team has been notified.'
    }
  }, 201);
});

// List incident reports (admin only)
incidentReports.get('/', orgAuthMiddleware, adminMiddleware, async (c) => {
  const org = c.get('organization');
  const status = c.req.query('status') || 'new';
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await c.env.DB.prepare(`
    SELECT COUNT(*) as total FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    WHERE sp.organization_id = ?
    ${status !== 'all' ? 'AND ir.status = ?' : ''}
  `).bind(...(status !== 'all' ? [org.id, status] : [org.id])).first<{ total: number }>();

  // Get reports
  const reports = await c.env.DB.prepare(`
    SELECT ir.*, 
           sp.name as status_page_name,
           c.name as component_name,
           u.name as reviewed_by_name
    FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    LEFT JOIN components c ON c.id = ir.component_id
    LEFT JOIN users u ON u.id = ir.reviewed_by
    WHERE sp.organization_id = ?
    ${status !== 'all' ? 'AND ir.status = ?' : ''}
    ORDER BY ir.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...(status !== 'all' ? [org.id, status, limit, offset] : [org.id, limit, offset])).all();

  return c.json({
    success: true,
    data: reports.results,
    pagination: {
      page,
      limit,
      total: countResult?.total || 0,
      totalPages: Math.ceil((countResult?.total || 0) / limit)
    }
  });
});

// Get report counts by status - MUST be before /:id
incidentReports.get('/stats/counts', orgAuthMiddleware, async (c) => {
  const org = c.get('organization');

  const counts = await c.env.DB.prepare(`
    SELECT 
      ir.status,
      COUNT(*) as count
    FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    WHERE sp.organization_id = ?
    GROUP BY ir.status
  `).bind(org.id).all();

  const result: Record<string, number> = { new: 0, reviewed: 0, converted: 0, dismissed: 0 };
  for (const row of counts.results) {
    result[(row as any).status] = (row as any).count;
  }

  return c.json({
    success: true,
    data: result
  });
});

// Get single report
incidentReports.get('/:id', orgAuthMiddleware, async (c) => {
  const org = c.get('organization');
  const reportId = c.req.param('id');

  const report = await c.env.DB.prepare(`
    SELECT ir.*, 
           sp.name as status_page_name,
           c.name as component_name,
           u.name as reviewed_by_name,
           i.title as incident_title
    FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    LEFT JOIN components c ON c.id = ir.component_id
    LEFT JOIN users u ON u.id = ir.reviewed_by
    LEFT JOIN incidents i ON i.id = ir.incident_id
    WHERE ir.id = ? AND sp.organization_id = ?
  `).bind(reportId, org.id).first();

  if (!report) {
    return c.json({ success: false, error: 'Report not found' }, 404);
  }

  return c.json({
    success: true,
    data: report
  });
});

// Update report status
const updateReportSchema = z.object({
  status: z.enum(['reviewed', 'dismissed'])
});

incidentReports.patch('/:id', orgAuthMiddleware, adminMiddleware, zValidator('json', updateReportSchema), async (c) => {
  const org = c.get('organization');
  const user = c.get('user');
  const reportId = c.req.param('id');
  const { status } = c.req.valid('json');

  const report = await c.env.DB.prepare(`
    SELECT ir.* FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    WHERE ir.id = ? AND sp.organization_id = ?
  `).bind(reportId, org.id).first();

  if (!report) {
    return c.json({ success: false, error: 'Report not found' }, 404);
  }

  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    UPDATE incident_reports SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?
  `).bind(status, now, user.id, reportId).run();

  return c.json({
    success: true,
    data: { ...report, status, reviewed_at: now, reviewed_by: user.id }
  });
});

// Convert report to incident
const convertReportSchema = z.object({
  impact: z.enum(['none', 'minor', 'major', 'critical']).optional()
});

incidentReports.post('/:id/convert', orgAuthMiddleware, adminMiddleware, zValidator('json', convertReportSchema), async (c) => {
  const org = c.get('organization');
  const user = c.get('user');
  const reportId = c.req.param('id');
  const { impact = 'minor' } = c.req.valid('json');

  const report = await c.env.DB.prepare(`
    SELECT ir.*, sp.id as page_id FROM incident_reports ir
    JOIN status_pages sp ON sp.id = ir.status_page_id
    WHERE ir.id = ? AND sp.organization_id = ? AND ir.status = 'new'
  `).bind(reportId, org.id).first<{
    id: string;
    title: string;
    description: string;
    component_id: string | null;
    page_id: string;
  }>();

  if (!report) {
    return c.json({ success: false, error: 'Report not found or already processed' }, 404);
  }

  const incidentId = generateId();
  const updateId = generateId();
  const now = new Date().toISOString();

  // Create incident
  await c.env.DB.prepare(`
    INSERT INTO incidents (id, status_page_id, title, status, impact, created_at, updated_at)
    VALUES (?, ?, ?, 'investigating', ?, ?, ?)
  `).bind(incidentId, report.page_id, report.title, impact, now, now).run();

  // Create initial update with user report description
  await c.env.DB.prepare(`
    INSERT INTO incident_updates (id, incident_id, status, message, created_at)
    VALUES (?, ?, 'investigating', ?, ?)
  `).bind(updateId, incidentId, `User reported: ${report.description}`, now).run();

  // Link component if provided
  if (report.component_id) {
    const icId = generateId();
    await c.env.DB.prepare(`
      INSERT INTO incident_components (id, incident_id, component_id, status)
      VALUES (?, ?, ?, 'degraded_performance')
    `).bind(icId, incidentId, report.component_id).run();

    // Update component status
    await c.env.DB.prepare(`
      UPDATE components SET status = 'degraded_performance', updated_at = ? WHERE id = ?
    `).bind(now, report.component_id).run();
  }

  // Update report
  await c.env.DB.prepare(`
    UPDATE incident_reports SET status = 'converted', incident_id = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?
  `).bind(incidentId, now, user.id, reportId).run();

  const incident = await c.env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();

  return c.json({
    success: true,
    data: {
      incident,
      message: 'Report converted to incident successfully'
    }
  }, 201);
});

export default incidentReports;

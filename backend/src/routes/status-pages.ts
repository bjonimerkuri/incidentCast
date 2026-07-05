import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Env, StatusPage, Component, ComponentGroup, Incident, IncidentUpdate } from '../types';
import { createStatusPageSchema, updateStatusPageSchema } from '../schemas';
import { generateId, generateSubdomain, sqliteBool, toSqliteBool, calculateOverallStatus } from '../utils';
import { orgAuthMiddleware, adminMiddleware, optionalAuthMiddleware } from '../middleware';

const statusPages = new Hono<{ Bindings: Env }>();

// Public routes (no auth required)

// Get public status page by subdomain
statusPages.get('/public/:subdomain', async (c) => {
  const subdomain = c.req.param('subdomain');

  const page = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<StatusPage>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Get components with groups
  const components = await c.env.DB.prepare(`
    SELECT c.*, cg.name as group_name, cg.description as group_description, 
           cg.display_order as group_display_order, cg.collapsed_by_default
    FROM components c
    LEFT JOIN component_groups cg ON cg.id = c.group_id
    WHERE c.status_page_id = ?
    ORDER BY cg.display_order ASC, c.display_order ASC
  `).bind(page.id).all();

  // Get component groups
  const groups = await c.env.DB.prepare(`
    SELECT * FROM component_groups WHERE status_page_id = ?
    ORDER BY display_order ASC
  `).bind(page.id).all<ComponentGroup>();

  // Get active incidents (not resolved)
  const activeIncidents = await c.env.DB.prepare(`
    SELECT * FROM incidents 
    WHERE status_page_id = ? AND status != 'resolved' AND is_scheduled = 0
    ORDER BY created_at DESC
  `).bind(page.id).all<Incident>();

  // Get incident updates for active incidents
  const activeIncidentIds = activeIncidents.results.map(i => i.id);
  let incidentUpdates: IncidentUpdate[] = [];
  if (activeIncidentIds.length > 0) {
    const updates = await c.env.DB.prepare(`
      SELECT * FROM incident_updates 
      WHERE incident_id IN (${activeIncidentIds.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `).bind(...activeIncidentIds).all<IncidentUpdate>();
    incidentUpdates = updates.results;
  }

  // Get affected components for active incidents
  let incidentComponents: { incident_id: string; component_id: string; status: string; name: string }[] = [];
  if (activeIncidentIds.length > 0) {
    const affectedComponents = await c.env.DB.prepare(`
      SELECT ic.*, c.name FROM incident_components ic
      JOIN components c ON c.id = ic.component_id
      WHERE ic.incident_id IN (${activeIncidentIds.map(() => '?').join(',')})
    `).bind(...activeIncidentIds).all();
    incidentComponents = affectedComponents.results as typeof incidentComponents;
  }

  // Get scheduled maintenance
  const scheduledMaintenance = await c.env.DB.prepare(`
    SELECT * FROM incidents 
    WHERE status_page_id = ? AND is_scheduled = 1 AND status != 'completed'
    ORDER BY scheduled_for ASC
  `).bind(page.id).all<Incident>();

  // Get updates for scheduled maintenance
  const maintenanceIds = scheduledMaintenance.results.map(m => m.id);
  let maintenanceUpdates: IncidentUpdate[] = [];
  if (maintenanceIds.length > 0) {
    const updates = await c.env.DB.prepare(`
      SELECT * FROM incident_updates 
      WHERE incident_id IN (${maintenanceIds.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `).bind(...maintenanceIds).all<IncidentUpdate>();
    maintenanceUpdates = updates.results;
  }

  // Calculate overall status
  const overallStatus = calculateOverallStatus(components.results as unknown as Component[]);

  // Build response with updates
  const incidentsWithUpdates = activeIncidents.results.map(incident => ({
    ...incident,
    updates: incidentUpdates.filter(u => u.incident_id === incident.id),
    affected_components: incidentComponents
      .filter(ic => ic.incident_id === incident.id)
      .map(ic => ({ id: ic.component_id, name: ic.name, status: ic.status }))
  }));

  const maintenanceWithUpdates = scheduledMaintenance.results.map(maintenance => ({
    ...maintenance,
    updates: maintenanceUpdates.filter(u => u.incident_id === maintenance.id),
    affected_components: incidentComponents
      .filter(ic => ic.incident_id === maintenance.id)
      .map(ic => ({ id: ic.component_id, name: ic.name, status: ic.status }))
  }));

  return c.json({
    success: true,
    data: {
      page: {
        ...page,
        is_public: sqliteBool(page.is_public),
        show_subscribe_button: sqliteBool(page.show_subscribe_button)
      },
      components: components.results.map((comp: any) => ({
        ...comp,
        show_uptime: sqliteBool(comp.show_uptime)
      })),
      groups: groups.results.map(g => ({
        ...g,
        collapsed_by_default: sqliteBool(g.collapsed_by_default)
      })),
      activeIncidents: incidentsWithUpdates,
      scheduledMaintenance: maintenanceWithUpdates,
      overallStatus
    }
  });
});

// Get incident history for public page
statusPages.get('/public/:subdomain/history', async (c) => {
  const subdomain = c.req.param('subdomain');
  const days = parseInt(c.req.query('days') || '90');

  const page = await c.env.DB.prepare(`
    SELECT id, show_incident_history_days FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<{ id: string; show_incident_history_days: number }>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const actualDays = Math.min(days, page.show_incident_history_days);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - actualDays);

  // Get resolved incidents within the date range
  const incidents = await c.env.DB.prepare(`
    SELECT * FROM incidents 
    WHERE status_page_id = ? AND created_at >= ? 
    ORDER BY created_at DESC
  `).bind(page.id, startDate.toISOString()).all<Incident>();

  // Get all updates for these incidents
  const incidentIds = incidents.results.map(i => i.id);
  let updates: IncidentUpdate[] = [];
  if (incidentIds.length > 0) {
    const result = await c.env.DB.prepare(`
      SELECT * FROM incident_updates 
      WHERE incident_id IN (${incidentIds.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `).bind(...incidentIds).all<IncidentUpdate>();
    updates = result.results;
  }

  // Group incidents by date
  const incidentsByDate: Record<string, (Incident & { updates: IncidentUpdate[] })[]> = {};
  
  for (const incident of incidents.results) {
    const date = incident.created_at.split('T')[0];
    if (!incidentsByDate[date]) {
      incidentsByDate[date] = [];
    }
    incidentsByDate[date].push({
      ...incident,
      updates: updates.filter(u => u.incident_id === incident.id)
    });
  }

  // Convert to array sorted by date descending
  const history = Object.entries(incidentsByDate)
    .map(([date, incidents]) => ({ date, incidents }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return c.json({
    success: true,
    data: history
  });
});

// Get uptime data for public page
statusPages.get('/public/:subdomain/uptime', async (c) => {
  const subdomain = c.req.param('subdomain');
  const days = parseInt(c.req.query('days') || '90');

  const page = await c.env.DB.prepare(`
    SELECT id FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<{ id: string }>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Get components
  const components = await c.env.DB.prepare(`
    SELECT id, name FROM components WHERE status_page_id = ? AND show_uptime = 1
  `).bind(page.id).all<{ id: string; name: string }>();

  // Get metrics for each component
  const componentIds = components.results.map(c => c.id);
  let metrics: { component_id: string; date: string; uptime_percentage: number }[] = [];
  if (componentIds.length > 0) {
    const result = await c.env.DB.prepare(`
      SELECT component_id, date, uptime_percentage FROM component_metrics 
      WHERE component_id IN (${componentIds.map(() => '?').join(',')}) AND date >= ?
      ORDER BY date ASC
    `).bind(...componentIds, startDate.toISOString().split('T')[0]).all();
    metrics = result.results as typeof metrics;
  }

  // Calculate overall uptime for each component
  const uptimeData = components.results.map(component => {
    const componentMetrics = metrics.filter(m => m.component_id === component.id);
    const avgUptime = componentMetrics.length > 0
      ? componentMetrics.reduce((sum, m) => sum + m.uptime_percentage, 0) / componentMetrics.length
      : 100;
    
    return {
      component_id: component.id,
      component_name: component.name,
      uptime_percentage: Math.round(avgUptime * 100) / 100,
      daily_data: componentMetrics
    };
  });

  return c.json({
    success: true,
    data: uptimeData
  });
});

// Protected routes (require auth)
statusPages.use('/manage/*', orgAuthMiddleware);

// List status pages for organization
statusPages.get('/manage', async (c) => {
  const org = c.get('organization');

  if (!org) {
    return c.json({ success: true, data: [] });
  }

  const pages = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE organization_id = ?
    ORDER BY created_at DESC
  `).bind(org.id).all<StatusPage>();

  return c.json({
    success: true,
    data: pages.results.map(p => ({
      ...p,
      is_public: sqliteBool(p.is_public),
      show_subscribe_button: sqliteBool(p.show_subscribe_button)
    }))
  });
});

// Create status page
statusPages.post('/manage', adminMiddleware, zValidator('json', createStatusPageSchema), async (c) => {
  const org = c.get('organization');
  const input = c.req.valid('json');

  const pageId = generateId();
  const subdomain = input.subdomain || generateSubdomain(input.name);
  const now = new Date().toISOString();

  // Check if subdomain is taken
  const existing = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE subdomain = ?'
  ).bind(subdomain).first();

  if (existing) {
    return c.json({ success: false, error: 'Subdomain is already taken' }, 400);
  }

  await c.env.DB.prepare(`
    INSERT INTO status_pages (id, organization_id, name, subdomain, description, is_public, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    pageId,
    org.id,
    input.name,
    subdomain,
    input.description || null,
    toSqliteBool(input.is_public ?? true),
    now,
    now
  ).run();

  const page = await c.env.DB.prepare(
    'SELECT * FROM status_pages WHERE id = ?'
  ).bind(pageId).first<StatusPage>();

  return c.json({
    success: true,
    data: {
      ...page,
      is_public: sqliteBool(page!.is_public),
      show_subscribe_button: sqliteBool(page!.show_subscribe_button)
    }
  }, 201);
});

// Get single status page
statusPages.get('/manage/:pageId', async (c) => {
  const org = c.get('organization');
  const pageId = c.req.param('pageId');

  const page = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE id = ? AND organization_id = ?
  `).bind(pageId, org.id).first<StatusPage>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      ...page,
      is_public: sqliteBool(page.is_public),
      show_subscribe_button: sqliteBool(page.show_subscribe_button)
    }
  });
});

// Update status page
statusPages.patch('/manage/:pageId', adminMiddleware, zValidator('json', updateStatusPageSchema), async (c) => {
  const org = c.get('organization');
  const pageId = c.req.param('pageId');
  const updates = c.req.valid('json');

  // Verify page belongs to org
  const existing = await c.env.DB.prepare(
    'SELECT id, subdomain FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first<{ id: string; subdomain: string }>();

  if (!existing) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Check if subdomain is being changed and if it's already taken
  if (updates.subdomain && updates.subdomain !== existing.subdomain) {
    const subdomainTaken = await c.env.DB.prepare(
      'SELECT id FROM status_pages WHERE subdomain = ? AND id != ?'
    ).bind(updates.subdomain, pageId).first();

    if (subdomainTaken) {
      return c.json({ success: false, error: 'Subdomain is already taken' }, 400);
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  const stringFields = ['name', 'subdomain', 'description', 'logo_url', 'favicon_url', 'header_bg_color', 
    'header_text_color', 'accent_color', 'google_analytics_id', 'custom_css', 
    'custom_html_head', 'custom_domain'];
  
  for (const field of stringFields) {
    if ((updates as Record<string, unknown>)[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push((updates as Record<string, unknown>)[field] || null);
    }
  }

  if (updates.show_subscribe_button !== undefined) {
    fields.push('show_subscribe_button = ?');
    values.push(toSqliteBool(updates.show_subscribe_button));
  }
  if (updates.show_incident_history_days !== undefined) {
    fields.push('show_incident_history_days = ?');
    values.push(updates.show_incident_history_days);
  }
  if (updates.is_public !== undefined) {
    fields.push('is_public = ?');
    values.push(toSqliteBool(updates.is_public));
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(pageId);

  await c.env.DB.prepare(`
    UPDATE status_pages SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const page = await c.env.DB.prepare(
    'SELECT * FROM status_pages WHERE id = ?'
  ).bind(pageId).first<StatusPage>();

  return c.json({
    success: true,
    data: {
      ...page,
      is_public: sqliteBool(page!.is_public),
      show_subscribe_button: sqliteBool(page!.show_subscribe_button)
    }
  });
});

// Delete status page
statusPages.delete('/manage/:pageId', adminMiddleware, async (c) => {
  const org = c.get('organization');
  const pageId = c.req.param('pageId');

  // Verify page belongs to org
  const existing = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!existing) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM status_pages WHERE id = ?').bind(pageId).run();

  return c.json({
    success: true,
    message: 'Status page deleted successfully'
  });
});

// ============ Embeddable Status Badge ============

// Get status badge data (JSON)
statusPages.get('/public/:subdomain/badge', async (c) => {
  const subdomain = c.req.param('subdomain');

  const page = await c.env.DB.prepare(`
    SELECT id, name FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<{ id: string; name: string }>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Get components to calculate overall status
  const components = await c.env.DB.prepare(`
    SELECT status FROM components WHERE status_page_id = ?
  `).bind(page.id).all<{ status: string }>();

  const overallStatus = calculateOverallStatus(components.results as Component[]);

  // Get active incident count
  const activeIncidents = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM incidents 
    WHERE status_page_id = ? AND status != 'resolved' AND is_scheduled = 0
  `).bind(page.id).first<{ count: number }>();

  return c.json({
    success: true,
    data: {
      status: overallStatus,
      statusText: getStatusText(overallStatus),
      activeIncidents: activeIncidents?.count || 0,
      pageName: page.name,
      lastUpdated: new Date().toISOString()
    }
  });
});

// Get status badge as SVG
statusPages.get('/public/:subdomain/badge.svg', async (c) => {
  const subdomain = c.req.param('subdomain');
  const style = c.req.query('style') || 'flat'; // flat, flat-square, plastic

  const page = await c.env.DB.prepare(`
    SELECT id, name FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<{ id: string; name: string }>();

  if (!page) {
    // Return a "not found" badge
    const svg = generateBadgeSVG('Status', 'Not Found', '#9ca3af', style);
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'no-cache');
    return c.body(svg);
  }

  const components = await c.env.DB.prepare(`
    SELECT status FROM components WHERE status_page_id = ?
  `).bind(page.id).all<{ status: string }>();

  const overallStatus = calculateOverallStatus(components.results as Component[]);
  const statusText = getStatusText(overallStatus);
  const statusColor = getStatusColor(overallStatus);

  const svg = generateBadgeSVG(page.name, statusText, statusColor, style);
  
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=60'); // Cache for 1 minute
  return c.body(svg);
});

// Get embeddable widget JavaScript
statusPages.get('/public/:subdomain/widget.js', async (c) => {
  const subdomain = c.req.param('subdomain');
  const apiUrl = c.env.API_URL || 'https://incidentcast-api.bjonimerkuri1.workers.dev';
  
  const js = `
(function() {
  const SUBDOMAIN = '${subdomain}';
  const API_URL = '${apiUrl}';
  
  function createWidget(container) {
    const wrapper = document.createElement('div');
    wrapper.className = 'incidentcast-widget';
    wrapper.innerHTML = '<div class="ic-loading">Loading status...</div>';
    container.appendChild(wrapper);
    
    fetch(API_URL + '/api/status-pages/public/' + SUBDOMAIN + '/badge')
      .then(r => r.json())
      .then(data => {
        if (!data.success) throw new Error('Failed to load');
        const d = data.data;
        const colors = {
          operational: '#22c55e',
          degraded_performance: '#f59e0b',
          partial_outage: '#f97316',
          major_outage: '#ef4444',
          under_maintenance: '#6366f1'
        };
        wrapper.innerHTML = \`
          <a href="https://\${SUBDOMAIN}.incidentcast.pages.dev" target="_blank" class="ic-badge" style="
            display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px;
            background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
            text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          ">
            <span class="ic-dot" style="
              width: 10px; height: 10px; border-radius: 50%;
              background: \${colors[d.status] || '#9ca3af'};
            "></span>
            <span style="color: #1e293b; font-size: 14px; font-weight: 500;">\${d.statusText}</span>
          </a>
        \`;
      })
      .catch(() => {
        wrapper.innerHTML = '<span style="color: #ef4444;">Failed to load status</span>';
      });
  }
  
  // Auto-init widgets
  document.querySelectorAll('[data-incidentcast-widget]').forEach(createWidget);
  
  // Expose for manual init
  window.IncidentCast = { createWidget: createWidget };
})();
`;

  c.header('Content-Type', 'application/javascript');
  c.header('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
  return c.body(js);
});

// ============ Private Status Page Access ============

// Verify password for private status page
statusPages.post('/public/:subdomain/verify', async (c) => {
  const subdomain = c.req.param('subdomain');
  const { password } = await c.req.json<{ password: string }>();

  const page = await c.env.DB.prepare(`
    SELECT id, is_private, access_password FROM status_pages WHERE subdomain = ?
  `).bind(subdomain).first<{ id: string; is_private: number; access_password: string | null }>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  if (!page.is_private || !page.access_password) {
    return c.json({ success: true, data: { verified: true } });
  }

  // Simple password check (in production, use proper hashing)
  const isValid = page.access_password === password;

  if (!isValid) {
    return c.json({ success: false, error: 'Invalid password' }, 401);
  }

  // Generate access token (valid for 24 hours)
  const token = btoa(JSON.stringify({
    pageId: page.id,
    exp: Date.now() + 24 * 60 * 60 * 1000
  }));

  return c.json({ 
    success: true, 
    data: { 
      verified: true,
      accessToken: token
    } 
  });
});

// Update private page settings
statusPages.patch('/manage/:pageId/privacy', adminMiddleware, async (c) => {
  const org = c.get('organization');
  const pageId = c.req.param('pageId');
  const { is_private, password } = await c.req.json<{ is_private: boolean; password?: string }>();

  const existing = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!existing) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const updates: string[] = ['is_private = ?', 'updated_at = ?'];
  const values: unknown[] = [is_private ? 1 : 0, new Date().toISOString()];

  if (is_private && password) {
    updates.push('access_password = ?');
    values.push(password); // In production, hash this
  } else if (!is_private) {
    updates.push('access_password = NULL');
  }

  values.push(pageId);

  await c.env.DB.prepare(`
    UPDATE status_pages SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return c.json({ success: true, message: 'Privacy settings updated' });
});

// Helper functions for badges
function getStatusText(status: string): string {
  const texts: Record<string, string> = {
    operational: 'All Systems Operational',
    degraded_performance: 'Degraded Performance',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    under_maintenance: 'Under Maintenance'
  };
  return texts[status] || 'Unknown';
}

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    operational: '#22c55e',
    degraded_performance: '#f59e0b',
    partial_outage: '#f97316',
    major_outage: '#ef4444',
    under_maintenance: '#6366f1'
  };
  return colors[status] || '#9ca3af';
}

function generateBadgeSVG(label: string, status: string, color: string, style: string): string {
  const labelWidth = label.length * 6.5 + 10;
  const statusWidth = status.length * 6.5 + 10;
  const totalWidth = labelWidth + statusWidth;
  const height = style === 'plastic' ? 20 : 18;
  const radius = style === 'flat-square' ? 0 : 3;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}">
  <linearGradient id="bg" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect rx="${radius}" width="${totalWidth}" height="${height}" fill="#555"/>
  <rect rx="${radius}" x="${labelWidth}" width="${statusWidth}" height="${height}" fill="${color}"/>
  <path fill="${color}" d="M${labelWidth} 0h4v${height}h-4z"/>
  <rect rx="${radius}" width="${totalWidth}" height="${height}" fill="url(#bg)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="${height - 5}" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="${height - 6}">${escapeXml(label)}</text>
    <text x="${labelWidth + statusWidth / 2}" y="${height - 5}" fill="#010101" fill-opacity=".3">${escapeXml(status)}</text>
    <text x="${labelWidth + statusWidth / 2}" y="${height - 6}">${escapeXml(status)}</text>
  </g>
</svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c] || c));
}

export default statusPages;

import { Hono } from 'hono';
import { Env } from '../types';
import { optionalAuthMiddleware, orgAuthMiddleware, adminMiddleware } from '../middleware';

const uptime = new Hono<{ Bindings: Env }>();

// Get uptime summary for a status page (public)
uptime.get('/status-pages/:subdomain/uptime', optionalAuthMiddleware, async (c) => {
  const subdomain = c.req.param('subdomain');
  const days = parseInt(c.req.query('days') || '90');

  const statusPage = await c.env.DB.prepare(`
    SELECT * FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Get components with uptime data
  const components = await c.env.DB.prepare(`
    SELECT c.id, c.name, c.status, c.display_order,
           COALESCE(
             (SELECT AVG(uptime_percentage) FROM uptime_daily ud 
              WHERE ud.component_id = c.id 
              AND ud.date >= date('now', '-' || ? || ' days')), 
             100.0
           ) as uptime_percentage,
           (SELECT COUNT(*) FROM incidents i 
            JOIN incident_components ic ON ic.incident_id = i.id 
            WHERE ic.component_id = c.id 
            AND i.created_at >= datetime('now', '-' || ? || ' days')) as incidents_count
    FROM components c
    WHERE c.status_page_id = ?
    ORDER BY c.display_order ASC
  `).bind(days, days, statusPage.id).all();

  // Get daily uptime for chart
  const dailyUptime = await c.env.DB.prepare(`
    SELECT date, AVG(uptime_percentage) as uptime_percentage
    FROM uptime_daily ud
    JOIN components c ON c.id = ud.component_id
    WHERE c.status_page_id = ?
    AND ud.date >= date('now', '-' || ? || ' days')
    GROUP BY date
    ORDER BY date ASC
  `).bind(statusPage.id, days).all();

  // Calculate overall uptime
  const overallUptime = components.results.length > 0
    ? components.results.reduce((sum: number, c: any) => sum + (c.uptime_percentage || 100), 0) / components.results.length
    : 100;

  return c.json({
    success: true,
    data: {
      overall_uptime: Math.round(overallUptime * 100) / 100,
      days_tracked: days,
      components: components.results,
      daily_uptime: dailyUptime.results
    }
  });
});

// Get detailed uptime for a specific component (public)
uptime.get('/components/:componentId/uptime', optionalAuthMiddleware, async (c) => {
  const componentId = c.req.param('componentId');
  const days = parseInt(c.req.query('days') || '90');

  const component = await c.env.DB.prepare(`
    SELECT c.*, sp.is_public 
    FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.is_public = 1
  `).bind(componentId).first();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  // Get daily breakdown
  const dailyData = await c.env.DB.prepare(`
    SELECT * FROM uptime_daily 
    WHERE component_id = ? 
    AND date >= date('now', '-' || ? || ' days')
    ORDER BY date ASC
  `).bind(componentId, days).all();

  // Get recent incidents
  const incidents = await c.env.DB.prepare(`
    SELECT i.id, i.title, i.status, i.impact, i.created_at, i.resolved_at
    FROM incidents i
    JOIN incident_components ic ON ic.incident_id = i.id
    WHERE ic.component_id = ?
    AND i.created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY i.created_at DESC
    LIMIT 10
  `).bind(componentId, days).all();

  // Calculate metrics
  const totalDays = dailyData.results.length || 1;
  const totalUptime = dailyData.results.reduce((sum: number, d: any) => sum + (d.uptime_percentage || 100), 0);
  const avgUptime = totalUptime / totalDays;

  return c.json({
    success: true,
    data: {
      component: {
        id: component.id,
        name: component.name,
        status: component.status
      },
      uptime_percentage: Math.round(avgUptime * 100) / 100,
      days_tracked: days,
      daily_data: dailyData.results,
      recent_incidents: incidents.results
    }
  });
});

// Record uptime snapshot (called by scheduled worker or API)
uptime.post('/record', orgAuthMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json() as { component_id: string; status: string };
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  // Insert hourly snapshot
  const historyId = `uh_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  await c.env.DB.prepare(`
    INSERT INTO uptime_history (id, component_id, status, recorded_at)
    VALUES (?, ?, ?, ?)
  `).bind(historyId, body.component_id, body.status, now).run();

  // Update daily summary
  const isUp = body.status === 'operational';
  const isDegraded = body.status === 'degraded_performance';
  const isDown = ['partial_outage', 'major_outage'].includes(body.status);

  // Get or create daily record
  const existing = await c.env.DB.prepare(`
    SELECT * FROM uptime_daily WHERE component_id = ? AND date = ?
  `).bind(body.component_id, today).first();

  if (existing) {
    let uptimeMinutes = (existing as any).uptime_minutes;
    let degradedMinutes = (existing as any).degraded_minutes;
    let downtimeMinutes = (existing as any).downtime_minutes;

    if (isUp) uptimeMinutes += 60;
    else if (isDegraded) degradedMinutes += 60;
    else if (isDown) downtimeMinutes += 60;

    const totalMinutes = uptimeMinutes + degradedMinutes + downtimeMinutes;
    const uptimePercentage = totalMinutes > 0 ? (uptimeMinutes / totalMinutes) * 100 : 100;

    await c.env.DB.prepare(`
      UPDATE uptime_daily SET 
        uptime_minutes = ?, 
        degraded_minutes = ?,
        downtime_minutes = ?,
        uptime_percentage = ?
      WHERE id = ?
    `).bind(uptimeMinutes, degradedMinutes, downtimeMinutes, uptimePercentage, (existing as any).id).run();
  } else {
    const dailyId = `ud_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await c.env.DB.prepare(`
      INSERT INTO uptime_daily (id, component_id, date, uptime_minutes, degraded_minutes, downtime_minutes, uptime_percentage)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      dailyId,
      body.component_id,
      today,
      isUp ? 60 : 0,
      isDegraded ? 60 : 0,
      isDown ? 60 : 0,
      isUp ? 100 : (isDegraded ? 50 : 0)
    ).run();
  }

  return c.json({ success: true });
});

// Initialize uptime data for all components (admin utility)
uptime.post('/initialize', orgAuthMiddleware, adminMiddleware, async (c) => {
  const org = c.get('organization');
  const days = parseInt(c.req.query('days') || '30');
  const now = new Date();

  // Get all components for this org
  const components = await c.env.DB.prepare(`
    SELECT c.id FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE sp.organization_id = ?
  `).bind(org.id).all();

  let created = 0;

  for (const component of components.results) {
    // Create historical daily records (assume 100% uptime for past data)
    for (let i = days; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      // Skip if already exists
      const existing = await c.env.DB.prepare(`
        SELECT id FROM uptime_daily WHERE component_id = ? AND date = ?
      `).bind((component as any).id, dateStr).first();

      if (!existing) {
        const dailyId = `ud_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        // Simulate realistic uptime (99-100%)
        const uptimePercentage = 99 + Math.random();
        const uptimeMinutes = Math.round((uptimePercentage / 100) * 1440);
        
        await c.env.DB.prepare(`
          INSERT INTO uptime_daily (id, component_id, date, uptime_minutes, downtime_minutes, degraded_minutes, uptime_percentage)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          dailyId,
          (component as any).id,
          dateStr,
          uptimeMinutes,
          1440 - uptimeMinutes,
          0,
          uptimePercentage
        ).run();
        created++;
      }
    }
  }

  return c.json({
    success: true,
    data: {
      components: components.results.length,
      records_created: created
    }
  });
});

export default uptime;

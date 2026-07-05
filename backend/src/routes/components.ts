import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Env, Component, ComponentGroup } from '../types';
import { 
  createComponentSchema, 
  updateComponentSchema,
  createComponentGroupSchema,
  updateComponentGroupSchema 
} from '../schemas';
import { generateId, sqliteBool, toSqliteBool } from '../utils';
import { orgAuthMiddleware, adminMiddleware } from '../middleware';

const components = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
components.use('*', orgAuthMiddleware);

// Helper to verify status page belongs to org
async function verifyStatusPage(c: any, pageId: string): Promise<boolean> {
  const org = c.get('organization');
  const page = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();
  return !!page;
}

// ============ Component Groups ============

// List component groups for a status page
components.get('/pages/:pageId/groups', async (c) => {
  const pageId = c.req.param('pageId');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const groups = await c.env.DB.prepare(`
    SELECT * FROM component_groups WHERE status_page_id = ?
    ORDER BY display_order ASC
  `).bind(pageId).all<ComponentGroup>();

  return c.json({
    success: true,
    data: groups.results.map(g => ({
      ...g,
      collapsed_by_default: sqliteBool(g.collapsed_by_default)
    }))
  });
});

// Create component group
components.post('/pages/:pageId/groups', adminMiddleware, zValidator('json', createComponentGroupSchema), async (c) => {
  const pageId = c.req.param('pageId');
  const input = c.req.valid('json');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const groupId = generateId();
  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO component_groups (id, status_page_id, name, description, display_order, collapsed_by_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    groupId,
    pageId,
    input.name,
    input.description || null,
    input.display_order,
    toSqliteBool(input.collapsed_by_default),
    now,
    now
  ).run();

  const group = await c.env.DB.prepare(
    'SELECT * FROM component_groups WHERE id = ?'
  ).bind(groupId).first<ComponentGroup>();

  return c.json({
    success: true,
    data: {
      ...group,
      collapsed_by_default: sqliteBool(group!.collapsed_by_default)
    }
  }, 201);
});

// Update component group
components.patch('/groups/:groupId', adminMiddleware, zValidator('json', updateComponentGroupSchema), async (c) => {
  const groupId = c.req.param('groupId');
  const org = c.get('organization');
  const updates = c.req.valid('json');

  // Verify group belongs to org
  const group = await c.env.DB.prepare(`
    SELECT cg.* FROM component_groups cg
    JOIN status_pages sp ON sp.id = cg.status_page_id
    WHERE cg.id = ? AND sp.organization_id = ?
  `).bind(groupId, org.id).first<ComponentGroup>();

  if (!group) {
    return c.json({ success: false, error: 'Component group not found' }, 404);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description || null);
  }
  if (updates.display_order !== undefined) {
    fields.push('display_order = ?');
    values.push(updates.display_order);
  }
  if (updates.collapsed_by_default !== undefined) {
    fields.push('collapsed_by_default = ?');
    values.push(toSqliteBool(updates.collapsed_by_default));
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(groupId);

  await c.env.DB.prepare(`
    UPDATE component_groups SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await c.env.DB.prepare(
    'SELECT * FROM component_groups WHERE id = ?'
  ).bind(groupId).first<ComponentGroup>();

  return c.json({
    success: true,
    data: {
      ...updated,
      collapsed_by_default: sqliteBool(updated!.collapsed_by_default)
    }
  });
});

// Delete component group
components.delete('/groups/:groupId', adminMiddleware, async (c) => {
  const groupId = c.req.param('groupId');
  const org = c.get('organization');

  // Verify group belongs to org
  const group = await c.env.DB.prepare(`
    SELECT cg.id FROM component_groups cg
    JOIN status_pages sp ON sp.id = cg.status_page_id
    WHERE cg.id = ? AND sp.organization_id = ?
  `).bind(groupId, org.id).first();

  if (!group) {
    return c.json({ success: false, error: 'Component group not found' }, 404);
  }

  // Components in this group will have group_id set to NULL (cascade)
  await c.env.DB.prepare('DELETE FROM component_groups WHERE id = ?').bind(groupId).run();

  return c.json({
    success: true,
    message: 'Component group deleted successfully'
  });
});

// Reorder component groups
components.post('/pages/:pageId/groups/reorder', adminMiddleware, async (c) => {
  const pageId = c.req.param('pageId');
  const { order } = await c.req.json<{ order: string[] }>();

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Update display order for each group
  const statements = order.map((groupId, index) => 
    c.env.DB.prepare('UPDATE component_groups SET display_order = ? WHERE id = ? AND status_page_id = ?')
      .bind(index, groupId, pageId)
  );

  await c.env.DB.batch(statements);

  return c.json({
    success: true,
    message: 'Groups reordered successfully'
  });
});

// ============ Components ============

// List components for a status page
components.get('/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const comps = await c.env.DB.prepare(`
    SELECT c.*, cg.name as group_name FROM components c
    LEFT JOIN component_groups cg ON cg.id = c.group_id
    WHERE c.status_page_id = ?
    ORDER BY cg.display_order ASC NULLS LAST, c.display_order ASC
  `).bind(pageId).all();

  return c.json({
    success: true,
    data: comps.results.map((comp: any) => ({
      ...comp,
      show_uptime: sqliteBool(comp.show_uptime)
    }))
  });
});

// Create component
components.post('/pages/:pageId', adminMiddleware, zValidator('json', createComponentSchema), async (c) => {
  const pageId = c.req.param('pageId');
  const input = c.req.valid('json');

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Verify group belongs to the same status page if provided
  if (input.group_id) {
    const group = await c.env.DB.prepare(
      'SELECT id FROM component_groups WHERE id = ? AND status_page_id = ?'
    ).bind(input.group_id, pageId).first();

    if (!group) {
      return c.json({ success: false, error: 'Component group not found' }, 400);
    }
  }

  const componentId = generateId();
  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO components (id, status_page_id, group_id, name, description, status, display_order, show_uptime, start_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    componentId,
    pageId,
    input.group_id || null,
    input.name,
    input.description || null,
    input.status,
    input.display_order,
    toSqliteBool(input.show_uptime),
    input.start_date || now.split('T')[0],
    now,
    now
  ).run();

  const component = await c.env.DB.prepare(
    'SELECT * FROM components WHERE id = ?'
  ).bind(componentId).first<Component>();

  return c.json({
    success: true,
    data: {
      ...component,
      show_uptime: sqliteBool(component!.show_uptime)
    }
  }, 201);
});

// Get single component
components.get('/:componentId', async (c) => {
  const componentId = c.req.param('componentId');
  const org = c.get('organization');

  const component = await c.env.DB.prepare(`
    SELECT c.* FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, org.id).first<Component>();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      ...component,
      show_uptime: sqliteBool(component.show_uptime)
    }
  });
});

// Update component
components.patch('/:componentId', adminMiddleware, zValidator('json', updateComponentSchema), async (c) => {
  const componentId = c.req.param('componentId');
  const org = c.get('organization');
  const updates = c.req.valid('json');

  // Verify component belongs to org
  const component = await c.env.DB.prepare(`
    SELECT c.*, sp.id as page_id FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, org.id).first<Component & { page_id: string }>();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  // Verify group belongs to the same status page if provided
  if (updates.group_id) {
    const group = await c.env.DB.prepare(
      'SELECT id FROM component_groups WHERE id = ? AND status_page_id = ?'
    ).bind(updates.group_id, component.page_id).first();

    if (!group) {
      return c.json({ success: false, error: 'Component group not found' }, 400);
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description || null);
  }
  if (updates.group_id !== undefined) {
    fields.push('group_id = ?');
    values.push(updates.group_id);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.display_order !== undefined) {
    fields.push('display_order = ?');
    values.push(updates.display_order);
  }
  if (updates.show_uptime !== undefined) {
    fields.push('show_uptime = ?');
    values.push(toSqliteBool(updates.show_uptime));
  }
  if (updates.start_date !== undefined) {
    fields.push('start_date = ?');
    values.push(updates.start_date);
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(componentId);

  await c.env.DB.prepare(`
    UPDATE components SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await c.env.DB.prepare(
    'SELECT * FROM components WHERE id = ?'
  ).bind(componentId).first<Component>();

  return c.json({
    success: true,
    data: {
      ...updated,
      show_uptime: sqliteBool(updated!.show_uptime)
    }
  });
});

// Update component status only (quick update)
components.patch('/:componentId/status', adminMiddleware, async (c) => {
  const componentId = c.req.param('componentId');
  const org = c.get('organization');
  const { status } = await c.req.json<{ status: string }>();

  const validStatuses = ['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance'];
  if (!validStatuses.includes(status)) {
    return c.json({ success: false, error: 'Invalid status' }, 400);
  }

  // Verify component belongs to org
  const component = await c.env.DB.prepare(`
    SELECT c.id FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, org.id).first();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE components SET status = ?, updated_at = ? WHERE id = ?'
  ).bind(status, new Date().toISOString(), componentId).run();

  return c.json({
    success: true,
    message: 'Component status updated'
  });
});

// Delete component
components.delete('/:componentId', adminMiddleware, async (c) => {
  const componentId = c.req.param('componentId');
  const org = c.get('organization');

  // Verify component belongs to org
  const component = await c.env.DB.prepare(`
    SELECT c.id FROM components c
    JOIN status_pages sp ON sp.id = c.status_page_id
    WHERE c.id = ? AND sp.organization_id = ?
  `).bind(componentId, org.id).first();

  if (!component) {
    return c.json({ success: false, error: 'Component not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM components WHERE id = ?').bind(componentId).run();

  return c.json({
    success: true,
    message: 'Component deleted successfully'
  });
});

// Reorder components
components.post('/pages/:pageId/reorder', adminMiddleware, async (c) => {
  const pageId = c.req.param('pageId');
  const { order } = await c.req.json<{ order: string[] }>();

  if (!await verifyStatusPage(c, pageId)) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Update display order for each component
  const statements = order.map((componentId, index) => 
    c.env.DB.prepare('UPDATE components SET display_order = ? WHERE id = ? AND status_page_id = ?')
      .bind(index, componentId, pageId)
  );

  await c.env.DB.batch(statements);

  return c.json({
    success: true,
    message: 'Components reordered successfully'
  });
});

export default components;

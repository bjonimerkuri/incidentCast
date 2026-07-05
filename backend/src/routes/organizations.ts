import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Env, Organization, User } from '../types';
import { 
  createOrganizationSchema, 
  updateOrganizationSchema,
  inviteMemberSchema 
} from '../schemas';
import { generateId, generateSlug, hashToken } from '../utils';
import { orgAuthMiddleware, adminMiddleware, ownerMiddleware } from '../middleware';

const organizations = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
organizations.use('*', orgAuthMiddleware);

// Get all organizations for current user
organizations.get('/', async (c) => {
  const user = c.get('user');

  const orgs = await c.env.DB.prepare(`
    SELECT o.*, om.role FROM organizations o
    JOIN organization_members om ON om.organization_id = o.id
    WHERE om.user_id = ?
    ORDER BY o.created_at DESC
  `).bind(user.id).all();

  return c.json({
    success: true,
    data: orgs.results
  });
});

// Create new organization
organizations.post('/', zValidator('json', createOrganizationSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');

  const orgId = generateId();
  const slug = generateSlug(input.name) + '-' + Math.random().toString(36).substring(2, 6);
  const now = new Date().toISOString();

  // Create organization
  await c.env.DB.prepare(`
    INSERT INTO organizations (id, name, slug, website_url, support_url, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orgId, 
    input.name, 
    slug, 
    input.website_url || null,
    input.support_url || null,
    input.timezone || 'UTC',
    now, 
    now
  ).run();

  // Add user as owner
  await c.env.DB.prepare(`
    INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
    VALUES (?, ?, ?, 'owner', ?)
  `).bind(generateId(), orgId, user.id, now).run();

  // Create default status page
  const statusPageId = generateId();
  await c.env.DB.prepare(`
    INSERT INTO status_pages (id, organization_id, name, subdomain, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    statusPageId, 
    orgId, 
    `${input.name} Status`, 
    slug, 
    `Current status and incidents for ${input.name}`,
    now, 
    now
  ).run();

  const organization: Organization = {
    id: orgId,
    name: input.name,
    slug,
    website_url: input.website_url,
    support_url: input.support_url,
    timezone: input.timezone || 'UTC',
    created_at: now,
    updated_at: now
  };

  return c.json({
    success: true,
    data: organization
  }, 201);
});

// Get single organization
organizations.get('/:orgId', async (c) => {
  const org = c.get('organization');

  if (!org) {
    return c.json({ success: false, error: 'Organization not found' }, 404);
  }

  // Get member count
  const memberCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM organization_members WHERE organization_id = ?'
  ).bind(org.id).first<{ count: number }>();

  // Get status pages
  const statusPages = await c.env.DB.prepare(
    'SELECT * FROM status_pages WHERE organization_id = ?'
  ).bind(org.id).all();

  return c.json({
    success: true,
    data: {
      ...org,
      member_count: memberCount?.count || 0,
      status_pages: statusPages.results
    }
  });
});

// Update organization
organizations.patch('/:orgId', adminMiddleware, zValidator('json', updateOrganizationSchema), async (c) => {
  const org = c.get('organization');
  const updates = c.req.valid('json');

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.website_url !== undefined) {
    fields.push('website_url = ?');
    values.push(updates.website_url || null);
  }
  if (updates.support_url !== undefined) {
    fields.push('support_url = ?');
    values.push(updates.support_url || null);
  }
  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    values.push(updates.timezone);
  }
  if (updates.logo_url !== undefined) {
    fields.push('logo_url = ?');
    values.push(updates.logo_url || null);
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(org.id);

  await c.env.DB.prepare(`
    UPDATE organizations SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await c.env.DB.prepare(
    'SELECT * FROM organizations WHERE id = ?'
  ).bind(org.id).first<Organization>();

  return c.json({
    success: true,
    data: updated
  });
});

// Delete organization
organizations.delete('/:orgId', ownerMiddleware, async (c) => {
  const org = c.get('organization');

  // Delete organization (cascade will handle related records)
  await c.env.DB.prepare('DELETE FROM organizations WHERE id = ?').bind(org.id).run();

  return c.json({
    success: true,
    message: 'Organization deleted successfully'
  });
});

// Get organization members
organizations.get('/:orgId/members', async (c) => {
  const org = c.get('organization');

  const members = await c.env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.avatar_url, om.role, om.created_at as joined_at
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ?
    ORDER BY om.created_at ASC
  `).bind(org.id).all();

  return c.json({
    success: true,
    data: members.results
  });
});

// Invite member
organizations.post('/:orgId/members', adminMiddleware, zValidator('json', inviteMemberSchema), async (c) => {
  const org = c.get('organization');
  const { email, role } = c.req.valid('json');

  // Check if user exists
  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first<{ id: string }>();

  if (!user) {
    return c.json({ 
      success: false, 
      error: 'User with this email does not exist. They need to sign up first.' 
    }, 400);
  }

  // Check if already a member
  const existingMember = await c.env.DB.prepare(
    'SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).bind(org.id, user.id).first();

  if (existingMember) {
    return c.json({ success: false, error: 'User is already a member of this organization' }, 400);
  }

  // Add member
  await c.env.DB.prepare(`
    INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(generateId(), org.id, user.id, role, new Date().toISOString()).run();

  return c.json({
    success: true,
    message: 'Member added successfully'
  }, 201);
});

// Update member role
organizations.patch('/:orgId/members/:userId', adminMiddleware, async (c) => {
  const org = c.get('organization');
  const userId = c.req.param('userId');
  const { role } = await c.req.json<{ role: string }>();

  if (!['admin', 'member'].includes(role)) {
    return c.json({ success: false, error: 'Invalid role' }, 400);
  }

  // Can't change owner role
  const member = await c.env.DB.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).bind(org.id, userId).first<{ role: string }>();

  if (!member) {
    return c.json({ success: false, error: 'Member not found' }, 404);
  }

  if (member.role === 'owner') {
    return c.json({ success: false, error: 'Cannot change owner role' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?'
  ).bind(role, org.id, userId).run();

  return c.json({
    success: true,
    message: 'Member role updated'
  });
});

// Remove member
organizations.delete('/:orgId/members/:userId', adminMiddleware, async (c) => {
  const org = c.get('organization');
  const userId = c.req.param('userId');
  const currentUser = c.get('user');

  // Can't remove yourself if you're the owner
  const member = await c.env.DB.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).bind(org.id, userId).first<{ role: string }>();

  if (!member) {
    return c.json({ success: false, error: 'Member not found' }, 404);
  }

  if (member.role === 'owner') {
    return c.json({ success: false, error: 'Cannot remove the owner' }, 400);
  }

  await c.env.DB.prepare(
    'DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).bind(org.id, userId).run();

  return c.json({
    success: true,
    message: 'Member removed successfully'
  });
});

// ============ API Keys Management ============

// List API keys for organization
organizations.get('/:orgId/api-keys', async (c) => {
  const org = c.get('organization');

  const keys = await c.env.DB.prepare(`
    SELECT id, name, key_preview, permissions, last_used_at, expires_at, created_at
    FROM api_keys WHERE organization_id = ?
    ORDER BY created_at DESC
  `).bind(org.id).all();

  // Parse permissions JSON
  const data = keys.results.map((key: any) => ({
    ...key,
    permissions: JSON.parse(key.permissions || '[]')
  }));

  return c.json({
    success: true,
    data
  });
});

// Create API key schema
const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(z.string()).optional(),
  expires_in_days: z.number().nullable().optional()
});

// Create new API key
organizations.post('/:orgId/api-keys', adminMiddleware, zValidator('json', createApiKeySchema), async (c) => {
  const org = c.get('organization');
  const user = c.get('user');
  const { name, permissions = ['read', 'write'], expires_in_days } = c.req.valid('json');

  const apiKeyId = generateId();
  const rawKey = `ic_${generateId()}${generateId()}`;
  const keyHash = await hashToken(rawKey);
  const keyPreview = rawKey.substring(0, 12) + '...' + rawKey.substring(rawKey.length - 4);
  const now = new Date().toISOString();

  let expiresAt = null;
  if (expires_in_days) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + expires_in_days);
    expiresAt = expDate.toISOString();
  }

  await c.env.DB.prepare(`
    INSERT INTO api_keys (id, organization_id, user_id, name, key_hash, key_preview, permissions, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    apiKeyId,
    org.id,
    user.id,
    name,
    keyHash,
    keyPreview,
    JSON.stringify(permissions),
    expiresAt,
    now
  ).run();

  return c.json({
    success: true,
    data: {
      id: apiKeyId,
      name,
      key: rawKey, // Only returned once!
      key_preview: keyPreview,
      permissions,
      expires_at: expiresAt,
      created_at: now
    },
    warning: 'Save this API key securely. It will not be shown again.'
  }, 201);
});

// Delete API key
organizations.delete('/:orgId/api-keys/:keyId', adminMiddleware, async (c) => {
  const org = c.get('organization');
  const keyId = c.req.param('keyId');

  const key = await c.env.DB.prepare(
    'SELECT * FROM api_keys WHERE id = ? AND organization_id = ?'
  ).bind(keyId, org.id).first();

  if (!key) {
    return c.json({ success: false, error: 'API key not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(keyId).run();

  return c.json({
    success: true,
    message: 'API key revoked successfully'
  });
});

export default organizations;

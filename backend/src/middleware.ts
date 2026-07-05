import { Context, Next } from 'hono';
import { Env, User, Organization, AuthContext } from './types';
import { verifyJWT } from './utils';

// Extend Hono context with auth
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
    user: User;
    organization: Organization;
  }
}

// Middleware to authenticate requests
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: No token provided' }, 401);
  }

  const token = authHeader.substring(7);
  
  try {
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    
    if (!payload || !payload.userId) {
      return c.json({ success: false, error: 'Unauthorized: Invalid token' }, 401);
    }

    // Get user from database
    const user = await c.env.DB.prepare(
      'SELECT id, email, name, avatar_url, email_verified, created_at, updated_at FROM users WHERE id = ?'
    ).bind(payload.userId).first<User>();

    if (!user) {
      return c.json({ success: false, error: 'Unauthorized: User not found' }, 401);
    }

    // Set user in context
    c.set('user', user);
    c.set('auth', { user });

    await next();
  } catch (error) {
    console.error('Auth error:', error);
    return c.json({ success: false, error: 'Unauthorized: Token verification failed' }, 401);
  }
}

// Middleware to authenticate and verify organization access
export async function orgAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  // First run the auth middleware
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: No token provided' }, 401);
  }

  const token = authHeader.substring(7);
  
  try {
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    
    if (!payload || !payload.userId) {
      return c.json({ success: false, error: 'Unauthorized: Invalid token' }, 401);
    }

    // Get user from database
    const user = await c.env.DB.prepare(
      'SELECT id, email, name, avatar_url, email_verified, created_at, updated_at FROM users WHERE id = ?'
    ).bind(payload.userId).first<User>();

    if (!user) {
      return c.json({ success: false, error: 'Unauthorized: User not found' }, 401);
    }

    c.set('user', user);

    // Get organization ID from params or header
    const orgId = c.req.param('orgId') || c.req.header('X-Organization-Id');
    
    if (!orgId) {
      // If no org specified, get user's first organization
      const membership = await c.env.DB.prepare(`
        SELECT om.organization_id, om.role, o.id as org_id, o.name, o.slug, o.logo_url, o.website_url, o.support_url, o.timezone, o.created_at, o.updated_at
        FROM organization_members om
        JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = ?
        ORDER BY om.created_at ASC
        LIMIT 1
      `).bind(user.id).first<{ organization_id: string; role: string; org_id: string; name: string; slug: string; logo_url: string; website_url: string; support_url: string; timezone: string; created_at: string; updated_at: string }>();

      if (membership) {
        c.set('organization', {
          id: membership.org_id,
          name: membership.name,
          slug: membership.slug,
          logo_url: membership.logo_url,
          website_url: membership.website_url,
          support_url: membership.support_url,
          timezone: membership.timezone,
          created_at: membership.created_at,
          updated_at: membership.updated_at
        } as Organization);
        c.set('auth', {
          user,
          organization: c.get('organization'),
          role: membership.role as 'owner' | 'admin' | 'member'
        });
      } else {
        c.set('auth', { user });
      }
    } else {
      // Verify user has access to the organization
      const membership = await c.env.DB.prepare(`
        SELECT om.role, o.* FROM organization_members om
        JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = ? AND om.organization_id = ?
      `).bind(user.id, orgId).first<{ role: string } & Organization>();

      if (!membership) {
        return c.json({ success: false, error: 'Forbidden: No access to this organization' }, 403);
      }

      c.set('organization', {
        id: membership.id,
        name: membership.name,
        slug: membership.slug,
        logo_url: membership.logo_url,
        website_url: membership.website_url,
        support_url: membership.support_url,
        timezone: membership.timezone,
        created_at: membership.created_at,
        updated_at: membership.updated_at
      } as Organization);
      c.set('auth', {
        user,
        organization: c.get('organization'),
        role: membership.role as 'owner' | 'admin' | 'member'
      });
    }

    await next();
  } catch (error) {
    console.error('Org auth error:', error);
    return c.json({ success: false, error: 'Authentication failed' }, 401);
  }
}

// Middleware to require admin or owner role
export async function adminMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get('auth');
  
  if (!auth || !auth.role || !['admin', 'owner'].includes(auth.role)) {
    return c.json({ success: false, error: 'Forbidden: Admin access required' }, 403);
  }

  await next();
}

// Middleware to require owner role
export async function ownerMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get('auth');
  
  if (!auth || auth.role !== 'owner') {
    return c.json({ success: false, error: 'Forbidden: Owner access required' }, 403);
  }

  await next();
}

// Optional auth middleware - doesn't fail if no token
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    try {
      const payload = await verifyJWT(token, c.env.JWT_SECRET);
      
      if (payload && payload.userId) {
        const user = await c.env.DB.prepare(
          'SELECT id, email, name, avatar_url, email_verified, created_at, updated_at FROM users WHERE id = ?'
        ).bind(payload.userId).first<User>();

        if (user) {
          c.set('user', user);
          c.set('auth', { user });
        }
      }
    } catch (error) {
      // Ignore auth errors for optional auth
    }
  }

  await next();
}

// ============ Rate Limiting Middleware ============

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix?: string;    // KV key prefix
}

// Rate limiting using Cloudflare KV
export function rateLimitMiddleware(config: RateLimitConfig) {
  const { windowMs, maxRequests, keyPrefix = 'ratelimit' } = config;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const cache = c.env.CACHE;
    if (!cache) {
      // If no KV, skip rate limiting
      await next();
      return;
    }

    // Get identifier: use user ID if authenticated, otherwise IP
    const user = c.get('user');
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const identifier = user?.id || ip;
    
    // Create time window key (rounded to nearest window)
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const key = `${keyPrefix}:${identifier}:${windowStart}`;

    try {
      // Get current count
      const currentData = await cache.get(key);
      const current = currentData ? parseInt(currentData, 10) : 0;

      // Set rate limit headers
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', Math.max(0, maxRequests - current - 1).toString());
      c.header('X-RateLimit-Reset', (windowStart + windowMs).toString());

      if (current >= maxRequests) {
        c.header('Retry-After', Math.ceil((windowStart + windowMs - Date.now()) / 1000).toString());
        return c.json({
          success: false,
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Please try again in ${Math.ceil((windowStart + windowMs - Date.now()) / 1000)} seconds.`
        }, 429);
      }

      // Increment counter
      await cache.put(key, (current + 1).toString(), {
        expirationTtl: Math.ceil(windowMs / 1000) + 60 // Add 60s buffer
      });

      await next();
    } catch (error) {
      console.error('Rate limit error:', error);
      // On error, allow the request but log
      await next();
    }
  };
}

// Pre-configured rate limiters
export const publicRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 60,      // 60 requests per minute for public endpoints
  keyPrefix: 'rl:public'
});

export const authRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 120,     // 120 requests per minute for authenticated users
  keyPrefix: 'rl:auth'
});

export const strictRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 10,      // 10 requests per minute for sensitive endpoints (login, register)
  keyPrefix: 'rl:strict'
});

export const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 30,      // 30 webhook calls per minute
  keyPrefix: 'rl:webhook'
});


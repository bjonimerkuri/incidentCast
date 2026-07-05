import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { Env } from './types';
import { publicRateLimit, authRateLimit, strictRateLimit } from './middleware';

// Import routes
import auth from './routes/auth';
import organizations from './routes/organizations';
import statusPages from './routes/status-pages';
import components from './routes/components';
import incidents from './routes/incidents';
import subscribers from './routes/subscribers';
import webhooks from './routes/webhooks';
import externalApi from './routes/external-api';
import ai from './routes/ai';
import uptime from './routes/uptime';
import incidentReports from './routes/incident-reports';
import integrations from './routes/integrations';
import playbooks from './routes/playbooks';

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: (origin) => {
    // Allow localhost for development
    if (origin?.includes('localhost') || origin?.includes('127.0.0.1')) {
      return origin;
    }
    // In production, specify your domains
    return origin || '*';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'IncidentCast API',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Apply rate limiting to auth routes (strict for login/register)
app.use('/api/auth/login', strictRateLimit);
app.use('/api/auth/register', strictRateLimit);
app.use('/api/auth/*', publicRateLimit);

// Apply rate limiting to public routes
app.use('/api/status-pages/public/*', publicRateLimit);

// Apply rate limiting to authenticated routes
app.use('/api/organizations/*', authRateLimit);
app.use('/api/components/*', authRateLimit);
app.use('/api/incidents/*', authRateLimit);
app.use('/api/subscribers/*', authRateLimit);
app.use('/api/webhooks/*', authRateLimit);
app.use('/api/ai/*', authRateLimit);
app.use('/api/uptime/*', authRateLimit);
app.use('/api/integrations/*', authRateLimit);
app.use('/api/playbooks/*', authRateLimit);

// API Routes
app.route('/api/auth', auth);
app.route('/api/organizations', organizations);
app.route('/api/status-pages', statusPages);
app.route('/api/components', components);
app.route('/api/incidents', incidents);
app.route('/api/subscribers', subscribers);
app.route('/api/webhooks', webhooks);
app.route('/api/v1', externalApi); // External API for monitoring tools
app.route('/api/ai', ai); // AI-powered features
app.route('/api/uptime', uptime); // Uptime tracking
app.route('/api/incident-reports', incidentReports); // End-user incident reporting
app.route('/api/integrations', integrations); // Third-party integrations
app.route('/api/playbooks', playbooks); // Incident playbooks/runbooks

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Not Found',
    message: `Route ${c.req.method} ${c.req.path} not found`
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('API Error:', err);
  
  // Handle Zod validation errors
  if (err.message.includes('Validation')) {
    return c.json({
      success: false,
      error: 'Validation Error',
      message: err.message
    }, 400);
  }

  return c.json({
    success: false,
    error: 'Internal Server Error',
    message: 'An unexpected error occurred'
  }, 500);
});

export default app;


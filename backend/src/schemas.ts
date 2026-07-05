// Validation schemas for IncidentCast API
import { z } from 'zod';

// Auth schemas
export const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  organizationName: z.string().min(2, 'Organization name must be at least 2 characters').max(100).optional()
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address')
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters')
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters')
});

// Organization schemas
export const createOrganizationSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  website_url: z.string().url().optional().or(z.literal('')),
  support_url: z.string().url().optional().or(z.literal('')),
  timezone: z.string().default('UTC')
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  website_url: z.string().url().optional().or(z.literal('')).or(z.null()),
  support_url: z.string().url().optional().or(z.literal('')).or(z.null()),
  timezone: z.string().optional(),
  logo_url: z.string().url().optional().or(z.literal('')).or(z.null())
});

export const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(['admin', 'member']).default('member')
});

// Status page schemas
export const createStatusPageSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  subdomain: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/, 'Subdomain can only contain lowercase letters, numbers, and hyphens').optional(),
  description: z.string().max(500).optional(),
  is_public: z.boolean().default(true)
});

export const updateStatusPageSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  subdomain: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/, 'Subdomain can only contain lowercase letters, numbers, and hyphens').optional(),
  description: z.string().max(500).optional(),
  logo_url: z.string().url().optional().or(z.literal('')),
  favicon_url: z.string().url().optional().or(z.literal('')),
  header_bg_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  header_text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  show_subscribe_button: z.boolean().optional(),
  show_incident_history_days: z.number().min(1).max(365).optional(),
  google_analytics_id: z.string().optional(),
  custom_css: z.string().max(10000).optional(),
  custom_html_head: z.string().max(5000).optional(),
  is_public: z.boolean().optional(),
  custom_domain: z.string().optional().or(z.literal(''))
});

// Component group schemas
export const createComponentGroupSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  description: z.string().max(500).optional(),
  display_order: z.number().int().min(0).default(0),
  collapsed_by_default: z.boolean().default(false)
});

export const updateComponentGroupSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  display_order: z.number().int().min(0).optional(),
  collapsed_by_default: z.boolean().optional()
});

// Component schemas
export const componentStatusSchema = z.enum([
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance'
]);

export const createComponentSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  description: z.string().max(500).optional(),
  group_id: z.string().optional(),
  status: componentStatusSchema.default('operational'),
  display_order: z.number().int().min(0).default(0),
  show_uptime: z.boolean().default(true),
  start_date: z.string().optional()
});

export const updateComponentSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  group_id: z.string().nullable().optional(),
  status: componentStatusSchema.optional(),
  display_order: z.number().int().min(0).optional(),
  show_uptime: z.boolean().optional(),
  start_date: z.string().optional()
});

// Incident schemas
export const incidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring', 'resolved']);
export const incidentImpactSchema = z.enum(['none', 'minor', 'major', 'critical']);

export const createIncidentSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(200),
  status: incidentStatusSchema.default('investigating'),
  impact: incidentImpactSchema.default('minor'),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  component_ids: z.array(z.string()).optional(),
  component_status: componentStatusSchema.optional(),
  notify_subscribers: z.boolean().default(true)
});

export const updateIncidentSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  status: incidentStatusSchema.optional(),
  impact: incidentImpactSchema.optional(),
  message: z.string().min(10).max(5000).optional(),
  component_ids: z.array(z.string()).optional(),
  component_status: componentStatusSchema.optional(),
  notify_subscribers: z.boolean().default(true),
  scheduled_for: z.string().datetime().optional(),
  scheduled_until: z.string().datetime().optional()
});

export const addIncidentUpdateSchema = z.object({
  status: incidentStatusSchema,
  message: z.string().min(1, 'Message is required').max(5000),
  component_status: componentStatusSchema.optional(),
  notify_subscribers: z.boolean().default(true)
});

// Scheduled maintenance schemas
export const maintenanceStatusSchema = z.enum(['scheduled', 'in_progress', 'verifying', 'completed']);

export const createMaintenanceSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(200),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  scheduled_for: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'Invalid date format' }),
  scheduled_until: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'Invalid date format' }),
  component_ids: z.array(z.string()).optional(),
  notify_subscribers: z.boolean().default(true)
});

export const updateMaintenanceSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  status: maintenanceStatusSchema.optional(),
  message: z.string().min(10).max(5000).optional(),
  scheduled_for: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'Invalid date format' }).optional(),
  scheduled_until: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'Invalid date format' }).optional(),
  component_ids: z.array(z.string()).optional(),
  notify_subscribers: z.boolean().default(true)
});

// Subscriber schemas
export const subscribeSchema = z.object({
  email: z.string().email('Invalid email address'),
  component_ids: z.array(z.string()).optional(),
  notify_incidents: z.boolean().default(true),
  notify_maintenance: z.boolean().default(true),
  skip_verification: z.boolean().default(false)
});

export const updateSubscriberSchema = z.object({
  component_ids: z.array(z.string()).optional(),
  notify_incidents: z.boolean().optional(),
  notify_maintenance: z.boolean().optional()
});

// API Key schemas
export const createApiKeySchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  permissions: z.array(z.enum(['read', 'write', 'admin'])).default(['read']),
  expires_at: z.string().datetime().optional()
});

// User profile schemas
export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  avatar_url: z.string().url().optional().or(z.literal(''))
});

// Pagination schema
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

// Type exports
export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateStatusPageInput = z.infer<typeof createStatusPageSchema>;
export type UpdateStatusPageInput = z.infer<typeof updateStatusPageSchema>;
export type CreateComponentGroupInput = z.infer<typeof createComponentGroupSchema>;
export type UpdateComponentGroupInput = z.infer<typeof updateComponentGroupSchema>;
export type CreateComponentInput = z.infer<typeof createComponentSchema>;
export type UpdateComponentInput = z.infer<typeof updateComponentSchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type AddIncidentUpdateInput = z.infer<typeof addIncidentUpdateSchema>;
export type CreateMaintenanceInput = z.infer<typeof createMaintenanceSchema>;
export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;
export type SubscribeInput = z.infer<typeof subscribeSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

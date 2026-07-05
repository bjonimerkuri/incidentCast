// Type definitions for IncidentCast API

// Cloudflare AI binding type
interface AI {
  run(model: string, inputs: any): Promise<any>;
}

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  FRONTEND_URL: string;
  API_URL: string;
  AI?: AI;
  BREVO_API_KEY?: string;
  BREVO_FROM_EMAIL?: string;
  EMAIL_FROM?: string;
}

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserWithPassword extends User {
  password_hash: string;
}

// Organization types
export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url?: string;
  website_url?: string;
  support_url?: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

// Status page types
export interface StatusPage {
  id: string;
  organization_id: string;
  name: string;
  subdomain: string;
  custom_domain?: string;
  description?: string;
  logo_url?: string;
  favicon_url?: string;
  header_bg_color: string;
  header_text_color: string;
  accent_color: string;
  show_subscribe_button: boolean;
  show_incident_history_days: number;
  google_analytics_id?: string;
  custom_css?: string;
  custom_html_head?: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

// Component types
export interface ComponentGroup {
  id: string;
  status_page_id: string;
  name: string;
  description?: string;
  display_order: number;
  collapsed_by_default: boolean;
  created_at: string;
  updated_at: string;
}

export type ComponentStatus = 
  | 'operational' 
  | 'degraded_performance' 
  | 'partial_outage' 
  | 'major_outage' 
  | 'under_maintenance';

export interface Component {
  id: string;
  status_page_id: string;
  group_id?: string;
  name: string;
  description?: string;
  status: ComponentStatus;
  display_order: number;
  show_uptime: boolean;
  start_date?: string;
  created_at: string;
  updated_at: string;
}

// Incident types
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';
export type MaintenanceStatus = 'scheduled' | 'in_progress' | 'verifying' | 'completed';

export interface Incident {
  id: string;
  status_page_id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
  scheduled_for?: string;
  scheduled_until?: string;
  is_scheduled: boolean;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  user_id?: string;
  status: IncidentStatus | MaintenanceStatus;
  message: string;
  created_at: string;
}

export interface IncidentComponent {
  id: string;
  incident_id: string;
  component_id: string;
  status: ComponentStatus;
}

// Subscriber types
export interface Subscriber {
  id: string;
  status_page_id: string;
  email: string;
  phone?: string;
  webhook_url?: string;
  is_verified: boolean;
  verification_token?: string;
  unsubscribe_token: string;
  notify_incidents: boolean;
  notify_maintenance: boolean;
  created_at: string;
}

// Component metrics
export interface ComponentMetric {
  id: string;
  component_id: string;
  date: string;
  uptime_percentage: number;
  total_incidents: number;
  total_downtime_minutes: number;
}

// API Key types
export interface ApiKey {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_preview: string;
  permissions: string[];
  last_used_at?: string;
  expires_at?: string;
  created_at: string;
}

// Session types
export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

// Audit log types
export interface AuditLog {
  id: string;
  organization_id: string;
  user_id?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_data?: string;
  new_data?: string;
  ip_address?: string;
  created_at: string;
}

// Auth context
export interface AuthContext {
  user: User;
  organization?: Organization;
  role?: 'owner' | 'admin' | 'member';
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Public status page data
export interface PublicStatusPageData {
  page: StatusPage;
  components: (Component & { group?: ComponentGroup })[];
  groups: ComponentGroup[];
  activeIncidents: (Incident & { updates: IncidentUpdate[]; affected_components: Component[] })[];
  scheduledMaintenance: (Incident & { updates: IncidentUpdate[]; affected_components: Component[] })[];
  overallStatus: ComponentStatus;
}

export interface IncidentHistoryItem {
  date: string;
  incidents: (Incident & { updates: IncidentUpdate[] })[];
}

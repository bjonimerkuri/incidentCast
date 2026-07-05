// Handles email notifications and queue processing
import { Env } from '../types';
import { generateId } from '../utils';

interface NotificationPayload {
  status_page_id: string;
  subscriber_id: string;
  type: 'email' | 'sms' | 'webhook';
  subject: string;
  body: string;
  metadata?: Record<string, any>;
}

interface Subscriber {
  id: string;
  status_page_id: string;
  email: string;
  phone: string | null;
  is_verified: boolean;
  notification_types: string;
  created_at: string;
}

// Queue a notification for sending
export async function queueNotification(
  db: D1Database,
  payload: NotificationPayload
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO notification_queue (id, status_page_id, subscriber_id, type, subject, body, metadata, status, attempts, scheduled_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).bind(
    id,
    payload.status_page_id,
    payload.subscriber_id,
    payload.type,
    payload.subject,
    payload.body,
    JSON.stringify(payload.metadata || {}),
    now,
    now
  ).run();

  return id;
}

// Queue notifications for all subscribers of a status page
export async function notifyAllSubscribers(
  db: D1Database,
  statusPageId: string,
  subject: string,
  body: string,
  metadata?: Record<string, any>
): Promise<number> {
  const subscribers = await db.prepare(`
    SELECT * FROM subscribers 
    WHERE status_page_id = ? AND is_verified = 1
  `).bind(statusPageId).all<Subscriber>();

  let queued = 0;

  for (const subscriber of subscribers.results) {
    const notifTypes = JSON.parse(subscriber.notification_types || '["email"]');
    
    for (const type of notifTypes) {
      if (type === 'email' && subscriber.email) {
        await queueNotification(db, {
          status_page_id: statusPageId,
          subscriber_id: subscriber.id,
          type: 'email',
          subject,
          body,
          metadata
        });
        queued++;
      }
    }
  }

  return queued;
}

// Process pending notifications (called by scheduled worker)
export async function processNotificationQueue(env: Env): Promise<{ processed: number; failed: number }> {
  const now = new Date().toISOString();
  const pending = await env.DB.prepare(`
    SELECT nq.*, s.email, s.phone
    FROM notification_queue nq
    JOIN subscribers s ON s.id = nq.subscriber_id
    WHERE nq.status = 'pending' 
      AND nq.scheduled_for <= ?
      AND nq.attempts < 3
    ORDER BY nq.scheduled_for ASC
    LIMIT 50
  `).bind(now).all<{
    id: string;
    type: string;
    subject: string;
    body: string;
    email: string;
    phone: string | null;
  }>();

  let processed = 0;
  let failed = 0;

  for (const notification of pending.results) {
    try {
      // Mark as processing
      await env.DB.prepare(`
        UPDATE notification_queue 
        SET status = 'processing', attempts = attempts + 1 
        WHERE id = ?
      `).bind(notification.id).run();

      // Send based on type
      if (notification.type === 'email') {
        await sendEmail(env, notification.email, notification.subject, notification.body);
      }

      // Mark as sent
      await env.DB.prepare(`
        UPDATE notification_queue 
        SET status = 'sent', sent_at = datetime('now') 
        WHERE id = ?
      `).bind(notification.id).run();

      processed++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Mark as failed or retry
      await env.DB.prepare(`
        UPDATE notification_queue 
        SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
            last_error = ?
        WHERE id = ?
      `).bind(errorMessage, notification.id).run();

      failed++;
    }
  }

  return { processed, failed };
}

// Send email using Brevo (SendinBlue)
async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  if (env.BREVO_API_KEY) {
    const fromEmail = env.BREVO_FROM_EMAIL || env.EMAIL_FROM || 'noreply@incidentcast.com';
    const fromName = 'IncidentCast';
    const fromAddr = fromEmail.includes('<') ? fromEmail.split('<')[1].replace('>', '').trim() : fromEmail;

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY!,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromAddr },
        to: [{ email: to }],
        subject,
        htmlContent: body
      })
    });

    if (response.ok) return;

    const error = await response.text();
    throw new Error(`Brevo email failed: ${error}`);
  }

  // No email provider configured - log for development
  console.log('Email would be sent (no BREVO_API_KEY configured):', { to, subject });
}

// Generate email templates
export function generateIncidentEmail(
  incident: {
    title: string;
    status: string;
    message: string;
    impact: string;
  },
  statusPageName: string,
  statusPageUrl: string
): { subject: string; body: string } {
  const statusColors: Record<string, string> = {
    investigating: '#f59e0b',
    identified: '#3b82f6',
    monitoring: '#8b5cf6',
    resolved: '#10b981'
  };

  const impactColors: Record<string, string> = {
    none: '#6b7280',
    minor: '#f59e0b',
    major: '#ef4444',
    critical: '#dc2626'
  };

  const subject = `[${statusPageName}] ${incident.status === 'resolved' ? 'Resolved: ' : ''}${incident.title}`;

  const body = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${statusPageName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Status Update</p>
      </div>
      
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="margin-bottom: 20px;">
          <span style="display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; background: ${statusColors[incident.status] || '#6b7280'}; text-transform: uppercase;">
            ${incident.status}
          </span>
          <span style="display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; background: ${impactColors[incident.impact] || '#6b7280'}; text-transform: uppercase; margin-left: 8px;">
            ${incident.impact} impact
          </span>
        </div>

        <h2 style="margin: 0 0 15px 0; color: #111827; font-size: 20px;">${incident.title}</h2>
        
        <div style="background: #f9fafb; padding: 15px; border-radius: 8px; border-left: 4px solid ${statusColors[incident.status] || '#6b7280'};">
          <p style="margin: 0; color: #374151; line-height: 1.6;">${incident.message}</p>
        </div>

        <p style="margin: 25px 0 0 0; text-align: center;">
          <a href="${statusPageUrl}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
            View Status Page
          </a>
        </p>
      </div>

      <p style="text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px;">
        You're receiving this because you subscribed to ${statusPageName} updates.<br>
        <a href="${statusPageUrl}/unsubscribe" style="color: #6b7280;">Unsubscribe</a>
      </p>
    </body>
    </html>
  `;

  return { subject, body };
}

export function generateMaintenanceEmail(
  maintenance: {
    title: string;
    description: string;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
  },
  statusPageName: string,
  statusPageUrl: string
): { subject: string; body: string } {
  const startDate = new Date(maintenance.scheduled_start).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const endDate = new Date(maintenance.scheduled_end).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const subject = `[${statusPageName}] Scheduled Maintenance: ${maintenance.title}`;

  const body = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
      <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${statusPageName}</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Scheduled Maintenance</p>
      </div>
      
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="margin: 0 0 15px 0; color: #111827; font-size: 20px;">${maintenance.title}</h2>
        
        <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <p style="margin: 0 0 10px 0; color: #1e40af;">
            <strong>🕐 Start:</strong> ${startDate}
          </p>
          <p style="margin: 0; color: #1e40af;">
            <strong>🕐 End:</strong> ${endDate}
          </p>
        </div>

        <div style="background: #f9fafb; padding: 15px; border-radius: 8px;">
          <p style="margin: 0; color: #374151; line-height: 1.6;">${maintenance.description}</p>
        </div>

        <p style="margin: 25px 0 0 0; text-align: center;">
          <a href="${statusPageUrl}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
            View Status Page
          </a>
        </p>
      </div>

      <p style="text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px;">
        You're receiving this because you subscribed to ${statusPageName} updates.<br>
        <a href="${statusPageUrl}/unsubscribe" style="color: #6b7280;">Unsubscribe</a>
      </p>
    </body>
    </html>
  `;

  return { subject, body };
}

// Notify subscribers about an incident
export async function notifyIncident(
  db: D1Database,
  incident: {
    id: string;
    title: string;
    status: string;
    impact: string;
    status_page_id: string;
  },
  message: string,
  statusPage: {
    name: string;
    subdomain: string;
    custom_domain?: string | null;
  }
): Promise<number> {
  const statusPageUrl = statusPage.custom_domain 
    ? `https://${statusPage.custom_domain}`
    : `https://${statusPage.subdomain}.incidentcast.com`;

  const { subject, body } = generateIncidentEmail(
    { ...incident, message },
    statusPage.name,
    statusPageUrl
  );

  return notifyAllSubscribers(db, incident.status_page_id, subject, body, {
    type: 'incident',
    incident_id: incident.id,
    status: incident.status
  });
}

// Notify subscribers about scheduled maintenance
export async function notifyMaintenance(
  db: D1Database,
  maintenance: {
    id: string;
    title: string;
    description: string;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
    status_page_id: string;
  },
  statusPage: {
    name: string;
    subdomain: string;
    custom_domain?: string | null;
  }
): Promise<number> {
  const statusPageUrl = statusPage.custom_domain 
    ? `https://${statusPage.custom_domain}`
    : `https://${statusPage.subdomain}.incidentcast.com`;

  const { subject, body } = generateMaintenanceEmail(
    maintenance,
    statusPage.name,
    statusPageUrl
  );

  return notifyAllSubscribers(db, maintenance.status_page_id, subject, body, {
    type: 'maintenance',
    maintenance_id: maintenance.id,
    status: maintenance.status
  });
}

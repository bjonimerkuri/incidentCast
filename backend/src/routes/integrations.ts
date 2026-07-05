import { Hono } from 'hono';
import { Env, Organization } from '../types';
import { orgAuthMiddleware } from '../middleware';

const integrations = new Hono<{ Bindings: Env }>();

// All routes require org auth
integrations.use('*', orgAuthMiddleware);

// ============ Integration Settings ============

// Get all integrations for organization
integrations.get('/', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;

  try {
    const results = await db.prepare(`
      SELECT * FROM integrations WHERE organization_id = ?
    `).bind(orgId).all();

    return c.json({ success: true, data: results.results });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch integrations' }, 500);
  }
});

// Get specific integration (must exclude email-templates to avoid route conflict)
integrations.get('/:type', async (c, next) => {
  const type = c.req.param('type');
  // Skip this handler for email-templates paths - they have their own routes
  if (type === 'email-templates') {
    return next();
  }
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;

  try {
    const integration = await db.prepare(`
      SELECT * FROM integrations WHERE organization_id = ? AND type = ?
    `).bind(orgId, type).first();

    return c.json({ success: true, data: integration });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch integration' }, 500);
  }
});

// Create or update integration (must exclude email-templates to avoid route conflict)
integrations.put('/:type', async (c, next) => {
  const type = c.req.param('type');
  // Skip this handler for email-templates paths
  if (type === 'email-templates') {
    return next();
  }
  
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;
  const body = await c.req.json();
  const { webhook_url, channel, enabled, settings } = body;

  try {
    const existing = await db.prepare(`
      SELECT id FROM integrations WHERE organization_id = ? AND type = ?
    `).bind(orgId, type).first();

    const id = existing?.id || crypto.randomUUID();
    const now = new Date().toISOString();

    if (existing) {
      await db.prepare(`
        UPDATE integrations 
        SET webhook_url = ?, channel = ?, enabled = ?, settings = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        webhook_url,
        channel || null,
        enabled ? 1 : 0,
        settings ? JSON.stringify(settings) : null,
        now,
        id
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO integrations (id, organization_id, type, webhook_url, channel, enabled, settings, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        orgId,
        type,
        webhook_url,
        channel || null,
        enabled ? 1 : 0,
        settings ? JSON.stringify(settings) : null,
        now,
        now
      ).run();
    }

    const integration = await db.prepare(`
      SELECT * FROM integrations WHERE id = ?
    `).bind(id).first();

    return c.json({ success: true, data: integration });
  } catch (error) {
    console.error('Integration save error:', error);
    return c.json({ success: false, error: 'Failed to save integration' }, 500);
  }
});

// Test integration (must exclude email-templates to avoid route conflict)
integrations.post('/:type/test', async (c, next) => {
  const type = c.req.param('type');
  // Skip this handler for email-templates paths
  if (type === 'email-templates') {
    return next();
  }
  
  const body = await c.req.json();
  const { webhook_url } = body;

  if (!webhook_url) {
    return c.json({ success: false, error: 'Webhook URL is required' }, 400);
  }

  try {
    let payload: any;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (type === 'slack') {
      payload = {
        text: '🔔 IncidentCast Test Notification',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '✅ Integration Test Successful',
              emoji: true
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Your Slack integration with IncidentCast is working correctly! You will receive notifications here when incidents are created or updated.'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `_Sent from IncidentCast at ${new Date().toISOString()}_`
              }
            ]
          }
        ]
      };
    } else if (type === 'teams') {
      payload = {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: '22c55e',
        summary: 'IncidentCast Test Notification',
        sections: [{
          activityTitle: '✅ Integration Test Successful',
          activitySubtitle: 'Your Microsoft Teams integration is working correctly!',
          facts: [{
            name: 'Status',
            value: 'Connected'
          }, {
            name: 'Time',
            value: new Date().toISOString()
          }],
          text: 'You will receive notifications here when incidents are created or updated.'
        }]
      };
    } else {
      return c.json({ success: false, error: 'Unknown integration type' }, 400);
    }

    const response = await fetch(webhook_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      return c.json({ success: false, error: `Webhook returned ${response.status}: ${text}` }, 400);
    }

    return c.json({ success: true, message: 'Test notification sent successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Failed to send test notification' }, 500);
  }
});

// Delete integration (must exclude email-templates to avoid route conflict)
integrations.delete('/:type', async (c, next) => {
  const type = c.req.param('type');
  // Skip this handler for email-templates paths
  if (type === 'email-templates') {
    return next();
  }
  
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;

  try {
    await db.prepare(`
      DELETE FROM integrations WHERE organization_id = ? AND type = ?
    `).bind(orgId, type).run();

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to delete integration' }, 500);
  }
});

// ============ Email Templates ============

// Get email templates
integrations.get('/email-templates/all', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;

  try {
    const results = await db.prepare(`
      SELECT * FROM email_templates WHERE organization_id = ?
    `).bind(orgId).all();

    return c.json({ success: true, data: results.results });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch email templates' }, 500);
  }
});

// Get single email template
integrations.get('/email-templates/:templateType', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  
  if (!org || !org.id) {
    return c.json({ success: false, error: 'Organization not found' }, 401);
  }
  
  const orgId = org.id;
  const templateType = c.req.param('templateType');

  try {
    const template = await db.prepare(`
      SELECT * FROM email_templates WHERE organization_id = ? AND template_type = ?
    `).bind(orgId, templateType).first();

    // Return default template if none exists
    if (!template) {
      const defaults = getDefaultTemplate(templateType);
      return c.json({ success: true, data: { ...defaults, template_type: templateType, is_default: true } });
    }

    return c.json({ success: true, data: template });
  } catch (error: any) {
    console.error('Email template fetch error:', error);
    return c.json({ success: false, error: 'Failed to fetch email template', details: error?.message }, 500);
  }
});

// Save email template
integrations.put('/email-templates/:templateType', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;
  const templateType = c.req.param('templateType');
  const body = await c.req.json();
  const { subject, body_html, body_text } = body;

  try {
    const existing = await db.prepare(`
      SELECT id FROM email_templates WHERE organization_id = ? AND template_type = ?
    `).bind(orgId, templateType).first();

    const id = existing?.id || crypto.randomUUID();
    const now = new Date().toISOString();

    if (existing) {
      await db.prepare(`
        UPDATE email_templates 
        SET subject = ?, body_html = ?, body_text = ?, updated_at = ?
        WHERE id = ?
      `).bind(subject, body_html, body_text || null, now, id).run();
    } else {
      await db.prepare(`
        INSERT INTO email_templates (id, organization_id, template_type, subject, body_html, body_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, orgId, templateType, subject, body_html, body_text || null, now, now).run();
    }

    const template = await db.prepare(`
      SELECT * FROM email_templates WHERE id = ?
    `).bind(id).first();

    return c.json({ success: true, data: template });
  } catch (error) {
    console.error('Template save error:', error);
    return c.json({ success: false, error: 'Failed to save email template' }, 500);
  }
});

// Generate AI email template
integrations.post('/email-templates/:templateType/generate', async (c) => {
  const templateType = c.req.param('templateType');
  const body = await c.req.json();
  const { tone, instructions } = body;

  try {
    const ai = c.env.AI;
    if (!ai) {
      return c.json({ success: false, error: 'AI service not available' }, 503);
    }
    
    const templateDescriptions: Record<string, string> = {
      'incident_created': 'notification email sent when a new incident is reported',
      'incident_updated': 'notification email sent when an incident status is updated',
      'incident_resolved': 'notification email sent when an incident is resolved',
      'maintenance_scheduled': 'notification email sent when maintenance is scheduled',
      'maintenance_started': 'notification email sent when maintenance begins',
      'maintenance_completed': 'notification email sent when maintenance is completed'
    };

    const prompt = `Generate a professional email template for a status page notification system.

Template Type: ${templateType.replace(/_/g, ' ')}
Description: ${templateDescriptions[templateType] || 'status update notification'}
Tone: ${tone || 'professional and reassuring'}
${instructions ? `Additional Instructions: ${instructions}` : ''}

Available variables you MUST use (wrap in double curly braces):
- {{incident_title}} or {{maintenance_title}} - the title
- {{status}} - current status (investigating, identified, monitoring, resolved)
- {{message}} - the update message
- {{status_page_url}} - link to status page
- {{company_name}} - the company name
- {{date}} - the date/time

Generate ONLY a JSON object with these fields (no markdown, no explanation):
{
  "subject": "the email subject line with variables",
  "body_html": "the HTML email body with proper formatting and variables",
  "body_text": "plain text version of the email"
}`;

    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are an expert email copywriter specializing in IT communications and incident management. Generate professional, clear, and empathetic email templates. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1500
    }) as { response: string };

    // Parse the AI response
    let template;
    try {
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        template = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', response.response);
      return c.json({ success: false, error: 'Failed to generate template. Please try again.' }, 500);
    }

    return c.json({ success: true, data: template });
  } catch (error: any) {
    console.error('AI generation error:', error);
    return c.json({ success: false, error: 'Failed to generate template' }, 500);
  }
});

// Reset template to default
integrations.post('/email-templates/:templateType/reset', async (c) => {
  const db = c.env.DB;
  const org = c.get('organization') as Organization;
  const orgId = org.id;
  const templateType = c.req.param('templateType');

  try {
    await db.prepare(`
      DELETE FROM email_templates WHERE organization_id = ? AND template_type = ?
    `).bind(orgId, templateType).run();

    const defaults = getDefaultTemplate(templateType);
    return c.json({ success: true, data: { ...defaults, template_type: templateType, is_default: true } });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to reset template' }, 500);
  }
});

// Helper: Default templates
function getDefaultTemplate(templateType: string): { subject: string; body_html: string; body_text: string } {
  const defaults: Record<string, { subject: string; body_html: string; body_text: string }> = {
    'incident_created': {
      subject: '[{{company_name}}] New Incident: {{incident_title}}',
      body_html: `<h2>New Incident Reported</h2>
<p><strong>{{incident_title}}</strong></p>
<p>Status: <strong>{{status}}</strong></p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>
<p>We will keep you updated on our progress.</p>`,
      body_text: `New Incident Reported\n\n{{incident_title}}\n\nStatus: {{status}}\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    },
    'incident_updated': {
      subject: '[{{company_name}}] Update: {{incident_title}}',
      body_html: `<h2>Incident Update</h2>
<p><strong>{{incident_title}}</strong></p>
<p>Status: <strong>{{status}}</strong></p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>`,
      body_text: `Incident Update\n\n{{incident_title}}\n\nStatus: {{status}}\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    },
    'incident_resolved': {
      subject: '[{{company_name}}] Resolved: {{incident_title}}',
      body_html: `<h2>Incident Resolved</h2>
<p><strong>{{incident_title}}</strong></p>
<p>This incident has been resolved.</p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>
<p>Thank you for your patience.</p>`,
      body_text: `Incident Resolved\n\n{{incident_title}}\n\nThis incident has been resolved.\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    },
    'maintenance_scheduled': {
      subject: '[{{company_name}}] Scheduled Maintenance: {{maintenance_title}}',
      body_html: `<h2>Scheduled Maintenance</h2>
<p><strong>{{maintenance_title}}</strong></p>
<p>Scheduled for: <strong>{{date}}</strong></p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>`,
      body_text: `Scheduled Maintenance\n\n{{maintenance_title}}\n\nScheduled for: {{date}}\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    },
    'maintenance_started': {
      subject: '[{{company_name}}] Maintenance Started: {{maintenance_title}}',
      body_html: `<h2>Maintenance In Progress</h2>
<p><strong>{{maintenance_title}}</strong></p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>`,
      body_text: `Maintenance In Progress\n\n{{maintenance_title}}\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    },
    'maintenance_completed': {
      subject: '[{{company_name}}] Maintenance Completed: {{maintenance_title}}',
      body_html: `<h2>Maintenance Completed</h2>
<p><strong>{{maintenance_title}}</strong></p>
<p>The scheduled maintenance has been completed.</p>
<p>{{message}}</p>
<p><a href="{{status_page_url}}">View Status Page</a></p>`,
      body_text: `Maintenance Completed\n\n{{maintenance_title}}\n\nThe scheduled maintenance has been completed.\n\n{{message}}\n\nView Status Page: {{status_page_url}}`
    }
  };

  return defaults[templateType] || defaults['incident_updated'];
}

// ============ Send to Integrations ============

// Helper function to send notifications to all enabled integrations
export async function sendToIntegrations(
  db: D1Database,
  orgId: string,
  event: {
    type: 'incident_created' | 'incident_updated' | 'incident_resolved' | 'maintenance_scheduled' | 'maintenance_started' | 'maintenance_completed';
    title: string;
    status: string;
    message: string;
    impact?: string;
    url?: string;
  }
) {
  try {
    const integrationsList = await db.prepare(`
      SELECT * FROM integrations WHERE organization_id = ? AND enabled = 1
    `).bind(orgId).all();

    for (const integration of integrationsList.results as any[]) {
      try {
        if (integration.type === 'slack') {
          await sendSlackNotification(integration.webhook_url, event);
        } else if (integration.type === 'teams') {
          await sendTeamsNotification(integration.webhook_url, event);
        }
      } catch (error) {
        console.error(`Failed to send to ${integration.type}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to fetch integrations:', error);
  }
}

async function sendSlackNotification(webhookUrl: string, event: any) {
  const colorMap: Record<string, string> = {
    investigating: '#f59e0b',
    identified: '#3b82f6',
    monitoring: '#8b5cf6',
    resolved: '#22c55e',
    scheduled: '#6b7280',
    in_progress: '#f59e0b',
    completed: '#22c55e'
  };

  const emojiMap: Record<string, string> = {
    incident_created: '🔴',
    incident_updated: '🟡',
    incident_resolved: '✅',
    maintenance_scheduled: '🔧',
    maintenance_started: '⚙️',
    maintenance_completed: '✅'
  };

  const payload = {
    attachments: [{
      color: colorMap[event.status] || '#6b7280',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emojiMap[event.type] || '📢'} ${event.title}`,
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Status:*\n${event.status.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}`
            },
            {
              type: 'mrkdwn',
              text: `*Type:*\n${event.type.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: event.message
          }
        },
        ...(event.url ? [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Status Page',
              emoji: true
            },
            url: event.url,
            action_id: 'view_status'
          }]
        }] : [])
      ]
    }]
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function sendTeamsNotification(webhookUrl: string, event: any) {
  const colorMap: Record<string, string> = {
    investigating: 'f59e0b',
    identified: '3b82f6',
    monitoring: '8b5cf6',
    resolved: '22c55e',
    scheduled: '6b7280',
    in_progress: 'f59e0b',
    completed: '22c55e'
  };

  const payload = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: colorMap[event.status] || '6b7280',
    summary: event.title,
    sections: [{
      activityTitle: event.title,
      activitySubtitle: event.type.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      facts: [{
        name: 'Status',
        value: event.status.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
      }],
      text: event.message,
      markdown: true
    }],
    potentialAction: event.url ? [{
      '@type': 'OpenUri',
      name: 'View Status Page',
      targets: [{
        os: 'default',
        uri: event.url
      }]
    }] : []
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export default integrations;

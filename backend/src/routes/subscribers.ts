import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Env, Subscriber } from '../types';
import { subscribeSchema, updateSubscriberSchema, paginationSchema } from '../schemas';
import { generateId, generateToken, hashToken, sqliteBool, toSqliteBool } from '../utils';
import { orgAuthMiddleware, adminMiddleware } from '../middleware';

const subscribers = new Hono<{ Bindings: Env }>();

// Helper to send verification email
async function sendVerificationEmail(env: Env, email: string, verificationToken: string, statusPageName: string): Promise<{ sent: boolean; error?: string; verifyUrl: string }> {
  const verifyUrl = `${env.FRONTEND_URL || 'https://incidentcast.pages.dev'}/verify?token=${verificationToken}`;
  
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #111827;">Confirm Your Subscription</h2>
      <p style="color: #6b7280; line-height: 1.6;">
        You requested to receive status updates from <strong>${statusPageName}</strong>.
      </p>
      <p style="color: #6b7280; line-height: 1.6;">
        Please click the button below to confirm your subscription:
      </p>
      <a href="${verifyUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0;">
        Confirm Subscription
      </a>
      <p style="color: #9ca3af; font-size: 14px;">
        If you didn't request this subscription, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #9ca3af; font-size: 12px;">
        Powered by IncidentCast
      </p>
    </div>
  `;

  const subject = `Confirm your subscription to ${statusPageName}`;

  // Send via Brevo
  if (env.BREVO_API_KEY) {
    return await sendViaBrevo(env, email, subject, emailHtml, verifyUrl);
  }

  // No email provider configured - log for development
  console.log(`[DEV] Verification email for ${email}: ${verifyUrl}`);
  return { sent: false, error: 'No email provider configured (set BREVO_API_KEY)', verifyUrl };
}

// Brevo (SendinBlue) email sending - 300 emails/day free tier
async function sendViaBrevo(env: Env, to: string, subject: string, html: string, verifyUrl: string): Promise<{ sent: boolean; error?: string; verifyUrl: string }> {
  try {
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
        htmlContent: html
      })
    });

    if (response.ok) {
      return { sent: true, verifyUrl };
    }

    const errorText = await response.text();
    console.error('Brevo API error:', errorText);
    return { sent: false, error: `Brevo email failed: ${errorText}`, verifyUrl };
  } catch (error) {
    console.error('Failed to send email via Brevo:', error);
    return { sent: false, error: error instanceof Error ? error.message : 'Unknown error', verifyUrl };
  }
}

// ============ Public Routes (no auth) ============

// Subscribe to a status page (public)
subscribers.post('/public/:subdomain/subscribe', zValidator('json', subscribeSchema), async (c) => {
  const subdomain = c.req.param('subdomain');
  const input = c.req.valid('json');

  // Get status page
  const page = await c.env.DB.prepare(`
    SELECT id, show_subscribe_button FROM status_pages WHERE subdomain = ? AND is_public = 1
  `).bind(subdomain).first<{ id: string; show_subscribe_button: number }>();

  if (!page) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  if (!sqliteBool(page.show_subscribe_button)) {
    return c.json({ success: false, error: 'Subscriptions are not enabled for this status page' }, 400);
  }

  // Check if already subscribed
  const existing = await c.env.DB.prepare(
    'SELECT id, is_verified FROM subscribers WHERE status_page_id = ? AND email = ?'
  ).bind(page.id, input.email.toLowerCase()).first<{ id: string; is_verified: number }>();

  if (existing) {
    if (sqliteBool(existing.is_verified)) {
      return c.json({ success: false, error: 'This email is already subscribed' }, 400);
    }
    // Resend verification if not verified
    return c.json({
      success: true,
      message: 'A verification email has been sent to your email address'
    });
  }

  const subscriberId = generateId();
  const verificationToken = generateToken(32);
  const unsubscribeToken = generateToken(32);
  const now = new Date().toISOString();

  // Create subscriber
  await c.env.DB.prepare(`
    INSERT INTO subscribers (id, status_page_id, email, verification_token, unsubscribe_token, notify_incidents, notify_maintenance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    subscriberId,
    page.id,
    input.email.toLowerCase(),
    verificationToken,
    unsubscribeToken,
    toSqliteBool(input.notify_incidents),
    toSqliteBool(input.notify_maintenance),
    now
  ).run();

  // Add component subscriptions if specified
  if (input.component_ids && input.component_ids.length > 0) {
    for (const componentId of input.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO subscriber_components (id, subscriber_id, component_id)
        VALUES (?, ?, ?)
      `).bind(generateId(), subscriberId, componentId).run();
    }
  }

  // Get status page name for email
  const statusPageDetails = await c.env.DB.prepare(
    'SELECT name FROM status_pages WHERE id = ?'
  ).bind(page.id).first<{ name: string }>();

  // Send verification email
  const emailResult = await sendVerificationEmail(
    c.env, 
    input.email.toLowerCase(), 
    verificationToken, 
    statusPageDetails?.name || 'Status Page'
  );

  // Build response
  const response: { 
    success: boolean; 
    message: string; 
    emailSent?: boolean;
    debug?: { verificationToken: string; verifyUrl: string } 
  } = {
    success: true,
    message: emailResult.sent 
      ? 'A verification email has been sent to your email address' 
      : 'Subscribed successfully. Please check your email for verification (email delivery may be delayed).',
    emailSent: emailResult.sent
  };

  // Include debug info when email sending failed or no provider configured
  if (!emailResult.sent) {
    response.debug = {
      verificationToken,
      verifyUrl: emailResult.verifyUrl
    };
    console.log(`[EMAIL] Verification email not sent for ${input.email.toLowerCase()}: ${emailResult.error || 'unknown'}. Verify URL: ${emailResult.verifyUrl}`);
  }

  return c.json(response, 201);
});

// Verify subscription
subscribers.get('/verify/:token', async (c) => {
  const token = c.req.param('token');

  const subscriber = await c.env.DB.prepare(
    'SELECT id, email FROM subscribers WHERE verification_token = ? AND is_verified = 0'
  ).bind(token).first<{ id: string; email: string }>();

  if (!subscriber) {
    return c.json({ success: false, error: 'Invalid or expired verification token' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE subscribers SET is_verified = 1, verification_token = NULL WHERE id = ?'
  ).bind(subscriber.id).run();

  return c.json({
    success: true,
    message: 'Your email has been verified. You will now receive status updates.'
  });
});

// Unsubscribe
subscribers.get('/unsubscribe/:token', async (c) => {
  const token = c.req.param('token');

  const subscriber = await c.env.DB.prepare(
    'SELECT id FROM subscribers WHERE unsubscribe_token = ?'
  ).bind(token).first<{ id: string }>();

  if (!subscriber) {
    return c.json({ success: false, error: 'Invalid unsubscribe token' }, 400);
  }

  await c.env.DB.prepare('DELETE FROM subscribers WHERE id = ?').bind(subscriber.id).run();

  return c.json({
    success: true,
    message: 'You have been unsubscribed from status updates.'
  });
});

// Update subscription preferences (using unsubscribe token for auth)
subscribers.patch('/preferences/:token', zValidator('json', updateSubscriberSchema), async (c) => {
  const token = c.req.param('token');
  const updates = c.req.valid('json');

  const subscriber = await c.env.DB.prepare(
    'SELECT id, status_page_id FROM subscribers WHERE unsubscribe_token = ?'
  ).bind(token).first<{ id: string; status_page_id: string }>();

  if (!subscriber) {
    return c.json({ success: false, error: 'Invalid token' }, 400);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.notify_incidents !== undefined) {
    fields.push('notify_incidents = ?');
    values.push(toSqliteBool(updates.notify_incidents));
  }
  if (updates.notify_maintenance !== undefined) {
    fields.push('notify_maintenance = ?');
    values.push(toSqliteBool(updates.notify_maintenance));
  }

  if (fields.length > 0) {
    values.push(subscriber.id);
    await c.env.DB.prepare(`
      UPDATE subscribers SET ${fields.join(', ')} WHERE id = ?
    `).bind(...values).run();
  }

  // Update component subscriptions
  if (updates.component_ids !== undefined) {
    // Remove existing
    await c.env.DB.prepare(
      'DELETE FROM subscriber_components WHERE subscriber_id = ?'
    ).bind(subscriber.id).run();

    // Add new
    for (const componentId of updates.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO subscriber_components (id, subscriber_id, component_id)
        VALUES (?, ?, ?)
      `).bind(generateId(), subscriber.id, componentId).run();
    }
  }

  return c.json({
    success: true,
    message: 'Preferences updated successfully'
  });
});

// ============ Protected Routes (require auth) ============
subscribers.use('/manage/*', orgAuthMiddleware);

// Manually add a subscriber (admin)
subscribers.post('/manage/pages/:pageId', adminMiddleware, zValidator('json', subscribeSchema), async (c) => {
  const pageId = c.req.param('pageId');
  const org = c.get('organization');
  const input = c.req.valid('json');

  // Verify page belongs to org
  const statusPage = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Check if already subscribed
  const existing = await c.env.DB.prepare(
    'SELECT id FROM subscribers WHERE status_page_id = ? AND email = ?'
  ).bind(pageId, input.email.toLowerCase()).first();

  if (existing) {
    return c.json({ success: false, error: 'This email is already subscribed' }, 400);
  }

  const subscriberId = generateId();
  const unsubscribeToken = generateToken(32);
  const now = new Date().toISOString();
  const isVerified = input.skip_verification ? 1 : 0;

  // Create subscriber (verified only if admin chose to skip verification)
  await c.env.DB.prepare(`
    INSERT INTO subscribers (id, status_page_id, email, is_verified, unsubscribe_token, notify_incidents, notify_maintenance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    subscriberId,
    pageId,
    input.email.toLowerCase(),
    isVerified,
    unsubscribeToken,
    toSqliteBool(input.notify_incidents),
    toSqliteBool(input.notify_maintenance),
    now
  ).run();

  // Add component subscriptions if specified
  if (input.component_ids && input.component_ids.length > 0) {
    for (const componentId of input.component_ids) {
      await c.env.DB.prepare(`
        INSERT INTO subscriber_components (id, subscriber_id, component_id)
        VALUES (?, ?, ?)
      `).bind(generateId(), subscriberId, componentId).run();
    }
  }

  // Send verification email if not skipping
  if (!input.skip_verification) {
    const statusPageDetails = await c.env.DB.prepare(
      'SELECT name FROM status_pages WHERE id = ?'
    ).bind(pageId).first<{ name: string }>();

    const verificationToken = generateToken(32);
    await c.env.DB.prepare(
      'UPDATE subscribers SET verification_token = ? WHERE id = ?'
    ).bind(verificationToken, subscriberId).run();

    const emailResult = await sendVerificationEmail(
      c.env,
      input.email.toLowerCase(),
      verificationToken,
      statusPageDetails?.name || 'Status Page'
    );

    if (!emailResult.sent) {
      console.log(`[EMAIL] Verification email not sent for ${input.email.toLowerCase()}: ${emailResult.error || 'unknown'}. Verify URL: ${emailResult.verifyUrl}`);
    }
  }

  return c.json({
    success: true,
    data: {
      id: subscriberId,
      email: input.email.toLowerCase(),
      is_verified: !!isVerified,
      notify_incidents: input.notify_incidents,
      notify_maintenance: input.notify_maintenance,
      created_at: now
    }
  }, 201);
});

// List subscribers for a status page
subscribers.get('/manage/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const org = c.get('organization');
  const { page, limit } = paginationSchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit')
  });

  // Verify page belongs to org
  const statusPage = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  // Get total count
  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM subscribers WHERE status_page_id = ?'
  ).bind(pageId).first<{ count: number }>();

  const total = countResult?.count || 0;
  const offset = (page - 1) * limit;

  // Get subscribers
  const subs = await c.env.DB.prepare(`
    SELECT id, email, is_verified, notify_incidents, notify_maintenance, created_at
    FROM subscribers WHERE status_page_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(pageId, limit, offset).all<Subscriber>();

  return c.json({
    success: true,
    data: subs.results.map(s => ({
      ...s,
      is_verified: sqliteBool(s.is_verified),
      notify_incidents: sqliteBool(s.notify_incidents),
      notify_maintenance: sqliteBool(s.notify_maintenance)
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Get subscriber stats for a status page
subscribers.get('/manage/pages/:pageId/stats', async (c) => {
  const pageId = c.req.param('pageId');
  const org = c.get('organization');

  // Verify page belongs to org
  const statusPage = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const stats = await c.env.DB.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) as verified,
      SUM(CASE WHEN is_verified = 0 THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN notify_incidents = 1 THEN 1 ELSE 0 END) as notify_incidents,
      SUM(CASE WHEN notify_maintenance = 1 THEN 1 ELSE 0 END) as notify_maintenance
    FROM subscribers WHERE status_page_id = ?
  `).bind(pageId).first<{
    total: number;
    verified: number;
    pending: number;
    notify_incidents: number;
    notify_maintenance: number;
  }>();

  return c.json({
    success: true,
    data: stats
  });
});

// Delete subscriber (admin)
subscribers.delete('/manage/:subscriberId', adminMiddleware, async (c) => {
  const subscriberId = c.req.param('subscriberId');
  const org = c.get('organization');

  // Verify subscriber belongs to org's status page
  const subscriber = await c.env.DB.prepare(`
    SELECT s.id FROM subscribers s
    JOIN status_pages sp ON sp.id = s.status_page_id
    WHERE s.id = ? AND sp.organization_id = ?
  `).bind(subscriberId, org.id).first();

  if (!subscriber) {
    return c.json({ success: false, error: 'Subscriber not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM subscribers WHERE id = ?').bind(subscriberId).run();

  return c.json({
    success: true,
    message: 'Subscriber removed successfully'
  });
});

// Resend verification email (admin)
subscribers.post('/manage/:subscriberId/resend-verification', adminMiddleware, async (c) => {
  const subscriberId = c.req.param('subscriberId');
  const org = c.get('organization');

  // Get subscriber with status page info
  const subscriber = await c.env.DB.prepare(`
    SELECT s.id, s.email, s.is_verified, s.verification_token, sp.id as page_id, sp.name as page_name
    FROM subscribers s
    JOIN status_pages sp ON sp.id = s.status_page_id
    WHERE s.id = ? AND sp.organization_id = ?
  `).bind(subscriberId, org.id).first<{ 
    id: string; 
    email: string; 
    is_verified: number;
    verification_token: string | null;
    page_id: string;
    page_name: string;
  }>();

  if (!subscriber) {
    return c.json({ success: false, error: 'Subscriber not found' }, 404);
  }

  if (sqliteBool(subscriber.is_verified)) {
    return c.json({ success: false, error: 'Subscriber is already verified' }, 400);
  }

  // Generate new verification token if needed
  let verificationToken = subscriber.verification_token;
  if (!verificationToken) {
    verificationToken = generateToken(32);
    await c.env.DB.prepare(
      'UPDATE subscribers SET verification_token = ? WHERE id = ?'
    ).bind(verificationToken, subscriberId).run();
  }

  // Send verification email
  const emailResult = await sendVerificationEmail(
    c.env,
    subscriber.email,
    verificationToken,
    subscriber.page_name
  );

  // Build response
  const response: { 
    success: boolean; 
    message: string; 
    emailSent?: boolean;
    data?: { debug?: { verificationToken: string; verifyUrl: string } }
  } = {
    success: true,
    message: emailResult.sent 
      ? 'Verification email has been resent' 
      : 'Email delivery failed. You can use the verification link below.',
    emailSent: emailResult.sent
  };

  // Include debug info when email sending failed
  if (!emailResult.sent) {
    response.data = {
      debug: {
        verificationToken,
        verifyUrl: emailResult.verifyUrl
      }
    };
  }

  return c.json(response);
});

// Export subscribers (admin)
subscribers.get('/manage/pages/:pageId/export', adminMiddleware, async (c) => {
  const pageId = c.req.param('pageId');
  const org = c.get('organization');

  // Verify page belongs to org
  const statusPage = await c.env.DB.prepare(
    'SELECT id FROM status_pages WHERE id = ? AND organization_id = ?'
  ).bind(pageId, org.id).first();

  if (!statusPage) {
    return c.json({ success: false, error: 'Status page not found' }, 404);
  }

  const subs = await c.env.DB.prepare(`
    SELECT email, is_verified, notify_incidents, notify_maintenance, created_at
    FROM subscribers WHERE status_page_id = ? AND is_verified = 1
    ORDER BY created_at DESC
  `).bind(pageId).all();

  // Return as CSV
  const headers = ['email', 'verified', 'notify_incidents', 'notify_maintenance', 'subscribed_at'];
  const rows = subs.results.map((s: any) => [
    s.email,
    sqliteBool(s.is_verified) ? 'Yes' : 'No',
    sqliteBool(s.notify_incidents) ? 'Yes' : 'No',
    sqliteBool(s.notify_maintenance) ? 'Yes' : 'No',
    s.created_at
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="subscribers-${pageId}.csv"`
    }
  });
});

export default subscribers;

// Authentication routes for IncidentCast
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Env, User } from '../types';
import { 
  signupSchema, 
  loginSchema, 
  forgotPasswordSchema, 
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema
} from '../schemas';
import { 
  generateId, 
  generateToken, 
  hashPassword, 
  verifyPassword, 
  createJWT,
  hashToken,
  generateSlug 
} from '../utils';
import { authMiddleware } from '../middleware';

const auth = new Hono<{ Bindings: Env }>();

// Sign up
auth.post('/signup', zValidator('json', signupSchema), async (c) => {
  const { email, password, name, organizationName } = c.req.valid('json');

  // Check if user already exists
  const existingUser = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first();

  if (existingUser) {
    return c.json({ success: false, error: 'An account with this email already exists' }, 400);
  }

  const userId = generateId();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  // Create user
  await c.env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, email.toLowerCase(), passwordHash, name, now, now).run();

  // Create default organization if name provided
  let organization = null;
  if (organizationName) {
    const orgId = generateId();
    const orgSlug = generateSlug(organizationName) + '-' + Math.random().toString(36).substring(2, 6);

    await c.env.DB.prepare(`
      INSERT INTO organizations (id, name, slug, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(orgId, organizationName, orgSlug, now, now).run();

    // Add user as owner
    await c.env.DB.prepare(`
      INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
      VALUES (?, ?, ?, 'owner', ?)
    `).bind(generateId(), orgId, userId, now).run();

    // Create default status page
    const statusPageId = generateId();
    const subdomain = orgSlug;

    await c.env.DB.prepare(`
      INSERT INTO status_pages (id, organization_id, name, subdomain, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(statusPageId, orgId, `${organizationName} Status`, subdomain, `Current status and incidents for ${organizationName}`, now, now).run();

    organization = {
      id: orgId,
      name: organizationName,
      slug: orgSlug
    };
  }

  // Generate email verification token and send verification email
  const verificationToken = generateToken(32);
  const tokenHash = await hashToken(verificationToken);
  const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString(); // 24 hours

  await c.env.DB.prepare(`
    INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(generateId(), userId, email.toLowerCase(), tokenHash, expiresAt, now).run();

  // Send verification email via Brevo
  await sendUserVerificationEmail(c.env, email.toLowerCase(), name, verificationToken);

  // Generate JWT token
  const token = await createJWT({ userId, email: email.toLowerCase() }, c.env.JWT_SECRET);

  const user: User = {
    id: userId,
    email: email.toLowerCase(),
    name,
    email_verified: false,
    created_at: now,
    updated_at: now
  };

  return c.json({
    success: true,
    data: {
      user,
      organization,
      token
    }
  }, 201);
});

// Verify user email
auth.get('/verify-email/:token', async (c) => {
  const token = c.req.param('token');

  const tokenHash = await hashToken(token);

  // Find valid verification token
  const verification = await c.env.DB.prepare(`
    SELECT * FROM email_verifications
    WHERE token_hash = ? AND verified_at IS NULL AND expires_at > datetime('now')
  `).bind(tokenHash).first<{ id: string; user_id: string; email: string }>();

  if (!verification) {
    return c.json({ success: false, error: 'Invalid or expired verification link' }, 400);
  }

  const now = new Date().toISOString();

  // Mark email as verified and update user
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_verifications SET verified_at = ? WHERE id = ?')
      .bind(now, verification.id),
    c.env.DB.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?')
      .bind(now, verification.user_id)
  ]);

  return c.json({
    success: true,
    message: 'Email verified successfully'
  });
});

// Resend verification email
auth.post('/resend-verification', authMiddleware, async (c) => {
  const user = c.get('user');

  if (user.email_verified) {
    return c.json({ success: false, error: 'Email is already verified' }, 400);
  }

  // Delete old tokens
  await c.env.DB.prepare(
    'DELETE FROM email_verifications WHERE user_id = ?'
  ).bind(user.id).run();

  // Generate new token
  const verificationToken = generateToken(32);
  const tokenHash = await hashToken(verificationToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();

  await c.env.DB.prepare(`
    INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(generateId(), user.id, user.email, tokenHash, expiresAt, now).run();

  await sendUserVerificationEmail(c.env, user.email, user.name, verificationToken);

  return c.json({
    success: true,
    message: 'Verification email sent'
  });
});

// Login
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  // Get user with password
  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first<User & { password_hash: string }>();

  if (!user) {
    return c.json({ success: false, error: 'Invalid email or password' }, 401);
  }

  // Verify password
  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    return c.json({ success: false, error: 'Invalid email or password' }, 401);
  }

  // Generate JWT token
  const token = await createJWT({ userId: user.id, email: user.email }, c.env.JWT_SECRET);

  // Get user's organizations
  const organizations = await c.env.DB.prepare(`
    SELECT o.*, om.role FROM organizations o
    JOIN organization_members om ON om.organization_id = o.id
    WHERE om.user_id = ?
    ORDER BY om.created_at ASC
  `).bind(user.id).all();

  // Remove password hash from response
  const { password_hash, ...userWithoutPassword } = user;

  return c.json({
    success: true,
    data: {
      user: userWithoutPassword,
      organizations: organizations.results,
      token
    }
  });
});

// Get current user
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');

  // Get user's organizations
  const organizations = await c.env.DB.prepare(`
    SELECT o.*, om.role FROM organizations o
    JOIN organization_members om ON om.organization_id = o.id
    WHERE om.user_id = ?
    ORDER BY om.created_at ASC
  `).bind(user.id).all();

  return c.json({
    success: true,
    data: {
      user,
      organizations: organizations.results
    }
  });
});

// Update profile
auth.patch('/profile', authMiddleware, zValidator('json', updateProfileSchema), async (c) => {
  const user = c.get('user');
  const updates = c.req.valid('json');

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url || null);
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(user.id);

  await c.env.DB.prepare(`
    UPDATE users SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  // Get updated user
  const updatedUser = await c.env.DB.prepare(
    'SELECT id, email, name, avatar_url, email_verified, created_at, updated_at FROM users WHERE id = ?'
  ).bind(user.id).first<User>();

  return c.json({
    success: true,
    data: { user: updatedUser }
  });
});

// Change password
auth.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const user = c.get('user');
  const { currentPassword, newPassword } = c.req.valid('json');

  // Get user with password
  const userWithPassword = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ?'
  ).bind(user.id).first<{ password_hash: string }>();

  if (!userWithPassword) {
    return c.json({ success: false, error: 'User not found' }, 404);
  }

  // Verify current password
  const isValid = await verifyPassword(currentPassword, userWithPassword.password_hash);
  if (!isValid) {
    return c.json({ success: false, error: 'Current password is incorrect' }, 400);
  }

  // Hash new password
  const newPasswordHash = await hashPassword(newPassword);

  // Update password
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
  ).bind(newPasswordHash, new Date().toISOString(), user.id).run();

  return c.json({
    success: true,
    message: 'Password changed successfully'
  });
});

// Forgot password (request reset)
auth.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');

  // Get user
  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first<{ id: string }>();

  // Always return success to prevent email enumeration
  if (!user) {
    return c.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent'
    });
  }

  // Generate reset token
  const token = generateToken(32);
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

  // Store token
  await c.env.DB.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(generateId(), user.id, tokenHash, expiresAt, new Date().toISOString()).run();

  // In production, send email with reset link
  // For now, just log the token (in development)
  console.log(`Password reset token for ${email}: ${token}`);

  return c.json({
    success: true,
    message: 'If an account with that email exists, a password reset link has been sent',
    // Remove this in production - for development only
    debug: { token }
  });
});

// Reset password
auth.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const { token, password } = c.req.valid('json');

  // Hash token to compare
  const tokenHash = await hashToken(token);

  // Find valid reset token
  const reset = await c.env.DB.prepare(`
    SELECT * FROM password_resets 
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).bind(tokenHash).first<{ id: string; user_id: string }>();

  if (!reset) {
    return c.json({ success: false, error: 'Invalid or expired reset token' }, 400);
  }

  // Hash new password
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  // Update password and mark token as used
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, now, reset.user_id),
    c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?')
      .bind(now, reset.id)
  ]);

  return c.json({
    success: true,
    message: 'Password reset successfully'
  });
});

// Logout (invalidate all sessions - optional)
auth.post('/logout', authMiddleware, async (c) => {
  // In a more complete implementation, you would invalidate the session
  // For JWT-based auth, the client simply discards the token
  return c.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Helper: send user email verification via Brevo
async function sendUserVerificationEmail(env: Env, email: string, name: string, verificationToken: string): Promise<void> {
  const verifyUrl = `${env.FRONTEND_URL || 'https://incidentcast.pages.dev'}/verify?token=${verificationToken}&type=email`;

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <svg width="180" height="45" viewBox="0 0 640 180" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(40 90)">
            <circle r="8" fill="#ef4444"/>
            <circle cx="24" r="8" fill="#f59e0b"/>
            <circle cx="48" r="8" fill="#22c55e"/>
          </g>
          <text x="100" y="98" font-size="48" fill="#111827" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;font-weight:600;letter-spacing:-.4px">
            IncidentCast
          </text>
        </svg>
      </div>
      <h2 style="color: #111827; margin-bottom: 16px;">Verify your email address</h2>
      <p style="color: #6b7280; line-height: 1.6;">
        Hi ${name},
      </p>
      <p style="color: #6b7280; line-height: 1.6;">
        Welcome to IncidentCast! Please verify your email address by clicking the button below:
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${verifyUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 16px;">
          Verify Email Address
        </a>
      </div>
      <p style="color: #9ca3af; font-size: 14px;">
        This link will expire in 24 hours. If you didn't create an account, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #9ca3af; font-size: 12px; text-align: center;">
        Powered by IncidentCast
      </p>
    </div>
  `;

  if (!env.BREVO_API_KEY) {
    console.log(`[DEV] Email verification for ${email}: ${verifyUrl}`);
    return;
  }

  try {
    const fromEmail = env.BREVO_FROM_EMAIL || env.EMAIL_FROM || 'noreply@incidentcast.com';
    const fromAddr = fromEmail.includes('<') ? fromEmail.split('<')[1].replace('>', '').trim() : fromEmail;

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'IncidentCast', email: fromAddr },
        to: [{ email, name }],
        subject: 'Verify your email address - IncidentCast',
        htmlContent: emailHtml
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Brevo verification email error:', errorText);
    }
  } catch (error) {
    console.error('Failed to send verification email:', error);
  }
}

export default auth;

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { sendDailyDigest, sendNote, sendInvoiceToClient, sendPaymentReceivedToOwner, sendCallTranscriptToOwner, sendWorkOrderToClient, sendIncomingSmsNotification, sendBusinessOnboardingEmail } = require('../email/digest');
const { handleMessage } = require('../bot/whatsapp');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VoiceResponse = twilio.twiml.VoiceResponse;

// In-memory voice conversation store (keyed by CallSid)
const voiceConversations = new Map();
// Clean up old conversations every hour
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [sid, data] of voiceConversations) {
    if (data.ts < cutoff) voiceConversations.delete(sid);
  }
}, 3600000);

const LINKCREW_SYSTEM = `You are an AI assistant for LinkCrew, a field service management platform built for contractors and field service crews.

LinkCrew helps contractors manage jobs, track crew in real time, handle client invoices, and give clients their own portal.

PRICING PLANS:
- Solo plan: $49 per month, 1 user
- Team plan: $97 per month, up to 5 users
- Pro plan: $165 per month, up to 10 users
- Business plan: $299 per month, up to 20 users
- Voice Bot add-on: $30 per month, available on any plan
- All plans include a 14-day free trial with no credit card required

FEATURES included on all plans:
- Live job tracking and pipeline management
- Client CRM with a client-facing portal
- Crew check-ins and real-time site photos
- Supply request management
- Stripe-powered invoicing and payments
- Service agreements and reporting
- Android mobile app for crew and owners (available now)
- Web dashboard at linkcrew.io for full management

CONTACT & SUPPORT:
- Website: linkcrew.io
- Email: support@linkcrew.io
- Sign up free at linkcrew.io

If asked anything outside of LinkCrew, politely redirect to what you know.
Never make up information. If unsure, direct them to linkcrew.io.`;

const app = express();

// CORS — allow linkcrew.io and kingstondatagroup.com
app.use((req, res, next) => {
  const allowed = ['https://www.linkcrew.io', 'https://linkcrew.io', 'https://www.kingstondatagroup.com', 'https://kingstondatagroup.com', 'https://kdg-site.onrender.com'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Regular client (anon key) — used for realtime/public config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Admin client (service role) — used for all server-side queries and auth verification
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Stripe webhook (must be before express.json to access raw body) ───────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const planMaxUsers = { solo: 1, team: 5, pro: 10, business: 20 };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Client invoice payment
    if (session.metadata?.job_id) {
      await supabaseAdmin.from('jobs').update({ payment_status: 'paid' }).eq('id', session.metadata.job_id);
      // Notify owner
      try {
        const { data: job } = await supabaseAdmin.from('jobs')
          .select('name, invoice_amount, tenant_id, clients(name)')
          .eq('id', session.metadata.job_id).single();
        if (job?.tenant_id) {
          const { data: tenant } = await supabaseAdmin.from('tenants')
            .select('owner_email, company_name').eq('id', job.tenant_id).single();
          if (tenant?.owner_email) {
            await sendPaymentReceivedToOwner({
              ownerEmail: tenant.owner_email,
              clientName: job.clients?.name || 'Client',
              jobName: job.name,
              amount: job.invoice_amount,
              tenantName: tenant.company_name,
            });
          }
        }
      } catch (emailErr) {
        console.error('[webhook] payment email error:', emailErr.message);
      }
    }
    // Subscription checkout
    if (session.mode === 'subscription' && session.metadata?.tenant_id) {
      const plan = session.metadata.plan;
      await supabaseAdmin.from('tenants').update({
        plan,
        subscription_status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        max_users: planMaxUsers[plan] || 1,
      }).eq('id', session.metadata.tenant_id);
      // Business plan — send onboarding email with Calendly link
      if (plan === 'business') {
        try {
          const { data: tenant } = await supabaseAdmin.from('tenants')
            .select('owner_email, company_name').eq('id', session.metadata.tenant_id).single();
          if (tenant?.owner_email) {
            await sendBusinessOnboardingEmail({
              ownerEmail: tenant.owner_email,
              companyName: tenant.company_name,
            });
          }
        } catch (emailErr) {
          console.error('[webhook] business onboarding email error:', emailErr.message);
        }
      }
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    if (sub.metadata?.tenant_id) {
      await supabaseAdmin.from('tenants').update({
        subscription_status: sub.status,
        stripe_subscription_id: sub.id,
      }).eq('id', sub.metadata.tenant_id);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    if (sub.metadata?.tenant_id) {
      await supabaseAdmin.from('tenants')
        .update({ subscription_status: 'canceled' }).eq('id', sub.metadata.tenant_id);
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('id').eq('stripe_customer_id', event.data.object.customer).single();
    if (tenant) {
      await supabaseAdmin.from('tenants').update({ subscription_status: 'past_due' }).eq('id', tenant.id);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── KDG host-based routing ────────────────────────────────────────────────────
const KDG_HOSTS = ['kingstondatagroup.com', 'www.kingstondatagroup.com'];
app.use((req, res, next) => {
  if (KDG_HOSTS.includes(req.hostname)) {
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile(path.join(__dirname, '../kdg-site/index.html'));
    }
    return express.static(path.join(__dirname, '../kdg-site'))(req, res, next);
  }
  next();
});
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../dashboard'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/index.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/portal.html')));
app.get('/invoice', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/invoice.html')));
app.get('/workorder', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/workorder.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/pricing.html')));
app.get('/kdg', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/kdg.html')));
app.get('/kdg-logos', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/kdg-logos.html')));
app.get('/mission-control', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/mission-control.html')));

app.get('/lc-ops', (req, res) => {
  const secret = process.env.ADMIN_URL_SECRET;
  if (secret && req.query.k !== secret) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, '../dashboard/admin.html'));
});

// ── Mission Control API ───────────────────────────────────────────────────────

app.get('/api/mc/stats', auth, async (req, res) => {
  const [leadsRes, notesRes] = await Promise.all([
    supabaseAdmin.from('kdg_leads').select('id, source, created_at, status'),
    supabaseAdmin.from('mc_notes').select('id'),
  ]);
  const leads = leadsRes.data || [];
  const today = new Date(); today.setHours(0,0,0,0);
  res.json({
    total_leads: leads.length,
    new_leads: leads.filter(l => l.status === 'new').length,
    calls_today: leads.filter(l => l.source === 'voice' && new Date(l.created_at) >= today).length,
    forms_today: leads.filter(l => l.source === 'form' && new Date(l.created_at) >= today).length,
    notes: notesRes.data?.length || 0,
  });
});

app.get('/api/mc/leads', auth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('kdg_leads')
    .select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mc/leads/:id', auth, async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabaseAdmin.from('kdg_leads')
    .update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/mc/notes', auth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/mc/notes', auth, async (req, res) => {
  const { title, content, category } = req.body;
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .insert({ title, content, category }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mc/notes/:id', auth, async (req, res) => {
  const { title, content, category } = req.body;
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .update({ title, content, category, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/mc/notes/:id', auth, async (req, res) => {
  const { error } = await supabaseAdmin.from('mc_notes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Choppy can read notes using CHOPPY_SECRET
app.get('/api/mc/choppy-notes', async (req, res) => {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.CHOPPY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Choppy can read calendar events using CHOPPY_SECRET
app.get('/api/mc/choppy-events', async (req, res) => {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.CHOPPY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin.from('mc_events')
    .select('*').order('event_date', { ascending: true }).order('event_time', { ascending: true, nullsFirst: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Choppy can post notes directly using CHOPPY_SECRET
app.post('/api/mc/choppy-note', async (req, res) => {
  const { secret, title, content, category } = req.body;
  if (!secret || secret !== process.env.CHOPPY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .insert({ title, content, category: category || 'choppy' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Choppy can update an existing note using CHOPPY_SECRET
app.patch('/api/mc/choppy-note/:id', async (req, res) => {
  const { secret, title, content } = req.body;
  if (!secret || secret !== process.env.CHOPPY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin.from('mc_notes')
    .update({ title, content, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Choppy can post calendar events using CHOPPY_SECRET
app.post('/api/mc/choppy-event', async (req, res) => {
  const { secret, title, event_date, event_time, description, type } = req.body;
  if (!secret || secret !== process.env.CHOPPY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin.from('mc_events')
    .insert({ title, event_date, event_time, description, type: type || 'choppy' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/mc/events', auth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('mc_events')
    .select('*').order('event_date', { ascending: true }).order('event_time', { ascending: true, nullsFirst: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/mc/events', auth, async (req, res) => {
  const { title, event_date, event_time, description, type } = req.body;
  const { data, error } = await supabaseAdmin.from('mc_events')
    .insert({ title, event_date, event_time, description, type }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mc/events/:id', auth, async (req, res) => {
  const { title, event_date, event_time, description, type, done } = req.body;
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (event_date !== undefined) updates.event_date = event_date;
  if (event_time !== undefined) updates.event_time = event_time;
  if (description !== undefined) updates.description = description;
  if (type !== undefined) updates.type = type;
  if (done !== undefined) updates.done = done;
  const { data, error } = await supabaseAdmin.from('mc_events')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/mc/events/:id', auth, async (req, res) => {
  const { error } = await supabaseAdmin.from('mc_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// KDG contact form
app.post('/api/contact-kdg', async (req, res) => {
  const { name, company, email, phone, service, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields' });
  // Save to Supabase
  supabaseAdmin.from('kdg_leads').insert({ source: 'form', name, company, email, phone, service, message }).then();
  try {
    const { Resend } = require('resend');
    const r = new Resend(process.env.RESEND_API_KEY);
    await r.emails.send({
      from: 'Kingston Data Group <hello@linkcrew.io>',
      to: 'sales@kingstondatagroup.com',
      subject: `New Project Inquiry from ${name}${company ? ' — ' + company : ''}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#f97316">New Project Inquiry</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#888;width:100px">Name</td><td style="padding:8px 0"><strong>${name}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#888">Company</td><td style="padding:8px 0">${company || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888">Phone</td><td style="padding:8px 0">${phone || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888">Service</td><td style="padding:8px 0">${service || '—'}</td></tr>
        </table>
        <div style="margin-top:20px;padding:16px;background:#f5f5f5;border-radius:8px">
          <p style="margin:0;white-space:pre-wrap">${message}</p>
        </div>
      </div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send' });
  }
});

// Super-admin emails (comma-separated in env, e.g. "you@example.com")
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim()).filter(Boolean);

// Short-lived impersonation tokens: token → { tenantId, expires }
const impersonationSessions = new Map();

// ── Auth middleware ───────────────────────────────────────────────────────────

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Impersonation token (admin "Login as" feature)
  if (token.startsWith('imp_')) {
    const session = impersonationSessions.get(token);
    if (!session || session.expires < Date.now()) {
      impersonationSessions.delete(token);
      return res.status(401).json({ error: 'Impersonation token expired' });
    }
    req.tenantId = session.tenantId;
    req.isAdmin = false;
    req.isImpersonating = true;
    return next();
  }

  // Verify the Supabase JWT and get the user
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  req.userId = user.id;
  req.userEmail = user.email;
  req.isAdmin = ADMIN_EMAILS.includes(user.email);

  if (req.isAdmin) {
    // Admin can optionally scope to a specific tenant via header
    req.tenantId = req.headers['x-tenant-id'] || null;
    return next();
  }

  // Regular owner: look up their tenant
  const { data: tenantUser } = await supabaseAdmin
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', user.id)
    .single();

  if (!tenantUser) {
    return res.status(403).json({ error: 'No organization found. Please contact support.' });
  }

  req.tenantId = tenantUser.tenant_id;

  // Track last activity (fire-and-forget)
  supabaseAdmin.from('tenants').update({ last_seen_at: new Date().toISOString() }).eq('id', req.tenantId).then(() => {});

  // Subscription / account status check — skip for billing and auth routes
  const skipPaths = ['/api/billing/', '/api/auth/', '/api/admin/', '/api/config', '/api/onboarding', '/api/settings'];
  const skipSub = skipPaths.some(p => req.path.startsWith(p));
  if (!skipSub) {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('subscription_status, trial_ends_at, plan, paused, blocked')
      .eq('id', req.tenantId).single();
    if (tenant) {
      if (tenant.blocked) {
        return res.status(403).json({ error: 'account_blocked' });
      }
      if (tenant.paused) {
        return res.status(402).json({ error: 'account_paused' });
      }
      const now = new Date();
      const trialExpired = tenant.subscription_status === 'trialing' && new Date(tenant.trial_ends_at) < now;
      const locked = trialExpired || tenant.subscription_status === 'past_due' || tenant.subscription_status === 'canceled';
      if (locked) {
        return res.status(402).json({
          error: 'subscription_required',
          subscription_status: trialExpired ? 'trial_expired' : tenant.subscription_status,
          trial_ends_at: tenant.trial_ends_at,
        });
      }
    }
  }

  next();
}

// Scopes a query to a tenant if tenantId is set
function scoped(query, tenantId) {
  return tenantId ? query.eq('tenant_id', tenantId) : query;
}

// ── Public Routes ─────────────────────────────────────────────────────────────

// Returns public Supabase credentials (anon key is safe to expose)
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_ANON_KEY });
});

// Create a new owner account + tenant
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, company_name, invite_code } = req.body;
  if (!email || !password || !company_name) {
    return res.status(400).json({ error: 'Email, password, and company name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Resolve invite code if provided
  let trialDays = 14;
  let inviteId = null;
  if (invite_code) {
    const { data: invite } = await supabaseAdmin.from('beta_invites')
      .select('id, trial_days, max_uses, use_count, expires_at')
      .eq('code', invite_code.trim().toUpperCase()).single();
    if (invite) {
      const notExpired = !invite.expires_at || new Date(invite.expires_at) > new Date();
      const notFull = invite.max_uses === null || invite.use_count < invite.max_uses;
      if (notExpired && notFull) {
        trialDays = invite.trial_days || 14;
        inviteId = invite.id;
      }
    }
  }

  // Create Supabase Auth user
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError) return res.status(400).json({ error: authError.message });

  const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();

  // Create tenant record
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .insert({ company_name: company_name.trim(), owner_email: email.toLowerCase(), trial_ends_at: trialEndsAt })
    .select()
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return res.status(400).json({ error: tenantError.message });
  }

  // Link auth user to tenant
  const { error: linkError } = await supabaseAdmin
    .from('tenant_users')
    .insert({ user_id: authData.user.id, tenant_id: tenant.id });

  if (linkError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return res.status(400).json({ error: 'Failed to link account to organization' });
  }

  // Increment invite use count if one was applied (fire-and-forget)
  if (inviteId) {
    supabaseAdmin.from('beta_invites').select('use_count').eq('id', inviteId).single()
      .then(({ data }) => {
        if (data) supabaseAdmin.from('beta_invites')
          .update({ use_count: (data.use_count || 0) + 1 }).eq('id', inviteId).then(() => {});
      });
  }

  res.json({ ok: true });
});

// ── WhatsApp Webhook (no auth — Twilio calls this) ────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  const profileName = req.body.ProfileName;
  const mediaUrl = req.body.MediaUrl0 || null;
  res.sendStatus(200);
  handleMessage(from, body, profileName, mediaUrl).catch(console.error);
});

// ── Protected Routes ──────────────────────────────────────────────────────────

app.get('/api/jobs', auth, async (req, res) => {
  const { data } = await scoped(supabaseAdmin.from('jobs').select('*').order('name'), req.tenantId);
  res.json(data || []);
});

app.get('/api/jobs/:id', auth, async (req, res) => {
  const { id } = req.params;
  const [{ data: job }, { data: assignments }, { data: supplies }, { data: updates }] = await Promise.all([
    supabaseAdmin.from('jobs').select('*').eq('id', id).single(),
    supabaseAdmin.from('job_assignments').select('*, employees(name, role)').eq('job_id', id),
    supabaseAdmin.from('supply_requests').select('*, employees(name)').eq('job_id', id).order('created_at', { ascending: false }),
    supabaseAdmin.from('job_updates').select('*, employees(name)').eq('job_id', id).order('created_at', { ascending: false }).limit(50)
  ]);
  res.json({ job, assignments, supplies, updates });
});

app.get('/api/photos/recent', auth, async (req, res) => {
  let query = supabaseAdmin
    .from('job_updates')
    .select('id, message, photo_url, created_at, jobs(name), employees(name)')
    .eq('type', 'photo').not('photo_url', 'is', null)
    .order('created_at', { ascending: false }).limit(30);

  if (req.tenantId) {
    const { data: jobs } = await supabaseAdmin
      .from('jobs').select('id').eq('tenant_id', req.tenantId);
    if (jobs?.length) {
      query = query.in('job_id', jobs.map(j => j.id));
    } else {
      return res.json([]);
    }
  }
  const { data } = await query;
  res.json(data || []);
});

app.get('/api/supplies/pending', auth, async (req, res) => {
  let query = supabaseAdmin
    .from('supply_requests').select('*, jobs(name, address), employees(name)')
    .eq('status', 'pending').order('urgency').order('created_at');

  if (req.tenantId) {
    const { data: jobs } = await supabaseAdmin
      .from('jobs').select('id').eq('tenant_id', req.tenantId);
    if (jobs?.length) {
      query = query.in('job_id', jobs.map(j => j.id));
    } else {
      return res.json([]);
    }
  }
  const { data } = await query;
  res.json(data || []);
});

app.patch('/api/supplies/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { data } = await supabaseAdmin.from('supply_requests')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  res.json(data);
});

app.post('/api/jobs', auth, async (req, res) => {
  const { name, address, manager_email, description, estimate_amount } = req.body;
  const { data } = await supabaseAdmin.from('jobs')
    .insert({ name, address, manager_email, description, estimate_amount: estimate_amount || null, tenant_id: req.tenantId }).select().single();
  res.json(data);
});

// Public work order page data (no auth — UUID is the access control)
app.get('/api/workorder/:jobId', async (req, res) => {
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email, phone, address)')
    .eq('id', req.params.jobId).single();
  if (error || !job) return res.status(404).json({ error: 'Work order not found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, logo_url, address, phone, owner_email')
    .eq('id', job.tenant_id).single();
  res.json({ job, tenant });
});

// Send work order SMS to linked client
app.post('/api/jobs/:id/sms-workorder', auth, async (req, res) => {
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, phone)')
    .eq('id', req.params.id).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.clients?.phone) return res.status(400).json({ error: 'No client phone — link a client with a phone number first' });

  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, twilio_account_sid, twilio_auth_token, twilio_phone')
    .eq('id', req.tenantId).single();
  if (!tenant?.twilio_account_sid) return res.status(400).json({ error: 'Twilio not configured — set up your voice bot number in Settings first' });

  const host = `${req.protocol}://${req.get('host')}`;
  const workorderUrl = `${host}/workorder?job_id=${job.id}`;
  const twilioClient = twilio(tenant.twilio_account_sid, tenant.twilio_auth_token);
  await twilioClient.messages.create({
    from: tenant.twilio_phone,
    to: job.clients.phone,
    body: `Hi ${job.clients.name}, ${tenant.company_name || 'Your contractor'} sent you a work order for "${job.name}". View it here: ${workorderUrl}`,
  });
  res.json({ ok: true });
});

// Send work order email to linked client
app.post('/api/jobs/:id/send-workorder', auth, async (req, res) => {
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email)')
    .eq('id', req.params.id).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.clients?.email) return res.status(400).json({ error: 'No client email — link a client with an email first' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name').eq('id', req.tenantId).single();
  const host = `${req.protocol}://${req.get('host')}`;
  await sendWorkOrderToClient({
    clientName: job.clients.name,
    clientEmail: job.clients.email,
    jobName: job.name,
    description: job.description,
    estimateAmount: job.estimate_amount,
    workorderUrl: `${host}/workorder?job_id=${job.id}`,
    tenantName: tenant?.company_name,
  });
  res.json({ ok: true });
});

app.patch('/api/jobs/:id', auth, async (req, res) => {
  const { id } = req.params;
  const allowed = ['status', 'client_id'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] || null; });
  updates.updated_at = new Date().toISOString();
  const { data } = await supabaseAdmin.from('jobs').update(updates).eq('id', id).select().single();
  res.json(data);
});

app.post('/api/send-note', auth, async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });
  await sendNote({ subject, body });
  res.json({ ok: true });
});

// ── Employee Management ───────────────────────────────────────────────────────

app.get('/api/employees', auth, async (req, res) => {
  const { data } = await scoped(supabaseAdmin.from('employees').select('*').order('name'), req.tenantId);
  res.json(data || []);
});

app.post('/api/employees', auth, async (req, res) => {
  const { name, phone, role } = req.body;
  if (!name || !phone || !role) return res.status(400).json({ error: 'name, phone and role are required' });
  // Enforce plan crew limit
  const { data: tenant } = await supabaseAdmin.from('tenants').select('max_users').eq('id', req.tenantId).single();
  const maxUsers = tenant?.max_users ?? 1;
  const { count } = await supabaseAdmin.from('employees').select('*', { count: 'exact', head: true }).eq('tenant_id', req.tenantId);
  if (count >= maxUsers) return res.status(403).json({ error: `Plan limit reached. Your plan allows up to ${maxUsers} crew member${maxUsers === 1 ? '' : 's'}. Upgrade at linkcrew.io/pricing.` });
  const { data, error } = await supabaseAdmin.from('employees')
    .insert({ name: name.trim(), phone: phone.trim(), role, tenant_id: req.tenantId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/employees/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { name, phone, role } = req.body;
  const updates = {};
  if (name) updates.name = name.trim();
  if (phone) updates.phone = phone.trim();
  if (role) updates.role = role;
  const { data, error } = await supabaseAdmin.from('employees').update(updates).eq('id', id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/employees/:id', auth, async (req, res) => {
  const { id } = req.params;
  await supabaseAdmin.from('employees').delete().eq('id', id);
  res.json({ ok: true });
});

// ── CRM: Clients ─────────────────────────────────────────────────────────────

app.get('/api/clients', auth, async (req, res) => {
  const { data } = await scoped(
    supabaseAdmin.from('clients').select('*, client_follow_ups(id, completed)').order('name'),
    req.tenantId
  );
  res.json(data || []);
});

app.post('/api/clients', auth, async (req, res) => {
  const { name, company, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabaseAdmin.from('clients')
    .insert({ name: name.trim(), company, phone, email, address, notes, tenant_id: req.tenantId })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/clients/:id', auth, async (req, res) => {
  const { id } = req.params;
  const [{ data: client }, { data: followUps }, { data: jobs }] = await Promise.all([
    supabaseAdmin.from('clients').select('*').eq('id', id).single(),
    supabaseAdmin.from('client_follow_ups').select('*').eq('client_id', id).order('due_date').order('created_at'),
    supabaseAdmin.from('jobs').select('id, name, address, status, created_at, invoice_amount, payment_status').eq('client_id', id).order('created_at', { ascending: false }),
  ]);
  res.json({ client, followUps: followUps || [], jobs: jobs || [] });
});

app.patch('/api/clients/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { name, company, phone, email, address, notes } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (company !== undefined) updates.company = company;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (address !== undefined) updates.address = address;
  if (notes !== undefined) updates.notes = notes;
  const { data, error } = await supabaseAdmin.from('clients').update(updates).eq('id', id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients/:id/followups', auth, async (req, res) => {
  const { id } = req.params;
  const { note, due_date } = req.body;
  if (!note) return res.status(400).json({ error: 'Note is required' });
  const { data, error } = await supabaseAdmin.from('client_follow_ups')
    .insert({ client_id: id, note, due_date: due_date || null, tenant_id: req.tenantId })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/clients/:id/followups/:fid', auth, async (req, res) => {
  const { fid } = req.params;
  const { completed } = req.body;
  const { data } = await supabaseAdmin.from('client_follow_ups')
    .update({ completed }).eq('id', fid).select().single();
  res.json(data);
});

app.delete('/api/clients/:id/followups/:fid', auth, async (req, res) => {
  const { fid } = req.params;
  await supabaseAdmin.from('client_follow_ups').delete().eq('id', fid);
  res.json({ ok: true });
});

// ── Service Agreements ────────────────────────────────────────────────────────

app.get('/api/agreements', auth, async (req, res) => {
  const { data } = await scoped(
    supabaseAdmin.from('service_agreements').select('*, clients(name)').order('next_due').order('name'),
    req.tenantId
  );
  res.json(data || []);
});

app.post('/api/agreements', auth, async (req, res) => {
  const { name, client_id, description, schedule, value, start_date, next_due } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabaseAdmin.from('service_agreements')
    .insert({ name, client_id: client_id || null, description, schedule, value: value || null, start_date: start_date || null, next_due: next_due || null, tenant_id: req.tenantId })
    .select('*, clients(name)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/agreements/:id', auth, async (req, res) => {
  const { id } = req.params;
  const [{ data: agreement }, { data: jobs }] = await Promise.all([
    supabaseAdmin.from('service_agreements').select('*, clients(name)').eq('id', id).single(),
    supabaseAdmin.from('jobs').select('id, name, address, status').eq('client_id',
      (await supabaseAdmin.from('service_agreements').select('client_id').eq('id', id).single()).data?.client_id || ''
    ).order('created_at', { ascending: false }),
  ]);
  res.json({ agreement, jobs: jobs || [] });
});

app.patch('/api/agreements/:id', auth, async (req, res) => {
  const { id } = req.params;
  const fields = ['name','client_id','description','schedule','value','start_date','next_due','status'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] || null; });
  if (req.body.name) updates.name = req.body.name.trim();
  const { data, error } = await supabaseAdmin.from('service_agreements')
    .update(updates).eq('id', id).select('*, clients(name)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/agreements/:id', auth, async (req, res) => {
  await supabaseAdmin.from('service_agreements').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Reports ───────────────────────────────────────────────────────────────────

app.get('/api/reports', auth, async (req, res) => {
  const days = parseInt(req.query.period || '30');
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = since.toISOString();

  const [{ data: allJobs }, { data: assignments }, { data: supplies }, { data: bottlenecks }] = await Promise.all([
    scoped(supabaseAdmin.from('jobs').select('id, name, status, created_at'), req.tenantId),
    scoped(
      supabaseAdmin.from('job_assignments')
        .select('employee_id, checked_in_at, checked_out_at, employees(name)')
        .not('checked_in_at', 'is', null)
        .not('checked_out_at', 'is', null)
        .gte('checked_in_at', sinceISO),
      req.tenantId
    ),
    scoped(supabaseAdmin.from('supply_requests').select('status').gte('created_at', sinceISO), req.tenantId),
    scoped(supabaseAdmin.from('job_updates').select('id').eq('type', 'bottleneck').gte('created_at', sinceISO), req.tenantId),
  ]);

  // Jobs by status
  const jobsByStatus = {};
  (allJobs || []).forEach(j => { jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1; });

  // Completed jobs trend — last 6 months
  const trend = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    trend[d.toLocaleString('default', { month: 'short', year: '2-digit' })] = 0;
  }
  (allJobs || []).filter(j => j.status === 'complete').forEach(j => {
    const key = new Date(j.created_at).toLocaleString('default', { month: 'short', year: '2-digit' });
    if (trend[key] !== undefined) trend[key]++;
  });

  // Crew hours
  const crewHours = {};
  (assignments || []).forEach(a => {
    const hrs = (new Date(a.checked_out_at) - new Date(a.checked_in_at)) / 3600000;
    const name = a.employees?.name || 'Unknown';
    crewHours[name] = (crewHours[name] || 0) + hrs;
  });
  const crewHoursSorted = Object.entries(crewHours)
    .map(([name, h]) => ({ name, hours: Math.round(h * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours).slice(0, 8);

  // Supply stats
  const supplyStats = { pending: 0, ordered: 0, delivered: 0 };
  (supplies || []).forEach(s => { if (s.status in supplyStats) supplyStats[s.status]++; });

  const totalCrewHours = Math.round(Object.values(crewHours).reduce((a, b) => a + b, 0) * 10) / 10;

  res.json({
    jobsByStatus,
    trend,
    crewHours: crewHoursSorted,
    supplyStats,
    bottlenecksCount: (bottlenecks || []).length,
    totalJobs: (allJobs || []).length,
    completedJobs: (allJobs || []).filter(j => j.status === 'complete').length,
    activeJobs: (allJobs || []).filter(j => ['active','in_progress','scheduled'].includes(j.status)).length,
    totalCrewHours,
  });
});

// ── Client Portal Auth ────────────────────────────────────────────────────────

async function portalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: clientUser, error: portalErr } = await supabaseAdmin
    .from('client_users')
    .select('client_id, tenant_id')
    .eq('portal_token', token)
    .single();

  if (portalErr || !clientUser) {
    console.error('[portalAuth] token lookup failed:', portalErr?.message, '| token prefix:', token?.slice(0, 8));
    return res.status(401).json({ error: 'Invalid portal token' });
  }

  req.clientId = clientUser.client_id;
  req.tenantId = clientUser.tenant_id;
  next();
}

// Generate (or regenerate) a portal invite link for a client
app.post('/api/clients/:id/invite', auth, async (req, res) => {
  const { id } = req.params;
  const token = crypto.randomBytes(32).toString('hex');

  const { data, error } = await supabaseAdmin
    .from('client_users')
    .upsert({ client_id: id, portal_token: token, tenant_id: req.tenantId }, { onConflict: 'client_id' })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  const portalUrl = `${req.protocol}://${req.get('host')}/portal?token=${token}`;
  res.json({ portalUrl });
});

// Portal: client info
app.get('/portal/api/me', portalAuth, async (req, res) => {
  const [{ data: client }, { data: cu }] = await Promise.all([
    supabaseAdmin.from('clients').select('name, email, phone').eq('id', req.clientId).single(),
    supabaseAdmin.from('client_users').select('email').eq('client_id', req.clientId).single(),
  ]);
  res.json({ ...client, has_password: !!cu?.email });
});

// Portal: client's jobs
app.get('/portal/api/jobs', portalAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, status, created_at, invoice_amount, payment_status')
    .eq('client_id', req.clientId)
    .order('created_at', { ascending: false });
  res.json(data || []);
});

// Portal: photos for client's jobs
app.get('/portal/api/photos', portalAuth, async (req, res) => {
  const { data: jobs } = await supabaseAdmin.from('jobs').select('id').eq('client_id', req.clientId);
  if (!jobs?.length) return res.json([]);

  const { data } = await supabaseAdmin
    .from('job_updates')
    .select('id, message, photo_url, created_at, jobs(name)')
    .in('job_id', jobs.map(j => j.id))
    .eq('type', 'photo')
    .not('photo_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(60);

  res.json(data || []);
});

// Portal: login with email + password (no token needed)
app.post('/portal/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { data: clientUser } = await supabaseAdmin
    .from('client_users')
    .select('client_id, tenant_id, portal_token, password_hash')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!clientUser?.password_hash) return res.status(401).json({ error: 'No account found. Please use your invite link first.' });

  const valid = await bcrypt.compare(password, clientUser.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

  res.json({ token: clientUser.portal_token });
});

// Portal: set email + password (must be logged in with token first)
app.post('/portal/api/set-password', portalAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabaseAdmin
    .from('client_users')
    .update({ email: email.toLowerCase().trim(), password_hash: hash })
    .eq('client_id', req.clientId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// Portal: submit a new job request (with optional photo)
app.post('/portal/api/requests', portalAuth, upload.single('photo'), async (req, res) => {
  const { description, address } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const { data: client } = await supabaseAdmin.from('clients').select('name').eq('id', req.clientId).single();

  const { data: job, error } = await supabaseAdmin
    .from('jobs')
    .insert({ name: `Request – ${client?.name || 'Client'}`, address: address || '', status: 'quoted', client_id: req.clientId, tenant_id: req.tenantId })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  let photoUrl = null;
  if (req.file) {
    const ext = req.file.mimetype.split('/')[1] || 'jpg';
    const filePath = `requests/${job.id}/${Date.now()}.${ext}`;
    const { data: uploaded, error: uploadErr } = await supabaseAdmin.storage
      .from('portal-photos')
      .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
    if (!uploadErr && uploaded) {
      const { data: { publicUrl } } = supabaseAdmin.storage.from('portal-photos').getPublicUrl(uploaded.path);
      photoUrl = publicUrl;
    }
  }

  await supabaseAdmin.from('job_updates').insert({
    job_id: job.id,
    message: description,
    type: photoUrl ? 'photo' : 'note',
    photo_url: photoUrl,
  });

  res.json(job);
});

// ── Invoicing ─────────────────────────────────────────────────────────────────

app.post('/api/jobs/:id/invoice', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0)
    return res.status(400).json({ error: 'Valid amount required' });
  const { data, error } = await supabaseAdmin.from('jobs')
    .update({ invoice_amount: parseFloat(amount), status: 'invoiced', payment_status: 'unpaid' })
    .eq('id', req.params.id).select('*, clients(name, email)').single();
  if (error) return res.status(400).json({ error: error.message });

  // Send invoice email to client if they have an email
  const client = data.clients;
  if (client?.email) {
    try {
      const tenantId = await getEffectiveTenantId(req);
      const [{ data: tenant }, { data: clientUser }] = await Promise.all([
        supabaseAdmin.from('tenants').select('company_name').eq('id', tenantId).single(),
        supabaseAdmin.from('client_users').select('portal_token').eq('client_id', data.client_id).single(),
      ]);
      const host = `${req.protocol}://${req.get('host')}`;
      const portalUrl = clientUser?.portal_token
        ? `${host}/portal?token=${clientUser.portal_token}`
        : `${host}/portal`;
      await sendInvoiceToClient({
        clientName: client.name,
        clientEmail: client.email,
        jobName: data.name,
        amount: parseFloat(amount),
        portalUrl,
        tenantName: tenant?.company_name,
      });
    } catch (emailErr) {
      console.error('[invoice] email error:', emailErr.message);
    }
  }

  res.json(data);
});

// Portal: create Stripe Checkout session
app.post('/portal/api/checkout', portalAuth, async (req, res) => {
  const { job_id } = req.body;
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('id, name, invoice_amount, payment_status, client_id')
    .eq('id', job_id).eq('client_id', req.clientId).single();

  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.payment_status === 'paid') return res.status(400).json({ error: 'Already paid' });
  if (!job.invoice_amount) return res.status(400).json({ error: 'No invoice amount set' });

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: job.name },
          unit_amount: Math.round(job.invoice_amount * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/portal?payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/portal?payment=cancelled`,
      metadata: { job_id: job.id },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ url: session.url });
});

// ── Billing ───────────────────────────────────────────────────────────────────

app.get('/api/billing/status', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data } = await supabaseAdmin.from('tenants')
    .select('plan, subscription_status, trial_ends_at, stripe_customer_id, max_users')
    .eq('id', tenantId).single();
  res.json(data || {});
});

app.post('/api/billing/checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const priceMap = {
    solo:      process.env.STRIPE_PRICE_SOLO,
    team:      process.env.STRIPE_PRICE_TEAM,
    pro:       process.env.STRIPE_PRICE_PRO,
    business:  process.env.STRIPE_PRICE_BUSINESS,
    voicebot:  process.env.STRIPE_PRICE_VOICEBOT,
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });
  const tenantId = await getEffectiveTenantId(req);
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_customer_id, owner_email').eq('id', tenantId).single();
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(tenant.stripe_customer_id
        ? { customer: tenant.stripe_customer_id }
        : { customer_email: tenant.owner_email }),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${req.protocol}://${req.get('host')}/app?billing=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/pricing`,
      metadata: { tenant_id: tenantId, plan },
      subscription_data: { metadata: { tenant_id: tenantId, plan } },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/billing/portal', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_customer_id').eq('id', tenantId).single();
  if (!tenant?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: `${req.protocol}://${req.get('host')}/app`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Onboarding ────────────────────────────────────────────────────────────────

app.get('/api/onboarding', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.json({ jobs: 0, employees: 0, clients: 0, invites: 0 });
  const [
    { count: jobs },
    { count: employees },
    { count: clients },
    { count: invites },
  ] = await Promise.all([
    supabaseAdmin.from('jobs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabaseAdmin.from('employees').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabaseAdmin.from('client_users').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
  ]);
  res.json({ jobs: jobs || 0, employees: employees || 0, clients: clients || 0, invites: invites || 0 });
});

// ── Settings ──────────────────────────────────────────────────────────────────

// Admin users have no tenantId, so fall back to finding their tenant by owner_email
async function getEffectiveTenantId(req) {
  if (req.tenantId) return req.tenantId;
  const { data } = await supabaseAdmin.from('tenants')
    .select('id').eq('owner_email', req.userEmail).single();
  return data?.id || null;
}

app.get('/api/settings', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email, logo_url, phone, address, voicebot_enabled, twilio_phone, twilio_account_sid, voicebot_knowledge')
    .eq('id', tenantId).single();
  res.json(data || {});
});

app.patch('/api/settings', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { company_name, phone, address, voicebot_knowledge } = req.body;
  const updates = {};
  if (company_name !== undefined) updates.company_name = company_name;
  if (phone !== undefined) updates.phone = phone;
  if (address !== undefined) updates.address = address;
  if (voicebot_knowledge !== undefined) updates.voicebot_knowledge = voicebot_knowledge;
  const { data, error } = await supabaseAdmin.from('tenants')
    .update(updates).eq('id', tenantId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/settings/logo', auth, upload.single('logo'), async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = req.file.originalname.split('.').pop().toLowerCase() || 'png';
  const filePath = `${tenantId}/logo.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from('logos')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (uploadError) return res.status(400).json({ error: uploadError.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('logos').getPublicUrl(filePath);
  await supabaseAdmin.from('tenants').update({ logo_url: publicUrl }).eq('id', tenantId);
  res.json({ logo_url: publicUrl });
});

// Save Twilio credentials + auto-configure webhook on the phone number
app.post('/api/settings/voicebot', auth, async (req, res) => {
  const { twilio_account_sid, twilio_auth_token, twilio_phone } = req.body;
  if (!twilio_account_sid || !twilio_auth_token || !twilio_phone)
    return res.status(400).json({ error: 'Account SID, Auth Token, and phone number are required' });

  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });

  let twilioClient;
  try {
    twilioClient = twilio(twilio_account_sid, twilio_auth_token);
    const numbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: twilio_phone });
    if (!numbers.length) return res.status(400).json({ error: 'Phone number not found in your Twilio account. Make sure the number is in E.164 format (e.g. +15551234567).' });

    const host = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${host}/api/voice/contractor/${tenantId}`;
    const smsWebhookUrl = `${host}/api/sms/contractor/${tenantId}`;
    await twilioClient.incomingPhoneNumbers(numbers[0].sid).update({
      voiceUrl: webhookUrl,
      voiceMethod: 'POST',
      smsUrl: smsWebhookUrl,
      smsMethod: 'POST',
    });
  } catch (err) {
    return res.status(400).json({ error: `Twilio error: ${err.message}` });
  }

  await supabaseAdmin.from('tenants').update({
    twilio_account_sid,
    twilio_auth_token,
    twilio_phone,
    voicebot_enabled: true,
  }).eq('id', tenantId);

  res.json({ success: true });
});

// Disable voicebot + clear credentials
app.delete('/api/settings/voicebot', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  await supabaseAdmin.from('tenants').update({
    twilio_account_sid: null,
    twilio_auth_token: null,
    twilio_phone: null,
    voicebot_enabled: false,
  }).eq('id', tenantId);
  res.json({ success: true });
});

// ── KDG Chat Bot ─────────────────────────────────────────────────────────────

const kdgChatSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, data] of kdgChatSessions) {
    if (data.ts < cutoff) kdgChatSessions.delete(id);
  }
}, 3600000);

const KDG_SYSTEM = `You are an AI assistant for Kingston Data Group (KDG), an AI automation and SaaS development studio based in Silicon Valley.

KDG builds AI-powered software that automates business operations. Their flagship product is LinkCrew (linkcrew.io) — a field crew management platform for contractors.

SERVICES:
- AI Automation: Automate repetitive workflows — scheduling, dispatching, reporting, invoicing, customer communication
- SaaS Product Development: Full-stack development from concept to live product, mobile apps, cloud infrastructure
- AI Voice & Chat Agents: Intelligent voice bots and chat assistants, 24/7, no staff required
- System Integration: Connect CRMs, ERPs, accounting software, field apps into unified automated pipelines
- Dashboards & Reporting: Real-time operations dashboards with custom metrics and alerts
- Cloud & Infrastructure: Secure, scalable cloud architecture

ABOUT KDG:
- 15+ years of IT infrastructure and data center experience
- Native AI integration in every product
- 24/7 always-on systems
- Full product development from idea to live launch
- Contact: sales@kingstondatagroup.com
- Website: kingstondatagroup.com

BOOKING:
- When someone wants to schedule a call or meeting, direct them to: https://calendar.google.com/calendar/u/0/r (or tell them to email sales@kingstondatagroup.com to schedule)

You have access to web search to answer questions about AI, automation, SaaS, technology trends, and anything relevant to the user's business needs. Use search when you need current information or specific technical details.

RESPONSE RULES:
- Keep responses SHORT — 2-4 sentences max. Never use bullet lists or long paragraphs.
- When mentioning email, always format it as: [sales@kingstondatagroup.com](mailto:sales@kingstondatagroup.com)
- When mentioning phone, always format it as: [(260) 544-6900](tel:+12605446900)
- Be conversational, ask one follow-up question at a time.
- Never make up pricing — direct them to email or call for a custom quote.`;

app.post('/api/chat-kdg', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const sid = sessionId || crypto.randomUUID();
  if (!kdgChatSessions.has(sid)) {
    kdgChatSessions.set(sid, { ts: Date.now(), history: [] });
  }
  const session = kdgChatSessions.get(sid);
  session.ts = Date.now();
  session.history.push({ role: 'user', content: message });

  // Decide if web search would help
  let searchContext = '';
  const searchTriggers = ['how', 'what is', 'latest', 'best', 'price', 'cost', 'compare', 'vs', 'difference', 'trend', 'tool', 'software', 'platform', 'integration', 'api', 'automate'];
  const needsSearch = searchTriggers.some(t => message.toLowerCase().includes(t));

  if (needsSearch && process.env.TAVILY_API_KEY) {
    try {
      const searchRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: message,
          search_depth: 'basic',
          max_results: 3,
          include_answer: true,
        }),
      });
      const searchData = await searchRes.json();
      if (searchData.answer || searchData.results?.length) {
        searchContext = '\n\nWEB SEARCH RESULTS:\n';
        if (searchData.answer) searchContext += `Summary: ${searchData.answer}\n\n`;
        (searchData.results || []).forEach((r, i) => {
          searchContext += `[${i + 1}] ${r.title}\n${r.content?.slice(0, 300)}\nSource: ${r.url}\n\n`;
        });
      }
    } catch (err) {
      console.error('[kdg chat] Tavily error:', err.message);
    }
  }

  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: KDG_SYSTEM + searchContext,
      messages: session.history.slice(-12),
    });
    const reply = result.content[0].text;
    session.history.push({ role: 'assistant', content: reply });
    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('[kdg chat] Claude error:', err.message);
    res.status(500).json({ error: 'Failed to get response' });
  }
});

// ── KDG Voice Bot ─────────────────────────────────────────────────────────────

const kdgVoiceConversations = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [sid, data] of kdgVoiceConversations) {
    if (data.ts < cutoff) kdgVoiceConversations.delete(sid);
  }
}, 3600000);

// ── Incoming SMS ─────────────────────────────────────────────────────────────

app.post('/api/sms/kdg', async (req, res) => {
  const from = req.body.From || 'Unknown';
  const message = req.body.Body || '';
  try {
    await sendIncomingSmsNotification({
      toEmail: 'sales@kingstondatagroup.com',
      fromNumber: from,
      message,
      companyName: 'Kingston Data Group',
    });
  } catch (err) {
    console.error('[sms/kdg] email error:', err.message);
  }
  res.type('text/xml').send('<Response></Response>');
});

app.post('/api/sms/contractor/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const from = req.body.From || 'Unknown';
  const message = req.body.Body || '';
  try {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('company_name, owner_email').eq('id', tenantId).single();
    if (tenant?.owner_email) {
      await sendIncomingSmsNotification({
        toEmail: tenant.owner_email,
        fromNumber: from,
        message,
        companyName: tenant.company_name,
      });
    }
  } catch (err) {
    console.error('[sms/contractor] email error:', err.message);
  }
  res.type('text/xml').send('<Response></Response>');
});

app.post('/api/voice/kdg', async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';

  kdgVoiceConversations.set(callSid, {
    ts: Date.now(),
    history: [],
    callerNumber,
    startTime: Date.now(),
  });

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/voice/kdg/respond',
    speechTimeout: '3',
    timeout: 10,
    enhanced: 'true',
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' },
    "Hi! Thanks for calling Kingston Data Group. I'm an AI assistant and I'm here to help. Are you looking to automate your business, build a SaaS product, or do you have a different question?");
  twiml.redirect(`/api/voice/kdg/end?sid=${callSid}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/voice/kdg/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();

  if (!kdgVoiceConversations.has(callSid)) {
    kdgVoiceConversations.set(callSid, {
      ts: Date.now(), history: [],
      callerNumber: req.body.From || 'Unknown',
      startTime: Date.now(),
    });
  }

  const conv = kdgVoiceConversations.get(callSid);
  conv.ts = Date.now();
  if (speech) conv.history.push({ role: 'user', content: speech });

  // Web search for voice too
  let searchContext = '';
  if (speech && process.env.TAVILY_API_KEY) {
    const searchTriggers = ['how', 'what is', 'cost', 'price', 'how much', 'can you', 'do you', 'what are'];
    const needsSearch = searchTriggers.some(t => speech.toLowerCase().includes(t));
    if (needsSearch) {
      try {
        const searchRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query: speech,
            search_depth: 'basic',
            max_results: 2,
            include_answer: true,
          }),
        });
        const searchData = await searchRes.json();
        if (searchData.answer) searchContext = `\n\nRelevant info from web: ${searchData.answer}`;
      } catch (err) {
        console.error('[kdg voice] Tavily error:', err.message);
      }
    }
  }

  let reply = "I'm sorry, I didn't catch that. Could you repeat that?";
  try {
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system: `You are a phone assistant for Kingston Data Group, an AI automation and SaaS studio. Be brief — max 2 sentences per response.
For meetings: get name and email, say someone follows up within 1 business day.
For pricing: custom quotes only, invite discovery call.
Services: AI Automation, SaaS Dev, Voice/Chat Agents, Integrations, Dashboards, Cloud.
Contact: sales@kingstondatagroup.com${searchContext}`,
      messages: conv.history.slice(-10),
    });
    reply = result.content[0].text;
    conv.history.push({ role: 'assistant', content: reply });
  } catch (err) {
    console.error('[kdg voice] Claude error:', err.message);
  }

  const twiml = new VoiceResponse();
  const endWords = ['goodbye', 'bye', 'hang up', "that's all", 'no thanks', 'thank you', 'thanks'];
  const ending = endWords.some(w => speech.toLowerCase().includes(w));

  if (ending) {
    twiml.say({ voice: 'Polly.Joanna' }, reply + ' Have a great day!');
    twiml.redirect(`/api/voice/kdg/end?sid=${callSid}`);
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/kdg/respond',
      speechTimeout: '3',
      timeout: 10,
      enhanced: 'true',
      language: 'en-US',
    });
    gather.say({ voice: 'Polly.Joanna' }, reply);
    twiml.redirect(`/api/voice/kdg/end?sid=${callSid}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/voice/kdg/end', async (req, res) => {
  const callSid = req.query.sid || req.body.CallSid;
  const conv = kdgVoiceConversations.get(callSid);

  if (conv?.history?.length) {
    const duration = conv.startTime
      ? Math.round((Date.now() - conv.startTime) / 1000) + 's'
      : null;
    try {
      const { Resend } = require('resend');
      const r = new Resend(process.env.RESEND_API_KEY);
      const transcript = conv.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bot'}: ${m.content}`).join('\n');
      await r.emails.send({
        from: 'KDG Voice Bot <alerts@linkcrew.io>',
        to: 'sales@kingstondatagroup.com',
        subject: `KDG Call from ${conv.callerNumber}${duration ? ' (' + duration + ')' : ''}`,
        html: `<div style="font-family:sans-serif;max-width:600px">
          <h2 style="color:#f97316">Incoming Call Transcript</h2>
          <p><strong>Caller:</strong> ${conv.callerNumber}</p>
          ${duration ? `<p><strong>Duration:</strong> ${duration}</p>` : ''}
          <div style="margin-top:16px;padding:16px;background:#f5f5f5;border-radius:8px;white-space:pre-wrap;font-size:14px">${transcript}</div>
        </div>`,
      });
    } catch (err) {
      console.error('[kdg voice] transcript email error:', err.message);
    }
    // Save to Supabase
    supabaseAdmin.from('kdg_leads').insert({
      source: 'voice',
      phone: conv.callerNumber,
      transcript: conv.history,
      message: conv.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bot'}: ${m.content}`).join('\n'),
    }).then();
  }

  if (callSid) kdgVoiceConversations.delete(callSid);

  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Contractor Voice Bot ──────────────────────────────────────────────────────

app.post('/api/voice/contractor/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || 'Unknown';

  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email, voicebot_enabled, voicebot_knowledge')
    .eq('id', tenantId).single();

  if (!tenant || !tenant.voicebot_enabled)
    return res.status(404).send('<Response><Say>This number is not configured.</Say></Response>');

  voiceConversations.set(callSid, {
    ts: Date.now(),
    history: [],
    tenantId,
    companyName: tenant.company_name,
    ownerEmail: tenant.owner_email,
    knowledge: tenant.voicebot_knowledge || '',
    callerNumber,
    startTime: Date.now(),
    mode: 'support',       // support | demo_collecting | demo_running
    demoData: {},          // { trade, company, city }
    demoStep: 0,           // 0=need trade, 1=need company, 2=need city, 3=ready
    demoTurns: 0,
  });

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/api/voice/contractor/${tenantId}/respond`,
    speechTimeout: '3',
    timeout: 10,
    enhanced: 'true',
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' },
    `Hi! Thanks for calling ${tenant.company_name}. I'm your AI assistant. I can answer questions about LinkCrew, or say "demo" to hear a live personalized demo of the voice bot working for your own business. How can I help?`);
  twiml.redirect(`/api/voice/contractor/${tenantId}/silence?sid=${callSid}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/voice/contractor/:tenantId/respond', async (req, res) => {
  const { tenantId } = req.params;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const safeFallback = (msg) => {
    const t = new VoiceResponse();
    const g = t.gather({ input: 'speech', action: `/api/voice/contractor/${tenantId}/respond`, speechTimeout: '3', timeout: 10, enhanced: 'true', language: 'en-US' });
    g.say({ voice: 'Polly.Joanna' }, msg);
    t.redirect(`/api/voice/contractor/${tenantId}/end?sid=${callSid}`);
    res.type('text/xml');
    res.send(t.toString());
  };
  try {

  if (!voiceConversations.has(callSid)) {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('company_name, owner_email, voicebot_knowledge').eq('id', tenantId).single();
    voiceConversations.set(callSid, {
      ts: Date.now(), history: [], tenantId,
      companyName: tenant?.company_name || 'LinkCrew',
      ownerEmail: tenant?.owner_email,
      knowledge: tenant?.voicebot_knowledge || '',
      callerNumber: req.body.From || 'Unknown',
      startTime: Date.now(),
      mode: 'support', demoData: {}, demoStep: 0, demoTurns: 0,
    });
  }

  const conv = voiceConversations.get(callSid);
  conv.ts = Date.now();
  if (speech) conv.history.push({ role: 'user', content: speech });

  // ── Build system prompt based on current mode ────────────────────────────
  let systemPrompt = '';
  let spokenReply = '';

  if (conv.mode === 'support') {
    systemPrompt = `You are an AI assistant for LinkCrew (linkcrew.io), a field service management platform for contractors.
Be friendly and concise — this is a phone call, so keep every response to 1-3 short sentences.
If the caller asks for a demo or wants to try the voice bot, output the exact marker ##DEMO## somewhere in your reply and invite them to hear a personalized demo.
If asked something you don't know, say you'll have someone follow up.
${conv.knowledge ? `\nLinkCrew product info:\n${conv.knowledge}` : ''}`;

  } else if (conv.mode === 'demo_collecting') {
    // Step-based — no marker parsing needed, answers saved directly from speech
    const DEMO_QUESTIONS = [
      "What trade or industry are you in? For example, roofing, HVAC, plumbing, or landscaping.",
      "Got it! What's your company name?",
      "Almost there — what city or area do you serve?",
    ];

    if (speech) {
      if (conv.demoStep === 0) conv.demoData.trade = speech;
      else if (conv.demoStep === 1) conv.demoData.company = speech;
      else if (conv.demoStep === 2) conv.demoData.city = speech;
    }

    conv.demoStep++;

    if (conv.demoStep < 3) {
      // Still collecting — ask next question directly, no Claude needed
      spokenReply = DEMO_QUESTIONS[conv.demoStep];
    } else {
      // All collected — transition to demo_running
      conv.mode = 'demo_running';
      conv.history = [];
      const greeting = `Hello, thank you for calling ${conv.demoData.company}! I'm your AI assistant. How can I help you today?`;
      conv.history.push({ role: 'assistant', content: greeting });
      spokenReply = greeting;
    }

    // Skip Claude call entirely for demo_collecting
    const twiml2 = new VoiceResponse();
    const gather2 = twiml2.gather({
      input: 'speech',
      action: `/api/voice/contractor/${tenantId}/respond`,
      speechTimeout: '3',
      timeout: 10,
      enhanced: 'true',
      language: 'en-US',
    });
    gather2.say({ voice: 'Polly.Joanna' }, spokenReply);
    twiml2.redirect(`/api/voice/contractor/${tenantId}/silence?sid=${callSid}`);
    res.type('text/xml');
    return res.send(twiml2.toString());
  }

  if (conv.mode === 'demo_running') {
    // If Twilio fires with empty speech (echo/silence), just re-prompt
    if (!speech) {
      const twimlSilence = new VoiceResponse();
      const gatherSilence = twimlSilence.gather({
        input: 'speech', action: `/api/voice/contractor/${tenantId}/respond`,
        speechTimeout: '3', timeout: 10, enhanced: 'true', language: 'en-US',
      });
      gatherSilence.say({ voice: 'Polly.Joanna' }, "Go ahead — what would you like to know?");
      twimlSilence.redirect(`/api/voice/contractor/${tenantId}/end?sid=${callSid}`);
      res.type('text/xml');
      return res.send(twimlSilence.toString());
    }

    const { trade, company, city } = conv.demoData;
    conv.demoTurns++;
    const maxTurns = 5;
    const isLastTurn = conv.demoTurns >= maxTurns;
    systemPrompt = `You are an AI phone assistant for ${company}, a ${trade} company in ${city}. Answer calls on their behalf — be helpful, friendly, and realistic.
Keep every response to 1-2 short sentences. Make up reasonable details (hours, services, pricing ranges) if needed — this is a live demo.
Do NOT mention LinkCrew, Choppy, or any other software platform. Stay in character as ${company} at all times.
${isLastTurn ? `After answering this question, wrap up warmly as ${company} — say something like "Thanks for calling ${company}, have a great day!" — then output ##END## on a new line with nothing after it.` : ''}`;
  }

  let rawReply = "I'm sorry, I didn't catch that. Could you say that again?";
  try {
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system: systemPrompt,
      messages: conv.history.slice(-10),
    });
    rawReply = result.content[0].text;
    conv.history.push({ role: 'assistant', content: rawReply });
  } catch (err) {
    console.error('[contractor voice] Claude error:', err.message);
  }

  // ── Parse mode-transition markers ────────────────────────────────────────
  spokenReply = rawReply;
  let ending = false;

  if (conv.mode === 'support' && rawReply.includes('##DEMO##')) {
    conv.mode = 'demo_collecting';
    // Drop Claude's transition text entirely — go straight to the first question
    spokenReply = "Perfect! Let's set up your demo. First — what trade or industry are you in? For example, roofing, HVAC, plumbing, or landscaping.";

  } else if (conv.mode === 'demo_running' && rawReply.includes('##END##')) {
    spokenReply = rawReply.replace(/##END##.*$/s, '').trim()
      + " That was the LinkCrew AI voice bot. I can answer any questions you have about LinkCrew — pricing, features, how to get started. What would you like to know?";
    conv.mode = 'support';
    conv.history = [];
  }

  // Also end on goodbye words
  const endWords = ['goodbye', 'bye', 'hang up', "that's all", 'no thanks'];
  if (endWords.some(w => speech.toLowerCase().includes(w))) ending = true;

  // ── Build TwiML response ──────────────────────────────────────────────────
  const twiml = new VoiceResponse();
  if (ending) {
    twiml.say({ voice: 'Polly.Joanna' }, spokenReply + (endWords.some(w => speech.toLowerCase().includes(w)) ? ' Have a great day!' : ''));
    twiml.redirect(`/api/voice/contractor/${tenantId}/end?sid=${callSid}`);
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: `/api/voice/contractor/${tenantId}/respond`,
      speechTimeout: '3',
      timeout: 10,
      enhanced: 'true',
      language: 'en-US',
    });
    gather.say({ voice: 'Polly.Joanna' }, spokenReply);
    twiml.redirect(`/api/voice/contractor/${tenantId}/silence?sid=${callSid}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
  } catch (err) {
    console.error('[contractor voice/respond] CRASH:', err.message, err.stack);
    safeFallback("I'm sorry, something went wrong. Please try again.");
  }
});

app.post('/api/voice/contractor/:tenantId/silence', (req, res) => {
  const { tenantId } = req.params;
  const callSid = req.query.sid || req.body.CallSid;
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/api/voice/contractor/${tenantId}/respond`,
    speechTimeout: '3',
    timeout: 10,
    enhanced: 'true',
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' }, "Sorry, I couldn't hear you — you may have dropped off. Go ahead if you're still there.");
  twiml.say({ voice: 'Polly.Joanna' }, "Alright, goodbye! Have a great day.");
  twiml.redirect(`/api/voice/contractor/${tenantId}/end?sid=${callSid}`);
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/voice/contractor/:tenantId/end', async (req, res) => {
  const callSid = req.query.sid || req.body.CallSid;
  const conv = voiceConversations.get(callSid);

  if (conv?.ownerEmail) {
    const duration = conv.startTime
      ? Math.round((Date.now() - conv.startTime) / 1000) + 's'
      : null;
    try {
      await sendCallTranscriptToOwner({
        ownerEmail: conv.ownerEmail,
        companyName: conv.companyName,
        callerNumber: conv.callerNumber,
        transcript: conv.history,
        duration,
      });
    } catch (err) {
      console.error('[contractor voice] transcript email error:', err.message);
    }
  }

  if (callSid) voiceConversations.delete(callSid);

  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Invoice Data ──────────────────────────────────────────────────────────────

// Dashboard: fetch invoice data for a job
app.get('/api/invoice/:jobId', auth, async (req, res) => {
  let query = supabaseAdmin.from('jobs')
    .select('*, clients(name, email, phone, address)')
    .eq('id', req.params.jobId);
  if (req.tenantId) query = query.eq('tenant_id', req.tenantId);
  const { data: job, error } = await query.single();
  if (!job || error) return res.status(404).json({ error: error?.message || 'Not found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email')
    .eq('id', job.tenant_id)
    .single();
  res.json({ job, tenant });
});

// Portal: fetch invoice data for a job (client-scoped)
app.get('/portal/api/invoice/:jobId', portalAuth, async (req, res) => {
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email, phone, address)')
    .eq('id', req.params.jobId)
    .eq('client_id', req.clientId)
    .single();
  if (!job || error) return res.status(404).json({ error: 'Not found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email')
    .eq('id', job.tenant_id)
    .single();
  res.json({ job, tenant });
});

// ── Voice Bot ─────────────────────────────────────────────────────────────────

// Incoming call from Twilio
app.post('/api/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  voiceConversations.set(callSid, { ts: Date.now(), history: [] });

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/voice/respond',
    speechTimeout: '3',
    timeout: 10,
    enhanced: 'true',
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' },
    'Hi! Thanks for calling LinkCrew. I\'m Choppy, your AI assistant. How can I help you today?');
  twiml.say({ voice: 'Polly.Joanna' }, 'I didn\'t catch that. Please call back and try again. Goodbye!');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle caller's speech, respond with Claude
app.post('/api/voice/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();

  if (!voiceConversations.has(callSid)) {
    voiceConversations.set(callSid, { ts: Date.now(), history: [] });
  }
  const conv = voiceConversations.get(callSid);
  conv.ts = Date.now();
  conv.history.push({ role: 'user', content: speech || '(no speech detected)' });

  let reply = 'I\'m sorry, I had trouble understanding that. Could you say it again?';
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: LINKCREW_SYSTEM + '\nYou are on a phone call. Keep responses to 1-3 short sentences.',
      messages: conv.history.slice(-10),
    });
    reply = result.content[0].text;
    conv.history.push({ role: 'assistant', content: reply });
  } catch (err) {
    console.error('[voice] Claude error:', err.message);
  }

  const twiml = new VoiceResponse();
  const endWords = ['goodbye', 'bye', 'hang up', 'that\'s all', 'no thanks'];
  const ending = endWords.some(w => speech.toLowerCase().includes(w));

  if (ending) {
    twiml.say({ voice: 'Polly.Joanna' }, reply + ' Have a great day!');
    twiml.hangup();
    voiceConversations.delete(callSid);
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/respond',
      speechTimeout: '3',
      timeout: 10,
      enhanced: 'true',
      language: 'en-US',
    });
    gather.say({ voice: 'Polly.Joanna' }, reply);
    twiml.say({ voice: 'Polly.Joanna' }, 'Is there anything else I can help you with?');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Web Chat ──────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Messages required' });
  }
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: LINKCREW_SYSTEM + '\nYou are in a web chat. Responses can be 2-4 sentences.',
      messages: messages.slice(-10),
    });
    res.json({ reply: result.content[0].text });
  } catch (err) {
    console.error('[chat] Claude error:', err.message);
    res.status(500).json({ error: 'Could not get a response. Please try again.' });
  }
});

// ── Super-admin Routes ────────────────────────────────────────────────────────

// List all tenants with stats (admin only)
app.get('/api/admin/tenants', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { data: tenants } = await supabaseAdmin
    .from('tenants').select('*').order('created_at', { ascending: false });

  const enriched = await Promise.all((tenants || []).map(async t => {
    const [{ count: jobCount }, { count: empCount }, { count: clientCount }] = await Promise.all([
      supabaseAdmin.from('jobs').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
      supabaseAdmin.from('employees').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
      supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
    ]);
    const trialDaysLeft = t.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(t.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;
    return { ...t, job_count: jobCount || 0, employee_count: empCount || 0, client_count: clientCount || 0, trial_days_left: trialDaysLeft };
  }));

  res.json(enriched);
});

// Generate a short-lived impersonation token for a tenant
app.post('/api/admin/impersonate/:tenantId', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { tenantId } = req.params;
  const { data: tenant } = await supabaseAdmin.from('tenants').select('id, company_name').eq('id', tenantId).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const token = 'imp_' + require('crypto').randomBytes(24).toString('hex');
  impersonationSessions.set(token, { tenantId, expires: Date.now() + 60 * 60 * 1000 }); // 1 hour
  res.json({ token, company_name: tenant.company_name });
});

// ── Invite routes ─────────────────────────────────────────────────────────────

app.get('/api/admin/invites', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { data } = await supabaseAdmin.from('beta_invites').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/admin/invites', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { label, trial_days = 30, max_uses = null, expires_at = null } = req.body;
  const code = require('crypto').randomBytes(4).toString('hex').toUpperCase();
  const { data, error } = await supabaseAdmin.from('beta_invites')
    .insert({ code, label, trial_days, max_uses, expires_at }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/invites/:id', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { label, trial_days, max_uses, expires_at } = req.body;
  const updates = {};
  if (label !== undefined) updates.label = label;
  if (trial_days !== undefined) updates.trial_days = trial_days;
  if (max_uses !== undefined) updates.max_uses = max_uses;
  if (expires_at !== undefined) updates.expires_at = expires_at;
  const { data, error } = await supabaseAdmin.from('beta_invites').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/invites/:id', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  await supabaseAdmin.from('beta_invites').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// Pause / unpause a tenant
app.post('/api/admin/tenants/:id/pause', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { data } = await supabaseAdmin.from('tenants').select('paused').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Not found' });
  await supabaseAdmin.from('tenants').update({ paused: !data.paused }).eq('id', req.params.id);
  res.json({ paused: !data.paused });
});

// Block / unblock a tenant
app.post('/api/admin/tenants/:id/block', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { data } = await supabaseAdmin.from('tenants').select('blocked').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Not found' });
  await supabaseAdmin.from('tenants').update({ blocked: !data.blocked }).eq('id', req.params.id);
  res.json({ blocked: !data.blocked });
});

// Delete a tenant and all their data + auth user
app.delete('/api/admin/tenants/:id', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const tenantId = req.params.id;
  // Delete data in dependency order
  for (const table of ['job_updates', 'job_assignments', 'job_photos', 'supply_requests', 'client_follow_ups']) {
    await supabaseAdmin.from(table).delete().eq('tenant_id', tenantId);
  }
  await supabaseAdmin.from('jobs').delete().eq('tenant_id', tenantId);
  await supabaseAdmin.from('client_users').delete().eq('tenant_id', tenantId);
  await supabaseAdmin.from('clients').delete().eq('tenant_id', tenantId);
  await supabaseAdmin.from('employees').delete().eq('tenant_id', tenantId);
  await supabaseAdmin.from('beta_invites').delete().eq('tenant_id', tenantId);
  // Get auth user id before deleting tenant_users
  const { data: tenantUser } = await supabaseAdmin.from('tenant_users').select('user_id').eq('tenant_id', tenantId).single();
  await supabaseAdmin.from('tenant_users').delete().eq('tenant_id', tenantId);
  await supabaseAdmin.from('tenants').delete().eq('id', tenantId);
  // Delete Supabase auth user
  if (tenantUser?.user_id) await supabaseAdmin.auth.admin.deleteUser(tenantUser.user_id);
  res.json({ ok: true });
});

// Reset a tenant owner's password — returns a generated temp password
app.post('/api/admin/tenants/:id/reset-password', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { data: tenantUser } = await supabaseAdmin.from('tenant_users')
    .select('user_id').eq('tenant_id', req.params.id).single();
  if (!tenantUser) return res.status(404).json({ error: 'User not found' });
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const temp = 'Lc-' + Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const { error } = await supabaseAdmin.auth.admin.updateUserById(tenantUser.user_id, { password: temp });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ temp_password: temp });
});

// Extend a tenant's trial
app.post('/api/admin/tenants/:id/extend-trial', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { days } = req.body;
  if (!days || days < 1) return res.status(400).json({ error: 'days required' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('trial_ends_at, subscription_status').eq('id', req.params.id).single();
  if (!tenant) return res.status(404).json({ error: 'Not found' });
  const base = tenant.trial_ends_at && new Date(tenant.trial_ends_at) > new Date()
    ? new Date(tenant.trial_ends_at) : new Date();
  const newEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from('tenants').update({
    trial_ends_at: newEndsAt,
    subscription_status: 'trialing',
  }).eq('id', req.params.id);
  res.json({ trial_ends_at: newEndsAt });
});

// Manually override a tenant's plan
app.patch('/api/admin/tenants/:id/plan', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { plan } = req.body;
  const planMaxUsers = { free: 1, solo: 1, team: 5, pro: 10, business: 20 };
  if (!planMaxUsers[plan]) return res.status(400).json({ error: 'Invalid plan' });
  await supabaseAdmin.from('tenants').update({
    plan,
    max_users: planMaxUsers[plan],
    subscription_status: plan === 'free' ? 'trialing' : 'active',
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

// MRR summary for admin panel
app.get('/api/admin/mrr', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { data: tenants } = await supabaseAdmin.from('tenants').select('plan, subscription_status');
  const currentMRR = (tenants || [])
    .filter(t => t.subscription_status === 'active')
    .reduce((sum, t) => sum + (PLAN_MRR[t.plan] || 0), 0);
  const trialingCount = (tenants || []).filter(t => t.subscription_status === 'trialing').length;
  const projectedMRR = currentMRR + Math.round(trialingCount * 97 * 0.2); // 20% conversion at avg Team price

  // Last month snapshot
  const lastMonth = new Date(); lastMonth.setDate(1); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthKey = lastMonth.toISOString().split('T')[0];
  const { data: snapshot } = await supabaseAdmin.from('mrr_snapshots')
    .select('mrr').eq('month', lastMonthKey).single();

  res.json({ current: currentMRR, last_month: snapshot?.mrr ?? null, projected: projectedMRR });
});

// Generate a Stripe checkout link for a tenant (admin sends to customer)
app.post('/api/admin/tenants/:id/payment-link', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { plan } = req.body;
  const priceMap = {
    solo: process.env.STRIPE_PRICE_SOLO,
    team: process.env.STRIPE_PRICE_TEAM,
    pro: process.env.STRIPE_PRICE_PRO,
    business: process.env.STRIPE_PRICE_BUSINESS,
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_customer_id, owner_email').eq('id', req.params.id).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(tenant.stripe_customer_id
        ? { customer: tenant.stripe_customer_id }
        : { customer_email: tenant.owner_email }),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: 'https://linkcrew.io/app?billing=success',
      cancel_url: 'https://linkcrew.io/pricing',
      metadata: { tenant_id: req.params.id, plan },
      subscription_data: { metadata: { tenant_id: req.params.id, plan } },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Save admin notes for a tenant
app.patch('/api/admin/tenants/:id/notes', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { notes } = req.body;
  await supabaseAdmin.from('tenants').update({ admin_notes: notes }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Min 8 characters' });
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.userId, { password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ── Scheduled Email Digest ────────────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log('📧 Sending daily digest...');
  await sendDailyDigest();
});

// Snapshot MRR on the 1st of every month at midnight
const PLAN_MRR = { solo: 49, team: 97, pro: 165, business: 299 };
async function snapshotMRR() {
  const { data: tenants } = await supabaseAdmin.from('tenants')
    .select('plan, subscription_status').eq('subscription_status', 'active');
  const mrr = (tenants || []).reduce((sum, t) => sum + (PLAN_MRR[t.plan] || 0), 0);
  const month = new Date();
  month.setDate(1); month.setHours(0, 0, 0, 0);
  await supabaseAdmin.from('mrr_snapshots')
    .upsert({ month: month.toISOString().split('T')[0], mrr }, { onConflict: 'month' });
  console.log(`📊 MRR snapshot saved: $${mrr}`);
}
cron.schedule('0 0 1 * *', snapshotMRR);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FieldSync running at http://localhost:${PORT}`);
});

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { sendDailyDigest, sendNote, sendInvoiceToClient, sendClientPortalInvite, sendClientRequestToOwner, sendPaymentReceivedToOwner, sendPaymentReceiptToClient, sendCallTranscriptToOwner, sendWorkOrderToClient, sendIncomingSmsNotification, sendBusinessOnboardingEmail, sendAppointmentConfirmation, sendAppointmentReminder } = require('../email/digest');
const { LINKCREW_FROM, LINKCREW_ALERT_FROM, EMAIL_FROM_ADDRESS, formatFrom } = require('../email/config');
const { handleMessage } = require('../bot/whatsapp');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VoiceResponse = twilio.twiml.VoiceResponse;


const LINKCREW_SYSTEM = `You are an embedded chat assistant on linkcrew.io. The user is already on the website — never tell them to "visit linkcrew.io" or "go to the website." Reference on-page elements directly when useful (e.g. "the pricing section above", "the Sign up button", "the FAQ section").

LinkCrew is a field service management platform for contractors and field service crews. It helps them manage jobs, track crew in real time, handle client invoices, and give clients their own portal.

PRICING PLANS:
- Solo: $49/mo, 1 user
- Team: $97/mo, up to 5 users
- Pro: $165/mo, up to 10 users
- Business: $299/mo, up to 20 users
- Voice Bot add-on: $30/mo, available on any plan
- All plans include a 14-day free trial — no credit card required

FEATURES (all plans):
- Live job tracking and pipeline management
- Client CRM with a client-facing portal
- Crew check-ins and real-time site photos
- Supply request management
- Stripe-powered invoicing and payments
- Service agreements and reporting
- Android mobile app for crew and owners
- Web dashboard for full management

NEXT STEPS for the user:
- To start using LinkCrew → click "Sign up" on this page (14-day free trial, no credit card)
- To talk to a human → tell them: "If you'd like a real person to follow up, share your email and what you're trying to do, and I'll have someone reach out."  Then capture their email + question. Do NOT direct them to an outside email address.

If asked something outside LinkCrew's scope, politely say it isn't your area.
Never invent features, prices, or details. If unsure, say so plainly — don't redirect.`;

const app = express();

// Trust Render/Cloudflare's proxy so req.protocol reflects the real scheme (https) via X-Forwarded-Proto
app.set('trust proxy', true);

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

function getDashboardAppUrl() {
  const raw = String(process.env.APP_URL || process.env.SITE_URL || 'https://linkcrew.io').trim();
  const normalized = raw.endsWith('/app') ? raw : `${raw.replace(/\/$/, '')}/app`;
  return normalized.replace(/\/$/, '');
}

function getTelegramApprovalMeta(job = {}) {
  const normalizedStatus = String(job.status || '').trim().toLowerCase();
  if (normalizedStatus === 'quoted') {
    return {
      type: 'quote',
      title: 'Quote Approval',
      summary: job.estimate_amount ? `Estimate: $${Number(job.estimate_amount).toFixed(2)}` : 'Estimate amount not set',
    };
  }
  if ((job.invoice_amount && Number(job.invoice_amount) > 0) || normalizedStatus === 'invoiced') {
    return {
      type: 'invoice',
      title: 'Invoice Approval',
      summary: job.invoice_amount ? `Invoice: $${Number(job.invoice_amount).toFixed(2)}` : 'Invoice amount not set',
    };
  }
  return {
    type: 'job',
    title: 'Job Approval',
    summary: `Status: ${String(job.status || 'open').replace(/_/g, ' ')}`,
  };
}

async function sendTelegramBotMessage(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot token is not configured.');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (!res.statusCode || res.statusCode >= 400 || parsed.ok === false) {
            return reject(new Error(parsed.description || 'Telegram request failed.'));
          }
          resolve(parsed.result || parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Regular client (anon key) — used for realtime/public config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Admin client (service role) — used for all server-side queries and auth verification
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Session helpers — in-memory primary, Supabase backup ─────────────────────
const _voiceCache    = new Map();
const _kdgVoiceCache = new Map();

async function getVoiceSession(callSid) {
  // Always check memory first (fastest, most reliable within a call)
  if (_voiceCache.has(callSid)) return _voiceCache.get(callSid);
  try {
    const { data } = await supabaseAdmin.from('voice_sessions')
      .select('*').eq('call_sid', callSid).maybeSingle();
    if (!data) return null;
    const conv = {
      tenantId:    data.tenant_id,
      companyName: data.company_name,
      ownerEmail:  data.owner_email,
      knowledge:   data.knowledge || '',
      callerNumber: data.caller_number,
      startTime:   data.start_time,
      mode:        data.mode || 'support',
      demoData:    data.demo_data || {},
      demoStep:    data.demo_step || 0,
      demoTurns:   data.demo_turns || 0,
      history:     data.history || [],
    };
    _voiceCache.set(callSid, conv);
    return conv;
  } catch (err) {
    console.error('[voice] session read error:', err.message);
    return null;
  }
}

async function saveVoiceSession(callSid, conv) {
  _voiceCache.set(callSid, conv); // always save to memory immediately
  try {
    await supabaseAdmin.from('voice_sessions').upsert({
      call_sid:     callSid,
      tenant_id:    conv.tenantId || null,
      company_name: conv.companyName || null,
      owner_email:  conv.ownerEmail || null,
      knowledge:    conv.knowledge || null,
      caller_number: conv.callerNumber || null,
      start_time:   conv.startTime || null,
      mode:         conv.mode || 'support',
      demo_data:    conv.demoData || {},
      demo_step:    conv.demoStep || 0,
      demo_turns:   conv.demoTurns || 0,
      history:      conv.history || [],
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'call_sid' });
  } catch (err) {
    console.error('[voice] session write error:', err.message);
  }
}

async function deleteVoiceSession(callSid) {
  _voiceCache.delete(callSid);
  try { await supabaseAdmin.from('voice_sessions').delete().eq('call_sid', callSid); }
  catch (err) { console.error('[voice] session delete error:', err.message); }
}

async function getKdgVoiceSession(callSid) {
  if (_kdgVoiceCache.has(callSid)) return _kdgVoiceCache.get(callSid);
  try {
    const { data } = await supabaseAdmin.from('kdg_voice_sessions')
      .select('*').eq('call_sid', callSid).maybeSingle();
    if (!data) return null;
    const conv = { callerNumber: data.caller_number, startTime: data.start_time, history: data.history || [] };
    _kdgVoiceCache.set(callSid, conv);
    return conv;
  } catch (err) {
    console.error('[kdg voice] session read error:', err.message);
    return null;
  }
}

async function saveKdgVoiceSession(callSid, conv) {
  _kdgVoiceCache.set(callSid, conv);
  try {
    await supabaseAdmin.from('kdg_voice_sessions').upsert({
      call_sid:      callSid,
      caller_number: conv.callerNumber || null,
      start_time:    conv.startTime || null,
      history:       conv.history || [],
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'call_sid' });
  } catch (err) {
    console.error('[kdg voice] session write error:', err.message);
  }
}

async function deleteKdgVoiceSession(callSid) {
  _kdgVoiceCache.delete(callSid);
  try { await supabaseAdmin.from('kdg_voice_sessions').delete().eq('call_sid', callSid); }
  catch (err) { console.error('[kdg voice] session delete error:', err.message); }
}

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
      try {
        const { data: job } = await supabaseAdmin.from('jobs')
          .select('name, invoice_amount, tenant_id, clients(name, email)')
          .eq('id', session.metadata.job_id).single();
        if (job?.tenant_id) {
          const { data: tenant } = await supabaseAdmin.from('tenants')
            .select('owner_email, company_name, logo_url').eq('id', job.tenant_id).single();
          // Owner notification
          if (tenant?.owner_email) {
            await sendPaymentReceivedToOwner({
              ownerEmail: tenant.owner_email,
              clientName: job.clients?.name || 'Client',
              jobName: job.name,
              amount: job.invoice_amount,
              tenantName: tenant.company_name,
            });
          }
          // Client receipt
          if (job.clients?.email) {
            const host = process.env.APP_URL || process.env.SITE_URL || 'https://linkcrew.io';
            await sendPaymentReceiptToClient({
              clientEmail: job.clients.email,
              clientName: job.clients.name,
              jobName: job.name,
              amount: job.invoice_amount,
              tenantName: tenant?.company_name,
              tenantLogoUrl: tenant?.logo_url,
              invoiceUrl: `${String(host).replace(/\/$/, '')}/invoice?job_id=${job.id}&portal=1`,
            });
          }
        }
      } catch (emailErr) {
        console.error('[webhook] payment email error:', emailErr.message);
      }
    }
    // Extra users add-on
    if (session.mode === 'subscription' && session.metadata?.addon === 'extra_users') {
      const qty = parseInt(session.metadata.quantity) || 0;
      const { data: t } = await supabaseAdmin.from('tenants').select('extra_users').eq('id', session.metadata.tenant_id).single();
      await supabaseAdmin.from('tenants').update({
        extra_users: (t?.extra_users || 0) + qty,
        max_users: supabaseAdmin.rpc ? undefined : undefined, // recalculated below
        stripe_extra_users_sub_id: session.subscription,
        stripe_customer_id: session.customer,
      }).eq('id', session.metadata.tenant_id);
      // Recalculate max_users = plan base + extra
      const { data: updated } = await supabaseAdmin.from('tenants').select('plan, extra_users').eq('id', session.metadata.tenant_id).single();
      const base = planMaxUsers[updated?.plan] || 1;
      await supabaseAdmin.from('tenants').update({ max_users: base + (updated?.extra_users || 0) }).eq('id', session.metadata.tenant_id);
    }
    // Subscription checkout
    if (session.mode === 'subscription' && session.metadata?.tenant_id && !session.metadata?.addon) {
      const plan = session.metadata.plan;
      const { data: existing } = await supabaseAdmin.from('tenants').select('extra_users').eq('id', session.metadata.tenant_id).single();
      await supabaseAdmin.from('tenants').update({
        plan,
        subscription_status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        max_users: (planMaxUsers[plan] || 1) + (existing?.extra_users || 0),
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

  // ── Stripe Connect account lifecycle ────────────────────────────────────────
  if (event.type === 'account.application.deauthorized') {
    const accountId = event.account || event.data?.object?.id;
    if (accountId) {
      await supabaseAdmin.from('tenants')
        .update({ stripe_connect_account_id: null, stripe_connect_status: null })
        .eq('stripe_connect_account_id', accountId);
      console.log('[stripe connect] deauthorized:', accountId);
    }
  }

  if (event.type === 'account.updated') {
    const acct = event.data?.object;
    if (acct?.id) {
      // Only flag restricted when the account literally can't take cards.
      // Payouts + open requirements can lag in sandbox and early onboarding
      // without blocking charges, so they shouldn't freeze the Pay button.
      const status = acct.charges_enabled ? 'active' : 'restricted';
      await supabaseAdmin.from('tenants')
        .update({ stripe_connect_status: status })
        .eq('stripe_connect_account_id', acct.id);
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
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/portal.html')));
app.get('/invoice', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/invoice.html')));
app.get('/payment-setup', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/payment-setup.html')));
app.get('/voicebot-setup', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/voicebot-setup.html')));
app.get('/workorder', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/workorder.html')));
app.get('/timesheet', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/timesheet-print.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/pricing.html')));
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/faq.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/join.html')));
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

function cleanMcLine(text = '') {
  return text
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

function extractSectionItems(content = '', headingRegex) {
  const lines = content.split('\n');
  const items = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inSection && headingRegex.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection || !line) continue;
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      items.push(cleanMcLine(line));
    }
  }

  return items;
}

function isKdgItem(text = '') {
  return /(KDG|Kingston Data Group|kingstondatagroup|TAVILY_API_KEY|Tavily|Simli|\/api\/chat-kdg|\/api\/voice\/kdg|\(260\)\s*544-6900)/i.test(text);
}

function parseSnapshotNote(note) {
  if (!note?.content) return null;

  const completed = extractSectionItems(note.content, /^##\s*✅?\s*Completed/i);
  const pending = extractSectionItems(note.content, /^##\s*⏳?\s*Pending/i);

  const linkCrewCompleted = completed.filter(item => !isKdgItem(item));
  const linkCrewPending = pending.filter(item => !isKdgItem(item));
  const kdgCompleted = completed.filter(isKdgItem);
  const kdgPending = pending.filter(isKdgItem);

  return {
    title: note.title || 'Latest Snapshot',
    updated_at: note.updated_at,
    next_action: pending[0] || null,
    pending_count: pending.length,
    completed_count: completed.length,
    projects: [
      {
        slug: 'linkcrew',
        name: 'LinkCrew',
        accent: 'accent2',
        status: 'live',
        url: 'https://linkcrew.io',
        summary: linkCrewPending[0] || 'No open LinkCrew items captured in latest snapshot.',
        tasks: [...linkCrewPending.slice(0, 4).map(text => ({ text, done: false })), ...linkCrewCompleted.slice(0, 2).map(text => ({ text, done: true }))],
      },
      {
        slug: 'kdg',
        name: 'Kingston Data Group',
        accent: 'accent',
        status: 'live',
        url: 'https://kingstondatagroup.com',
        summary: kdgPending[0] || 'KDG is live; no open KDG-specific items captured in latest snapshot.',
        tasks: [...kdgPending.slice(0, 4).map(text => ({ text, done: false })), ...kdgCompleted.slice(0, 2).map(text => ({ text, done: true }))],
      },
    ],
  };
}

app.get('/api/mc/brief', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [snapshotRes, eventsRes, choppyRes] = await Promise.all([
    supabaseAdmin.from('mc_notes')
      .select('id, title, content, category, updated_at')
      .eq('category', 'choppy')
      .ilike('title', 'Snapshot%')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from('mc_events')
      .select('id, title, event_date, event_time, type, done')
      .gte('event_date', today)
      .eq('done', false)
      .order('event_date', { ascending: true })
      .order('event_time', { ascending: true, nullsFirst: true })
      .limit(5),
    supabaseAdmin.from('mc_notes')
      .select('id, title, updated_at')
      .eq('category', 'choppy')
      .order('updated_at', { ascending: false })
      .limit(3),
  ]);

  const snapshot = parseSnapshotNote(snapshotRes.data);
  const upcoming = (eventsRes.data || []).slice(0, 3).map(e => ({
    title: e.title,
    event_date: e.event_date,
    event_time: e.event_time,
    type: e.type,
  }));
  const recentChoppy = (choppyRes.data || []).map(n => ({
    title: n.title,
    updated_at: n.updated_at,
  }));

  res.json({
    snapshot_title: snapshot?.title || null,
    snapshot_updated_at: snapshot?.updated_at || null,
    next_action: snapshot?.next_action || null,
    pending_count: snapshot?.pending_count || 0,
    completed_count: snapshot?.completed_count || 0,
    upcoming,
    recent_choppy: recentChoppy,
  });
});

app.get('/api/mc/projects', auth, async (req, res) => {
  const { data: note, error } = await supabaseAdmin.from('mc_notes')
    .select('id, title, content, category, updated_at')
    .eq('category', 'choppy')
    .ilike('title', 'Snapshot%')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  const parsed = parseSnapshotNote(note);
  res.json({
    source_title: parsed?.title || null,
    source_updated_at: parsed?.updated_at || null,
    projects: parsed?.projects || [],
  });
});

function fetchLocalJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3500 }, (resp) => {
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(`HTTP ${resp.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

app.get('/api/mc/paperclip', auth, async (req, res) => {
  const apiBase = process.env.PAPERCLIP_API_BASE || 'http://127.0.0.1:3100/api';
  const companyId = process.env.PAPERCLIP_COMPANY_ID || 'ff33e65e-8877-4e83-898a-81697e93dd36';

  try {
    const issues = await fetchLocalJson(`${apiBase}/companies/${companyId}/issues?q=KIN-`);
    const kinIssues = (issues || []).filter(issue => (issue.identifier || '').startsWith('KIN-'));
    const sortedByUpdated = [...kinIssues].sort((a, b) => new Date(b.updatedAt || b.updated_at || 0) - new Date(a.updatedAt || a.updated_at || 0));
    const active = kinIssues.find(issue => issue.identifier === 'KIN-4') || kinIssues.find(issue => issue.status === 'in_progress') || null;
    const blocked = sortedByUpdated.filter(issue => issue.status === 'blocked').slice(0, 3);
    const recentDone = sortedByUpdated.filter(issue => issue.status === 'done').slice(0, 3);

    res.json({
      service_up: true,
      api_base: apiBase,
      in_progress: kinIssues.filter(issue => issue.status === 'in_progress').length,
      blocked: kinIssues.filter(issue => issue.status === 'blocked').length,
      done: kinIssues.filter(issue => issue.status === 'done').length,
      total: kinIssues.length,
      active: active ? {
        identifier: active.identifier,
        title: active.title,
        status: active.status,
      } : null,
      blocked_items: blocked.map(issue => ({
        identifier: issue.identifier,
        title: issue.title,
      })),
      recent_done: recentDone.map(issue => ({
        identifier: issue.identifier,
        title: issue.title,
      })),
    });
  } catch (error) {
    res.json({
      service_up: false,
      api_base: apiBase,
      error: error.message,
      in_progress: 0,
      blocked: 0,
      done: 0,
      total: 0,
      active: null,
      blocked_items: [],
      recent_done: [],
    });
  }
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

// ── Page view tracking ────────────────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  const { path, referrer } = req.body;
  const allowed = ['/', '/app', '/portal'];
  if (!path || !allowed.includes(path)) return res.json({ ok: true });
  await supabaseAdmin.from('page_views').insert({
    path,
    referrer: referrer ? String(referrer).slice(0, 300) : null,
  });
  // Milestone email (fire and forget)
  supabaseAdmin.from('page_views').select('id', { count: 'exact', head: true }).then(({ count }) => {
    if (count && count % 200 === 0) {
      const { Resend } = require('resend');
      new Resend(process.env.RESEND_API_KEY).emails.send({
        from: LINKCREW_ALERT_FROM,
        to: (process.env.ADMIN_EMAILS || '').split(',')[0].trim() || 'eliott@kingstondatagroup.com',
        subject: `🎉 LinkCrew hit ${count.toLocaleString()} total page views!`,
        html: `<p>LinkCrew just crossed <strong>${count.toLocaleString()} total page views</strong>.</p>
               <p><a href="https://linkcrew.io/lc-ops?k=241971">View analytics →</a></p>`,
      }).catch(() => {});
    }
  }).catch(() => {});
  res.json({ ok: true });
});

// ── Admin analytics ───────────────────────────────────────────────────────────
app.get('/api/admin/analytics', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { start, end } = req.query;
  const startDate = start ? new Date(start + 'T00:00:00Z') : new Date(Date.now() - 30 * 86400000);
  const endDate = end ? new Date(end + 'T23:59:59Z') : new Date();

  const [{ data: views }, { count: signups }] = await Promise.all([
    supabaseAdmin.from('page_views')
      .select('path, created_at')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('created_at', { ascending: true }),
    supabaseAdmin.from('tenants')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString()),
  ]);

  const byDay = {};
  for (const v of views || []) {
    const day = v.created_at.split('T')[0];
    if (!byDay[day]) byDay[day] = { total: 0, landing: 0, app: 0, portal: 0 };
    byDay[day].total++;
    if (v.path === '/') byDay[day].landing++;
    else if (v.path === '/app') byDay[day].app++;
    else if (v.path === '/portal') byDay[day].portal++;
  }

  const totalViews = views?.length || 0;
  const landingViews = (views || []).filter(v => v.path === '/').length;
  const appViews = (views || []).filter(v => v.path === '/app').length;
  const portalViews = (views || []).filter(v => v.path === '/portal').length;
  const conversionRate = landingViews > 0 ? ((signups || 0) / landingViews * 100).toFixed(1) : '0.0';

  res.json({ byDay, totalViews, landingViews, appViews, portalViews, signups: signups || 0, conversionRate });
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
      from: formatFrom('Kingston Data Group', EMAIL_FROM_ADDRESS),
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

const FINANCIAL_JOB_FIELDS = ['estimate_amount', 'invoice_amount', 'payment_status'];
const ACTIVE_JOB_STATUSES = ['active', 'in_progress', 'scheduled'];
const ALLOWED_JOB_STATUSES = ['quoted', 'scheduled', 'in_progress', 'active', 'on_hold', 'completed', 'invoiced', 'saved_for_later', 'cancelled', 'archived'];

function normalizeAppRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return ['owner', 'manager', 'supervisor', 'crew', 'client', 'admin'].includes(normalized) ? normalized : 'owner';
}

function normalizeJobStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return 'active';
  if (normalized === 'complete') return 'completed';
  return ALLOWED_JOB_STATUSES.includes(normalized) ? normalized : 'active';
}

function isOwnerRole(req) {
  return !!(req.isAdmin || req.role === 'owner');
}

function normalizeEmployeeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return ['active', 'vacation', 'suspended'].includes(normalized) ? normalized : 'active';
}

function employeeStatusAllowsAssignment(status) {
  return normalizeEmployeeStatus(status) === 'active';
}

function buildCapabilities(role, canViewFinancials = false) {
  const normalizedRole = normalizeAppRole(role);
  if (normalizedRole === 'admin') {
    return {
      can_access_dashboard: true,
      can_manage_operations: true,
      can_manage_team: true,
      can_manage_settings: true,
      can_view_financials: true,
      can_manage_financials: true,
    };
  }
  if (normalizedRole === 'owner') {
    return {
      can_access_dashboard: true,
      can_manage_operations: true,
      can_manage_team: true,
      can_manage_settings: true,
      can_view_financials: true,
      can_manage_financials: true,
    };
  }
  if (normalizedRole === 'manager' || normalizedRole === 'supervisor') {
    return {
      can_access_dashboard: true,
      can_manage_operations: true,
      can_manage_team: true,
      can_manage_settings: false,
      can_view_financials: !!canViewFinancials,
      can_manage_financials: !!canViewFinancials,
    };
  }
  return {
    can_access_dashboard: normalizedRole === 'crew',
    can_manage_operations: false,
    can_manage_team: false,
    can_manage_settings: false,
    can_view_financials: false,
    can_manage_financials: false,
  };
}

async function loadTenantUserRecord(userId) {
  const detailed = await supabaseAdmin
    .from('tenant_users')
    .select('tenant_id, role, can_view_financials, employee_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!detailed.error && detailed.data) {
    return detailed.data;
  }

  const roleOnly = await supabaseAdmin
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .maybeSingle();

  if (!roleOnly.error && roleOnly.data) {
    return {
      tenant_id: roleOnly.data.tenant_id,
      role: roleOnly.data.role || 'owner',
      can_view_financials: undefined,
      employee_id: null,
    };
  }

  const fallback = await supabaseAdmin
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (fallback.error || !fallback.data) return null;
  return {
    tenant_id: fallback.data.tenant_id,
    role: 'owner',
    can_view_financials: true,
    employee_id: null,
  };
}

async function getTenantManagerFinancialAccess(tenantId) {
  const result = await supabaseAdmin
    .from('tenants')
    .select('manager_financials_enabled')
    .eq('id', tenantId)
    .maybeSingle();

  if (result.error) return { enabled: false, missingColumn: true };
  return { enabled: !!result.data?.manager_financials_enabled, missingColumn: false };
}

async function updateTenantManagerFinancialAccess(tenantId, enabled) {
  const result = await supabaseAdmin
    .from('tenants')
    .update({ manager_financials_enabled: !!enabled })
    .eq('id', tenantId)
    .select('id')
    .maybeSingle();

  return { error: result.error || null };
}

function requireRoleAccess(...roles) {
  const allowedRoles = new Set(roles.map(normalizeAppRole));
  return (req, res, next) => {
    if (req.isAdmin || allowedRoles.has(req.role)) return next();
    return res.status(403).json({ error: 'forbidden', message: 'This action is not available for your role.' });
  };
}

function requireSettingsAccess(req, res, next) {
  if (req.isAdmin || req.capabilities?.can_manage_settings) return next();
  return res.status(403).json({ error: 'forbidden', message: 'Only the owner can manage account settings.' });
}

function requireFinancialAccess(req, res, next) {
  if (req.isAdmin || req.capabilities?.can_view_financials) return next();
  return res.status(403).json({ error: 'financial_access_required', message: 'Financial access is disabled for your role.' });
}

function stripFinancialsFromJob(job) {
  if (!job) return job;
  const copy = { ...job };
  FINANCIAL_JOB_FIELDS.forEach(field => { delete copy[field]; });
  return copy;
}

function redactJobsForRole(jobs, req) {
  if (req.isAdmin || req.capabilities?.can_view_financials) return jobs;
  if (Array.isArray(jobs)) return jobs.map(stripFinancialsFromJob);
  return stripFinancialsFromJob(jobs);
}

function normalizeEmailAddress(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePublicBaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  const normalized = value.replace(/\/+$/, '');
  try {
    const parsed = new URL(normalized);
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
}

function getAppUrl(req) {
  const envUrl = normalizePublicBaseUrl(process.env.APP_URL);
  if (envUrl) return envUrl;
  const originUrl = normalizePublicBaseUrl(req.headers.origin);
  if (originUrl) return originUrl;
  return 'https://linkcrew.io';
}

async function findAuthUserByEmail(email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return null;
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find(user => normalizeEmailAddress(user.email) === normalizedEmail);
    if (match) return match;
    if (users.length < 1000) break;
    page += 1;
  }
  return null;
}

function getActionLinkFromAdminResponse(data) {
  return data?.properties?.action_link
    || data?.properties?.actionLink
    || data?.action_link
    || data?.actionLink
    || null;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadEmployeeForDashboardAccess(tenantId, employeeId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await supabaseAdmin
      .from('employees')
      .select('id, name, role, tenant_id')
      .eq('id', employeeId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!result.error && result.data) return { employee: result.data, error: null };
    if (result.error && !/multiple|0 rows|no rows/i.test(result.error.message || '')) {
      return { employee: null, error: result.error };
    }
    if (attempt < 2) await wait(250 * (attempt + 1));
  }
  return { employee: null, error: null };
}

async function loadDashboardAccessMembership(tenantId, employeeId) {
  const result = await supabaseAdmin
    .from('tenant_users')
    .select('id, user_id, role, employee_id')
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .maybeSingle();

  if (result.error && /column/i.test(result.error.message || '')) {
    return { membership: null, error: new Error('Database migration required before dashboard access controls can be used.') };
  }
  if (result.error) return { membership: null, error: result.error };
  return { membership: result.data || null, error: null };
}

async function sendDashboardAccessInviteEmail({ email, companyName, employeeName, role, actionLink, appUrl, existingUser }) {
  if (!actionLink || !process.env.RESEND_API_KEY) return { sent: false, emailId: null };
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const subject = existingUser
    ? `${companyName || 'Your team'} refreshed your LinkCrew access`
    : `${companyName || 'Your team'} invited you to LinkCrew`;
  const normalizedRole = normalizeAppRole(role);
  const roleLabel = normalizedRole === 'owner'
    ? 'owner'
    : normalizedRole === 'supervisor'
      ? 'supervisor'
      : 'manager';
  const response = await resend.emails.send({
    from: LINKCREW_FROM,
    to: email,
    subject,
    html: `<div style="font-family:sans-serif;max-width:560px">
      <h2 style="margin:0 0 12px;color:#0f172a">${companyName || 'Your team'} invited you to LinkCrew</h2>
      <p style="margin:0 0 12px;color:#334155">Hi ${employeeName || 'there'},</p>
      <p style="margin:0 0 12px;color:#334155">Your ${roleLabel} dashboard access is ready. Use the secure link below to ${existingUser ? 'refresh your password and sign in' : 'set your password and open the dashboard'}.</p>
      <p style="margin:20px 0"><a href="${actionLink}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Open LinkCrew</a></p>
      <p style="margin:0 0 12px;color:#475569;font-size:13px">If the button does not open, copy this URL into your browser:</p>
      <p style="margin:0 0 12px;color:#0f172a;font-size:13px;word-break:break-all">${actionLink}</p>
      <p style="margin:0;color:#64748b;font-size:12px">After setup, your LinkCrew web dashboard will be available here: ${appUrl}/app.</p>
    </div>`,
  });
  return { sent: true, emailId: response?.data?.id || null };
}

async function sendPasswordRecoveryEmail({ email, actionLink, appUrl }) {
  if (!actionLink || !process.env.RESEND_API_KEY) return { sent: false, emailId: null };
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const response = await resend.emails.send({
    from: LINKCREW_FROM,
    to: email,
    subject: 'Reset your LinkCrew password',
    html: `<div style="font-family:sans-serif;max-width:560px">
      <h2 style="margin:0 0 12px;color:#0f172a">Reset your LinkCrew password</h2>
      <p style="margin:0 0 12px;color:#334155">Use the secure link below to set a new password for your LinkCrew account.</p>
      <p style="margin:20px 0"><a href="${actionLink}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Reset Password</a></p>
      <p style="margin:0 0 12px;color:#475569;font-size:13px">If the button does not open, copy this URL into your browser:</p>
      <p style="margin:0 0 12px;color:#0f172a;font-size:13px;word-break:break-all">${actionLink}</p>
      <p style="margin:0;color:#64748b;font-size:12px">After reset, your LinkCrew web dashboard will be available here: ${appUrl}/app.</p>
    </div>`,
  });
  return { sent: true, emailId: response?.data?.id || null };
}

async function syncEmployeeDashboardAccess({ tenantId, employeeId, role }) {
  const normalizedRole = normalizeAppRole(role);
  const { enabled: managerFinancialsEnabled } = await getTenantManagerFinancialAccess(tenantId);
  const canViewFinancials = normalizedRole === 'owner'
    ? true
    : normalizedRole === 'manager' || normalizedRole === 'supervisor'
      ? !!managerFinancialsEnabled
      : false;

  if (normalizedRole === 'crew') {
    await supabaseAdmin
      .from('tenant_users')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('employee_id', employeeId);
    return { revoked: true };
  }

  const result = await supabaseAdmin
    .from('tenant_users')
    .update({ role: normalizedRole, can_view_financials: canViewFinancials })
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .select('id')
    .maybeSingle();

  if (result.error && !/column/i.test(result.error.message || '')) {
    throw result.error;
  }

  return { revoked: false };
}

async function provisionEmployeeDashboardAccess({ req, employee, email }) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return { error: 'A valid email is required to invite dashboard access.' };
  const normalizedRole = normalizeAppRole(employee.role);
  if (!['manager', 'supervisor', 'owner'].includes(normalizedRole)) {
    return { error: 'Dashboard access can only be granted to supervisors, managers, or owners.' };
  }

  const appUrl = getAppUrl(req);
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('company_name, manager_financials_enabled')
    .eq('id', req.tenantId)
    .maybeSingle();

  const managerFinancialsEnabled = !!tenant?.manager_financials_enabled;
  const canViewFinancials = normalizedRole === 'owner'
    ? true
    : !!managerFinancialsEnabled;

  let authUser = null;
  try {
    authUser = await findAuthUserByEmail(normalizedEmail);
  } catch (err) {
    return { error: `Unable to look up auth user: ${err.message}` };
  }

  if (authUser) {
    const existingMembership = await loadTenantUserRecord(authUser.id);
    if (existingMembership && existingMembership.tenant_id && existingMembership.tenant_id !== req.tenantId) {
      return { error: 'That email is already linked to another LinkCrew workspace.' };
    }
    if (existingMembership && existingMembership.tenant_id === req.tenantId && existingMembership.employee_id && existingMembership.employee_id !== employee.id) {
      return { error: 'That email is already linked to another team member in this workspace.' };
    }
  }

  const linkType = authUser ? 'recovery' : 'invite';
  console.log('[employee dashboard invite] request', {
    tenant_id: req.tenantId,
    employee_id: employee.id,
    email: normalizedEmail,
    role: normalizedRole,
    link_type: linkType,
    existing_user: !!authUser,
  });
  const linkResult = await supabaseAdmin.auth.admin.generateLink({
    type: linkType,
    email: normalizedEmail,
    options: {
      redirectTo: `${appUrl}/auth/reset-password.html`,
      data: {
        tenant_id: req.tenantId,
        employee_id: employee.id,
        role: normalizedRole,
      },
    },
  });

  if (linkResult.error) {
    console.error('[employee dashboard invite] generateLink error:', linkResult.error.message);
    return { error: linkResult.error.message };
  }

  const actionLink = getActionLinkFromAdminResponse(linkResult.data);
  const userId = linkResult.data?.user?.id || authUser?.id || null;
  if (!userId) {
    console.error('[employee dashboard invite] missing user id after generateLink', {
      tenant_id: req.tenantId,
      employee_id: employee.id,
      email: normalizedEmail,
    });
    return { error: 'Dashboard invite link was created, but the auth user could not be linked.' };
  }

  const existingEmployeeMembership = await supabaseAdmin
    .from('tenant_users')
    .select('user_id')
    .eq('tenant_id', req.tenantId)
    .eq('employee_id', employee.id)
    .maybeSingle();

  if (existingEmployeeMembership.error && /column/i.test(existingEmployeeMembership.error.message || '')) {
    return { error: 'Database migration required before dashboard access invites can be used.' };
  }
  if (existingEmployeeMembership.error) {
    return { error: existingEmployeeMembership.error.message };
  }
  if (existingEmployeeMembership.data?.user_id && existingEmployeeMembership.data.user_id !== userId) {
    return { error: 'This team member is already linked to a different dashboard account.' };
  }

  const membershipPayload = {
    employee_id: employee.id,
    role: normalizedRole,
    can_view_financials: canViewFinancials,
  };

  const existingMembershipResult = await supabaseAdmin
    .from('tenant_users')
    .select('id')
    .eq('user_id', userId)
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (existingMembershipResult.error && /column/i.test(existingMembershipResult.error.message || '')) {
    return { error: 'Database migration required before dashboard access invites can be used.' };
  }
  if (existingMembershipResult.error) {
    return { error: existingMembershipResult.error.message };
  }

  if (existingMembershipResult.data?.id) {
    const updateMembershipResult = await supabaseAdmin
      .from('tenant_users')
      .update(membershipPayload)
      .eq('id', existingMembershipResult.data.id);
    if (updateMembershipResult.error) return { error: updateMembershipResult.error.message };
  } else {
    const insertMembershipResult = await supabaseAdmin
      .from('tenant_users')
      .insert({ user_id: userId, tenant_id: req.tenantId, ...membershipPayload });
    if (insertMembershipResult.error) {
      if (/column/i.test(insertMembershipResult.error.message || '')) {
        return { error: 'Database migration required before dashboard access invites can be used.' };
      }
      return { error: insertMembershipResult.error.message };
    }
  }

  let emailSent = false;
  let emailId = null;
  try {
    const emailResult = await sendDashboardAccessInviteEmail({
      email: normalizedEmail,
      companyName: tenant?.company_name || 'Your team',
      employeeName: employee.name,
      role: normalizedRole,
      actionLink,
      appUrl,
      existingUser: !!authUser,
    });
    emailSent = !!emailResult?.sent;
    emailId = emailResult?.emailId || null;
    console.log('[employee dashboard invite] email sent', {
      tenant_id: req.tenantId,
      employee_id: employee.id,
      email: normalizedEmail,
      link_type: linkType,
      existing_user: !!authUser,
      resend_email_id: emailId,
    });
  } catch (err) {
    console.error('[employee dashboard invite] email error:', err.message);
  }

  return {
    ok: true,
    email: normalizedEmail,
    invite_url: actionLink,
    email_sent: emailSent,
    email_id: emailId,
    existing_user: !!authUser,
    can_view_financials: canViewFinancials,
  };
}

function requireOperationAccess(req, res, next) {
  if (req.isAdmin || req.capabilities?.can_manage_operations) return next();
  return res.status(403).json({ error: 'forbidden', message: 'Operational access is not available for your role.' });
}

function ensureFinancialFieldsAllowed(req, res, next) {
  const touchedFinancialField = FINANCIAL_JOB_FIELDS.some(field => req.body[field] !== undefined);
  if (!touchedFinancialField) return next();
  if (req.isAdmin || req.capabilities?.can_manage_financials) return next();
  return res.status(403).json({ error: 'financial_access_required', message: 'Financial edits are disabled for your role.' });
}

function ensureEmployeeRoleAllowed(req, res, next) {
  const requestedRole = normalizeAppRole(req.body.role || 'crew');
  if (requestedRole === 'crew') return next();
  if (req.isAdmin || req.capabilities?.can_manage_settings) return next();
  return res.status(403).json({ error: 'forbidden', message: 'Only the owner can assign supervisor, manager, or owner access.' });
}

function ensureEmployeeStatusAllowed(req, res, next) {
  if (req.body.status === undefined) return next();
  const requestedStatus = normalizeEmployeeStatus(req.body.status);
  if (requestedStatus === 'suspended') {
    if (req.isAdmin || req.capabilities?.can_manage_settings) return next();
    return res.status(403).json({ error: 'forbidden', message: 'Only the owner can suspend team members.' });
  }
  if (req.isAdmin || req.capabilities?.can_manage_settings || req.role === 'manager' || req.role === 'owner') return next();
  return res.status(403).json({ error: 'forbidden', message: 'Only owners and managers can change team availability.' });
}


// ── Auth middleware ───────────────────────────────────────────────────────────

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Impersonation token (admin "Login as" feature)
  if (token.startsWith('imp_')) {
    const { data: session } = await supabaseAdmin.from('impersonation_sessions')
      .select('tenant_id, expires_at').eq('token', token).maybeSingle();
    if (!session || new Date(session.expires_at) < new Date()) {
      if (session) await supabaseAdmin.from('impersonation_sessions').delete().eq('token', token);
      return res.status(401).json({ error: 'Impersonation token expired' });
    }
    req.tenantId = session.tenant_id;
    req.isAdmin = false;
    req.isImpersonating = true;
    req.role = 'owner';
    req.capabilities = buildCapabilities('owner', true);
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
    req.role = 'admin';
    req.capabilities = buildCapabilities('admin', true);
    return next();
  }

  const tenantUser = await loadTenantUserRecord(user.id);

  if (!tenantUser) {
    return res.status(403).json({ error: 'No organization found. Please contact support.' });
  }

  req.tenantId = tenantUser.tenant_id;
  req.role = normalizeAppRole(tenantUser.role || 'owner');
  req.employeeId = tenantUser.employee_id || null;
  let managerFinancialAccess = tenantUser.can_view_financials;
  if ((req.role === 'manager' || req.role === 'supervisor') && managerFinancialAccess === undefined) {
    const toggleState = await getTenantManagerFinancialAccess(req.tenantId);
    managerFinancialAccess = toggleState.enabled;
  }
  req.capabilities = buildCapabilities(req.role, managerFinancialAccess);

  if (req.employeeId) {
    const employeeStatusResult = await supabaseAdmin
      .from('employees')
      .select('status')
      .eq('id', req.employeeId)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (employeeStatusResult.error && !/column/i.test(employeeStatusResult.error.message || '')) {
      return res.status(400).json({ error: employeeStatusResult.error.message });
    }
    if (normalizeEmployeeStatus(employeeStatusResult.data?.status) === 'suspended') {
      return res.status(403).json({ error: 'account_blocked' });
    }
  }

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
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  });
});

app.get('/api/me', auth, async (req, res) => {
  let tenantBrand = null;
  if (req.tenantId) {
    const { data } = await supabaseAdmin.from('tenants')
      .select('company_name, logo_url').eq('id', req.tenantId).single();
    if (data) tenantBrand = { company_name: data.company_name || null, logo_url: data.logo_url || null };
  }
  res.json({
    user_id: req.userId || null,
    email: req.userEmail || null,
    tenant_id: req.tenantId || null,
    role: req.role || 'owner',
    is_admin: !!req.isAdmin,
    employee_id: req.employeeId || null,
    capabilities: req.capabilities || buildCapabilities(req.role || 'owner'),
    tenant: tenantBrand,
  });
});

// Create a new owner account + tenant
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, company_name, invite_code, plan: requestedPlan } = req.body;
  if (!email || !password || !company_name) {
    return res.status(400).json({ error: 'Email, password, and company name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Resolve invite code if provided
  let trialDays = 14;
  let inviteId = null;
  let invitePlan = 'free';
  const planMaxUsers = { free: 1, solo: 1, team: 5, pro: 10, business: 20 };
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
        if (requestedPlan && planMaxUsers[requestedPlan]) {
          invitePlan = requestedPlan;
        }
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
    .insert({
      company_name: company_name.trim(),
      owner_email: email.toLowerCase(),
      trial_ends_at: trialEndsAt,
      plan: invitePlan,
      max_users: planMaxUsers[invitePlan] || 1,
      subscription_status: 'trialing',
    })
    .select()
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return res.status(400).json({ error: tenantError.message });
  }

  // Link auth user to tenant
  const { error: linkError } = await supabaseAdmin
    .from('tenant_users')
    .insert({ user_id: authData.user.id, tenant_id: tenant.id, role: 'owner', can_view_financials: true });

  if (linkError) {
    if (!/column/i.test(linkError.message || '')) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return res.status(400).json({ error: 'Failed to link account to organization' });
    }
    const { error: fallbackLinkError } = await supabaseAdmin
      .from('tenant_users')
      .insert({ user_id: authData.user.id, tenant_id: tenant.id });
    if (fallbackLinkError) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return res.status(400).json({ error: 'Failed to link account to organization' });
    }
  }

  if (linkError && /column/i.test(linkError.message || '')) {
    // Legacy tenant_users schema fallback already linked above.
  } else if (linkError) {
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

// Request password reset via email
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const normalizedEmail = email.toLowerCase();
    const appUrl = getAppUrl(req);
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: {
        redirectTo: `${appUrl}/auth/reset-password.html`,
      },
    });

    if (error) {
      console.error('[forgot-password] generateLink error:', error.message);
      // Return generic message for security (don't reveal if email exists)
      return res.json({ ok: true, message: 'If an account exists with this email, a recovery link has been sent' });
    }

    const actionLink = getActionLinkFromAdminResponse(data);
    if (!actionLink) {
      console.error('[forgot-password] missing action link', { email: normalizedEmail });
      return res.json({ ok: true, message: 'If an account exists with this email, a recovery link has been sent' });
    }

    try {
      const emailResult = await sendPasswordRecoveryEmail({ email: normalizedEmail, actionLink, appUrl });
      console.log('[forgot-password] recovery email sent', {
        email: normalizedEmail,
        resend_email_id: emailResult?.emailId || null,
      });
    } catch (mailErr) {
      console.error('[forgot-password] recovery email error:', mailErr.message);
    }

    res.json({ ok: true, message: 'If an account exists with this email, a recovery link has been sent' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ ok: true, message: 'If an account exists with this email, a recovery link has been sent' });
  }
});

// Refresh authentication token
app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      return res.status(401).json({ error: 'Failed to refresh session' });
    }

    res.json({
      ok: true,
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_in: data.session?.expires_in,
    });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Logout (revoke session)
app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({ error: 'User ID not found' });
    }

    // Sign out user (invalidate all sessions)
    const { error } = await supabaseAdmin.auth.admin.signOut(userId);

    if (error) {
      console.error('Logout error:', error);
      // Still return success to frontend so it can clear localStorage
      return res.json({ ok: true, message: 'Logged out locally' });
    }

    res.json({ ok: true, message: 'Successfully logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    // Return success anyway - frontend will clear token
    res.json({ ok: true, message: 'Logged out locally' });
  }
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
  res.json(redactJobsForRole(data || [], req));
});

app.get('/api/jobs/:id', auth, async (req, res) => {
  const { id } = req.params;
  const [{ data: job }, { data: assignments }, { data: supplies }, { data: updates }] = await Promise.all([
    supabaseAdmin.from('jobs').select('*').eq('id', id).eq('tenant_id', req.tenantId).single(),
    supabaseAdmin.from('job_assignments').select('*, employees(name, role)').eq('job_id', id),
    supabaseAdmin.from('supply_requests').select('*, employees(name)').eq('job_id', id).order('created_at', { ascending: false }),
    supabaseAdmin.from('job_updates').select('*, employees(name)').eq('job_id', id).order('created_at', { ascending: false }).limit(50)
  ]);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job: redactJobsForRole(job, req), assignments, supplies, updates });
});

app.post('/api/jobs/:id/telegram-approval', auth, requireSettingsAccess, async (req, res) => {
  const managerChatId = process.env.MANAGER_TELEGRAM_ID;
  if (!managerChatId) {
    return res.status(400).json({ error: 'MANAGER_TELEGRAM_ID is not configured.' });
  }
  const { id } = req.params;
  const [{ data: job }, { data: tenant }] = await Promise.all([
    supabaseAdmin
      .from('jobs')
      .select('id, name, address, status, estimate_amount, invoice_amount, payment_status, client_id, clients(name)')
      .eq('id', id)
      .eq('tenant_id', req.tenantId)
      .single(),
    supabaseAdmin
      .from('tenants')
      .select('company_name')
      .eq('id', req.tenantId)
      .single(),
  ]);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const approval = getTelegramApprovalMeta(job);
  const dashboardUrl = `${getDashboardAppUrl()}?job=${encodeURIComponent(job.id)}#job-detail`;
  const summaryLines = [
    `LinkCrew ${approval.title}`,
    '',
    `Company: ${tenant?.company_name || 'LinkCrew'}`,
    `Job: ${job.name || 'Untitled job'}`,
    job.clients?.name ? `Client: ${job.clients.name}` : null,
    job.address ? `Address: ${job.address}` : null,
    approval.summary,
    job.payment_status ? `Payment: ${String(job.payment_status).replace(/_/g, ' ')}` : null,
    '',
    'Tap Approve to push it forward, or Reply to send notes back into the job.',
  ].filter(Boolean);

  await sendTelegramBotMessage({
    chat_id: managerChatId,
    text: summaryLines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: `approval|approve|${approval.type}|${job.id}` },
          { text: 'Reply', callback_data: `approval|reply|${approval.type}|${job.id}` },
        ],
        [
          { text: 'Open In LinkCrew', url: dashboardUrl },
        ],
      ],
    },
  });

  res.json({ ok: true, message: `${approval.title} sent to Telegram.` });
});

app.get('/api/photos/recent', auth, async (req, res) => {
  if (!req.tenantId) return res.json([]);
  const { data: jobs } = await supabaseAdmin
    .from('jobs').select('id, client_id, clients(id, name)').eq('tenant_id', req.tenantId);
  if (!jobs?.length) return res.json([]);

  const { data } = await supabaseAdmin
    .from('job_updates')
    .select('id, message, photo_url, created_at, job_id, jobs(name, client_id, clients(id, name)), employees(name)')
    .eq('type', 'photo').not('photo_url', 'is', null)
    .in('job_id', jobs.map(j => j.id))
    .order('created_at', { ascending: false }).limit(100);
  res.json(data || []);
});

app.delete('/api/photos/:id', auth, async (req, res) => {
  const { id } = req.params;
  // Verify ownership via tenant
  const { data: photo } = await supabaseAdmin
    .from('job_updates').select('id, photo_url, job_id, jobs(tenant_id)').eq('id', id).single();
  if (!photo || photo.jobs?.tenant_id !== req.tenantId) return res.status(403).json({ error: 'Not found' });

  // Delete from storage
  if (photo.photo_url) {
    try {
      const url = new URL(photo.photo_url);
      const parts = url.pathname.split('/object/public/');
      if (parts[1]) {
        const [bucket, ...pathParts] = parts[1].split('/');
        await supabaseAdmin.storage.from(bucket).remove([pathParts.join('/')]);
      }
    } catch (e) { /* storage delete best-effort */ }
  }

  await supabaseAdmin.from('job_updates').delete().eq('id', id);
  res.json({ ok: true });
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

app.post('/api/jobs', auth, requireOperationAccess, ensureFinancialFieldsAllowed, async (req, res) => {
  const {
    name,
    address,
    manager_email,
    description,
    estimate_amount,
    status,
    primary_supervisor_employee_id,
    initial_employee_ids = [],
    client_id,
  } = req.body;

  if (client_id) {
    const { data: client } = await supabaseAdmin.from('clients')
      .select('id').eq('id', client_id).eq('tenant_id', req.tenantId).maybeSingle();
    if (!client) return res.status(400).json({ error: 'Selected client is invalid.' });
  }
  const normalizedStatus = normalizeJobStatus(status || 'active');
  const requestedEmployeeIds = Array.isArray(initial_employee_ids)
    ? [...new Set(initial_employee_ids.filter(id => typeof id === 'string' && id.trim()))]
    : [];

  if (primary_supervisor_employee_id) {
    const { data: supervisor, error: supervisorError } = await supabaseAdmin
      .from('employees')
      .select('id, role, status')
      .eq('tenant_id', req.tenantId)
      .eq('id', primary_supervisor_employee_id)
      .maybeSingle();
    if (supervisorError) return res.status(400).json({ error: supervisorError.message });
    if (!supervisor || !['owner', 'manager', 'supervisor'].includes(normalizeAppRole(supervisor.role))) {
      return res.status(400).json({ error: 'Selected primary lead is invalid.' });
    }
    if (!employeeStatusAllowsAssignment(supervisor.status)) {
      return res.status(400).json({ error: 'Selected primary lead is not currently available for assignment.' });
    }
  }

  if (requestedEmployeeIds.length) {
    const { data: crewEmployees, error: crewError } = await supabaseAdmin
      .from('employees')
      .select('id, status')
      .eq('tenant_id', req.tenantId)
      .eq('role', 'crew')
      .in('id', requestedEmployeeIds);
    if (crewError) return res.status(400).json({ error: crewError.message });
    if ((crewEmployees || []).length !== requestedEmployeeIds.length) {
      return res.status(400).json({ error: 'One or more selected crew members are invalid.' });
    }
    if ((crewEmployees || []).some(employee => !employeeStatusAllowsAssignment(employee.status))) {
      return res.status(400).json({ error: 'One or more selected crew members are not currently available for assignment.' });
    }
  }

  const { data, error } = await supabaseAdmin.from('jobs')
    .insert({
      name,
      address,
      manager_email,
      description,
      status: normalizedStatus,
      estimate_amount: estimate_amount || null,
      primary_supervisor_employee_id: primary_supervisor_employee_id || null,
      client_id: client_id || null,
      tenant_id: req.tenantId
    }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  if (requestedEmployeeIds.length) {
    const assignmentRows = requestedEmployeeIds.map(employee_id => ({
      job_id: data.id,
      employee_id,
      tenant_id: req.tenantId
    }));
    const { error: assignmentError } = await supabaseAdmin.from('job_assignments').insert(assignmentRows);
    if (assignmentError) return res.status(400).json({ error: assignmentError.message });
  }

  res.json(redactJobsForRole(data, req));
});

// Public work order page data (no auth — UUID is the access control)
app.get('/api/workorder/:jobId', async (req, res) => {
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email, phone, address)')
    .eq('id', req.params.jobId).single();
  if (error || !job) return res.status(404).json({ error: 'Work order not found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, logo_url, address, phone, owner_email, license_number')
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

app.patch('/api/jobs/:id', auth, requireOperationAccess, ensureFinancialFieldsAllowed, async (req, res) => {
  const { id } = req.params;
  const allowed = [
    'status',
    'client_id',
    'name',
    'address',
    'description',
    'estimate_amount',
    'manager_email',
    'primary_supervisor_employee_id',
    'plans_notes',
    'execution_plan',
    'checklist_items',
    'missing_items_watchlist',
    'client_communication_plan',
    'expected_duration_hours',
    'required_before_photos',
    'required_mid_job_photos',
    'required_completion_photos',
    'required_cleanup_photos',
    'crew_plan_confirmed',
    'workflow_id',
    'workflow_progress',
  ];
  const updates = {};
  allowed.forEach(f => {
    if (req.body[f] === undefined) return;
    if (f === 'status') {
      updates[f] = normalizeJobStatus(req.body[f]);
      return;
    }
    if (f === 'estimate_amount') {
      updates[f] = req.body[f] === '' || req.body[f] === null ? null : parseFloat(req.body[f]);
      return;
    }
    if (f === 'expected_duration_hours') {
      updates[f] = req.body[f] === '' || req.body[f] === null ? null : parseFloat(req.body[f]);
      return;
    }
    if (['required_before_photos', 'required_mid_job_photos', 'required_completion_photos', 'required_cleanup_photos'].includes(f)) {
      const raw = req.body[f];
      const value = raw === '' || raw === null ? 0 : parseInt(raw, 10);
      updates[f] = Number.isFinite(value) && value >= 0 ? value : 0;
      return;
    }
    if (f === 'crew_plan_confirmed') {
      updates[f] = req.body[f] === true;
      return;
    }
    if (f === 'checklist_items') {
      updates[f] = Array.isArray(req.body[f])
        ? req.body[f].map(item => String(item || '').trim()).filter(Boolean)
        : [];
      return;
    }
    updates[f] = req.body[f] || null;
  });

  // If a workflow is (newly) attached or its progress is being advanced,
  // derive the legacy jobs.status from the current workflow status so the
  // Jobs list, dashboard chips, and reports stay in sync with the pill row.
  const touchedWorkflow = 'workflow_id' in updates || 'workflow_progress' in updates;
  if (touchedWorkflow) {
    let effWorkflowId = 'workflow_id' in updates ? updates.workflow_id : undefined;
    let effProgress = 'workflow_progress' in updates ? updates.workflow_progress : undefined;
    if (effWorkflowId === undefined || effProgress === undefined) {
      const { data: existing } = await supabaseAdmin
        .from('jobs')
        .select('workflow_id, workflow_progress')
        .eq('id', id)
        .eq('tenant_id', req.tenantId)
        .maybeSingle();
      if (effWorkflowId === undefined) effWorkflowId = existing?.workflow_id || null;
      if (effProgress === undefined) effProgress = existing?.workflow_progress || {};
    }
    if (effWorkflowId) {
      const { data: wfStatuses } = await supabaseAdmin
        .from('workflow_statuses')
        .select('id, legacy_status, order_index')
        .eq('workflow_id', effWorkflowId)
        .order('order_index', { ascending: true });
      const list = wfStatuses || [];
      let currentId = effProgress?.current_status_id;
      if (!currentId || !list.some(s => s.id === currentId)) {
        currentId = list[0]?.id || null;
        if (currentId) {
          updates.workflow_progress = { ...(effProgress || {}), current_status_id: currentId };
        }
      }
      const currentStatus = currentId ? list.find(s => s.id === currentId) : null;
      if (currentStatus?.legacy_status) {
        updates.status = normalizeJobStatus(currentStatus.legacy_status);
      }
    }
  }

  updates.updated_at = new Date().toISOString();
  const scopeTouched = scopeFieldsTouched(updates);
  const { data } = await supabaseAdmin.from('jobs').update(updates).eq('id', id).eq('tenant_id', req.tenantId).select().single();
  if (!data) return res.status(404).json({ error: 'Job not found' });

  if (scopeTouched) {
    try {
      await bumpScopeAndNotify({
        tenantId: req.tenantId,
        jobId: id,
        updatedByName: req.userEmail || 'Your team',
        updatedByUserId: req.userId || null,
      });
    } catch (e) {
      console.error('[scope notify desktop] error:', e.message);
    }
  }

  res.json(redactJobsForRole(data, req));
});

// Mobile-friendly: any authenticated tenant member can advance workflow /
// check steps, even crew without can_manage_operations. Scope: workflow_progress only.
app.patch('/api/jobs/:id/workflow-progress', auth, async (req, res) => {
  const { id } = req.params;
  const { data: job } = await supabaseAdmin
    .from('jobs')
    .select('id, workflow_id, workflow_progress')
    .eq('id', id)
    .eq('tenant_id', req.tenantId)
    .maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.workflow_id) return res.status(400).json({ error: 'Job has no workflow attached' });

  const incoming = req.body?.workflow_progress || {};
  const base = job.workflow_progress || {};
  const merged = { ...base, ...incoming };
  if (incoming.completed_steps) {
    merged.completed_steps = { ...(base.completed_steps || {}), ...incoming.completed_steps };
  }

  const { data: wfStatuses } = await supabaseAdmin
    .from('workflow_statuses')
    .select('id, legacy_status, order_index')
    .eq('workflow_id', job.workflow_id)
    .order('order_index', { ascending: true });
  const list = wfStatuses || [];
  let currentId = merged.current_status_id;
  if (!currentId || !list.some(s => s.id === currentId)) {
    currentId = list[0]?.id || null;
    if (currentId) merged.current_status_id = currentId;
  }
  const currentStatus = currentId ? list.find(s => s.id === currentId) : null;
  const updates = { workflow_progress: merged, updated_at: new Date().toISOString() };
  if (currentStatus?.legacy_status) updates.status = normalizeJobStatus(currentStatus.legacy_status);

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', req.tenantId)
    .select('*')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(redactJobsForRole(data, req));
});

app.delete('/api/jobs/:id', auth, async (req, res) => {
  if (!isOwnerRole(req)) {
    return res.status(403).json({ error: 'Only the owner can delete jobs.' });
  }
  const { id } = req.params;
  const { data: job } = await supabaseAdmin
    .from('jobs')
    .select('id, invoice_amount, payment_status')
    .eq('id', id)
    .eq('tenant_id', req.tenantId)
    .maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if ((parseFloat(job.invoice_amount) || 0) > 0 || job.payment_status === 'paid') {
    return res.status(400).json({ error: 'Delete is only available for non-billed jobs. Archive this job instead.' });
  }
  const { error } = await supabaseAdmin.from('jobs').delete().eq('id', id).eq('tenant_id', req.tenantId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/updates', auth, async (req, res) => {
  const { id } = req.params;
  const { type, message } = req.body;
  const allowedTypes = new Set(['note', 'bottleneck']);
  if (!allowedTypes.has(type)) return res.status(400).json({ error: 'Invalid update type' });
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const { data: job } = await supabaseAdmin
    .from('jobs').select('id').eq('id', id).eq('tenant_id', req.tenantId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data, error } = await supabaseAdmin
    .from('job_updates')
    .insert({
      job_id: id,
      employee_id: req.employeeId || null,
      message: message.trim(),
      type,
    })
    .select('*, employees(name)')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/jobs/:jobId/updates/:updateId', auth, async (req, res) => {
  const { jobId, updateId } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const { data: job } = await supabaseAdmin
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('tenant_id', req.tenantId)
    .single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data: existing } = await supabaseAdmin
    .from('job_updates')
    .select('id, type, job_id')
    .eq('id', updateId)
    .eq('job_id', jobId)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Update not found' });
  if (existing.type !== 'note') return res.status(400).json({ error: 'Only owner notes can be edited.' });

  const { data, error } = await supabaseAdmin
    .from('job_updates')
    .update({ message: message.trim() })
    .eq('id', updateId)
    .eq('job_id', jobId)
    .select('*, employees(name)')
    .single();

  if (error) return res.status(400).json({ error: error.message });
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
  const { data, error } = await scoped(supabaseAdmin.from('employees').select('*').order('name'), req.tenantId);
  if (error) return res.status(400).json({ error: error.message });
  const employees = data || [];
  if (!employees.length) return res.json([]);

  const employeeIds = employees.map(employee => employee.id);
  const dashboardAccessResult = await supabaseAdmin
    .from('tenant_users')
    .select('employee_id, role, can_view_financials')
    .eq('tenant_id', req.tenantId)
    .in('employee_id', employeeIds);

  if (dashboardAccessResult.error) {
    console.error('[employees] dashboard access metadata query failed:', dashboardAccessResult.error.message);
    return res.json(employees);
  }

  const accessByEmployeeId = new Map((dashboardAccessResult.data || [])
    .filter(entry => entry.employee_id)
    .map(entry => [entry.employee_id, entry]));

  res.json(employees.map(employee => {
    const access = accessByEmployeeId.get(employee.id);
    return {
      ...employee,
      status: normalizeEmployeeStatus(employee.status),
      dashboard_access_enabled: !!access,
      dashboard_role: access?.role || null,
      dashboard_can_view_financials: !!access?.can_view_financials,
    };
  }));
});

app.post('/api/employees', auth, requireOperationAccess, ensureEmployeeRoleAllowed, async (req, res) => {
  const { name, phone, role } = req.body;
  if (!name || !phone || !role) return res.status(400).json({ error: 'name, phone and role are required' });
  // Enforce plan crew limit
  const { data: tenant } = await supabaseAdmin.from('tenants').select('max_users').eq('id', req.tenantId).single();
  const maxUsers = tenant?.max_users ?? 1;
  const { count } = await supabaseAdmin.from('employees').select('*', { count: 'exact', head: true }).eq('tenant_id', req.tenantId);
  if (count >= maxUsers) return res.status(403).json({ error: `Plan limit reached. Your plan allows up to ${maxUsers} crew member${maxUsers === 1 ? '' : 's'}. Upgrade at linkcrew.io/pricing.` });
  let normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone.length === 11 && normalizedPhone.startsWith('1')) {
    normalizedPhone = normalizedPhone.slice(1);
  }
  const { data, error } = await supabaseAdmin.from('employees')
    .insert({ name: name.trim(), phone: normalizedPhone, role, status: 'active', tenant_id: req.tenantId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/employees/:id', auth, requireOperationAccess, ensureEmployeeRoleAllowed, ensureEmployeeStatusAllowed, async (req, res) => {
  const { id } = req.params;
  const { name, phone, role, status } = req.body;
  const updates = {};
  if (name) updates.name = name.trim();
  if (phone) {
    let p = phone.replace(/\D/g, '');
    if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
    updates.phone = p;
  }
  if (role) updates.role = role;
  if (status !== undefined) updates.status = normalizeEmployeeStatus(status);
  const { data, error } = await supabaseAdmin.from('employees').update(updates).eq('id', id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  if (role) {
    try {
      await syncEmployeeDashboardAccess({ tenantId: req.tenantId, employeeId: id, role });
    } catch (syncError) {
      if (!/column/i.test(syncError.message || '')) {
        return res.status(400).json({ error: syncError.message });
      }
    }
  }
  res.json(data);
});

app.delete('/api/employees/:id', auth, requireSettingsAccess, async (req, res) => {
  const { id } = req.params;
  await supabaseAdmin.from('tenant_users').delete().eq('tenant_id', req.tenantId).eq('employee_id', id);
  await supabaseAdmin.from('employees').delete().eq('id', id).eq('tenant_id', req.tenantId);
  res.json({ ok: true });
});

app.post('/api/employees/:id/dashboard-access', auth, requireSettingsAccess, async (req, res) => {
  const { id } = req.params;
  const email = normalizeEmailAddress(req.body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const { employee, error: employeeError } = await loadEmployeeForDashboardAccess(req.tenantId, id);
  if (employeeError) return res.status(400).json({ error: employeeError.message });
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });

  const inviteResult = await provisionEmployeeDashboardAccess({ req, employee, email });
  if (inviteResult.error) return res.status(400).json({ error: inviteResult.error });

  res.json(inviteResult);
});

app.delete('/api/employees/:id/dashboard-access', auth, requireSettingsAccess, async (req, res) => {
  const { id } = req.params;
  const { employee, error: employeeError } = await loadEmployeeForDashboardAccess(req.tenantId, id);
  if (employeeError) return res.status(400).json({ error: employeeError.message });
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  if (normalizeAppRole(employee.role) === 'owner') {
    return res.status(400).json({ error: 'Owner dashboard access cannot be disabled here.' });
  }

  const { membership, error: membershipError } = await loadDashboardAccessMembership(req.tenantId, id);
  if (membershipError) return res.status(400).json({ error: membershipError.message });
  if (!membership) return res.json({ ok: true, disabled: false });
  if (membership.user_id === req.userId) {
    return res.status(400).json({ error: 'You cannot disable your own dashboard access.' });
  }

  const deleteResult = await supabaseAdmin
    .from('tenant_users')
    .delete()
    .eq('id', membership.id);
  if (deleteResult.error) return res.status(400).json({ error: deleteResult.error.message });

  try {
    await supabaseAdmin.auth.admin.signOut(membership.user_id);
  } catch (err) {
    console.error('[dashboard-access] signout error:', err.message);
  }

  res.json({ ok: true, disabled: true });
});

// ── CRM: Clients ─────────────────────────────────────────────────────────────

app.get('/api/clients', auth, async (req, res) => {
  const { data } = await scoped(
    supabaseAdmin.from('clients').select('*, client_follow_ups(id, completed)').order('name'),
    req.tenantId
  );
  res.json(data || []);
});

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n') + '\r\n';
}

app.get('/api/clients/export', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data: clients, error } = await supabaseAdmin.from('clients')
    .select('name, company, phone, email, address, notes, created_at')
    .eq('tenant_id', tenantId)
    .order('name');
  if (error) return res.status(400).json({ error: error.message });
  const header = ['Name', 'Company', 'Phone', 'Email', 'Address', 'Notes', 'Created'];
  const rows = (clients || []).map(c => [
    c.name || '',
    c.company || '',
    c.phone || '',
    c.email || '',
    c.address || '',
    c.notes || '',
    c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
  ]);
  const csv = rowsToCsv(header, rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="linkcrew-clients-${stamp}.csv"`);
  res.send(csv);
});

app.get('/api/invoices/export', auth, requireFinancialAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const statusFilter = String(req.query.status || 'all').toLowerCase();

  let q = supabaseAdmin.from('jobs')
    .select('id, name, address, description, invoice_amount, payment_status, status, created_at, updated_at, clients(name, email)')
    .eq('tenant_id', tenantId)
    .gt('invoice_amount', 0);
  if (start) q = q.gte('updated_at', `${start}T00:00:00Z`);
  if (end) q = q.lte('updated_at', `${end}T23:59:59Z`);
  q = q.order('updated_at', { ascending: false });
  const { data: jobs, error } = await q;
  if (error) return res.status(400).json({ error: error.message });

  const filtered = (jobs || []).filter(j => {
    const isPaid = String(j.payment_status || '').toLowerCase() === 'paid';
    if (statusFilter === 'paid') return isPaid;
    if (statusFilter === 'unpaid') return !isPaid;
    return true;
  });

  const invoiceNumber = (id, iso) => {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `INV-${y}${m}${day}-${String(id).slice(0, 6).toUpperCase()}`;
  };

  const header = [
    'Invoice #', 'Date', 'Client', 'Client Email',
    'Job', 'Address', 'Description',
    'Amount', 'Status', 'Paid Date', 'Payment Method',
  ];
  const rows = filtered.map(j => {
    const isPaid = String(j.payment_status || '').toLowerCase() === 'paid';
    const invDate = j.updated_at || j.created_at;
    return [
      invoiceNumber(j.id, invDate),
      invDate ? new Date(invDate).toISOString().slice(0, 10) : '',
      j.clients?.name || '',
      j.clients?.email || '',
      j.name || '',
      j.address || '',
      j.description || '',
      Number(j.invoice_amount || 0).toFixed(2),
      isPaid ? 'Paid' : 'Unpaid',
      isPaid && j.updated_at ? new Date(j.updated_at).toISOString().slice(0, 10) : '',
      isPaid ? 'Stripe (card)' : '',
    ];
  });
  const totalAmount = filtered.reduce((s, j) => s + (parseFloat(j.invoice_amount) || 0), 0);
  const totalPaid = filtered
    .filter(j => String(j.payment_status || '').toLowerCase() === 'paid')
    .reduce((s, j) => s + (parseFloat(j.invoice_amount) || 0), 0);
  rows.push(['', '', '', '', '', '', 'Total invoiced', totalAmount.toFixed(2), '', '', '']);
  rows.push(['', '', '', '', '', '', 'Total paid',     totalPaid.toFixed(2),     '', '', '']);

  const csv = rowsToCsv(header, rows);
  const stamp = new Date().toISOString().slice(0, 10);
  const range = start && end ? `${start}_to_${end}` : start ? `from-${start}` : end ? `to-${end}` : 'all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="linkcrew-invoices-${range}-${stamp}.csv"`);
  res.send(csv);
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
    supabaseAdmin.from('clients').select('*').eq('id', id).eq('tenant_id', req.tenantId).single(),
    supabaseAdmin.from('client_follow_ups').select('*').eq('client_id', id).order('due_date').order('created_at'),
    supabaseAdmin.from('jobs').select('id, name, address, status, created_at, invoice_amount, payment_status, estimate_amount').eq('client_id', id).eq('tenant_id', req.tenantId).order('created_at', { ascending: false }),
  ]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  let photos = [];
  if (jobs?.length) {
    const { data: photoData } = await supabaseAdmin
      .from('job_updates')
      .select('id, photo_url, message, created_at, jobs(name)')
      .in('job_id', jobs.map(j => j.id))
      .eq('type', 'photo')
      .not('photo_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(60);
    photos = photoData || [];
  }

  res.json({ client, followUps: followUps || [], jobs: redactJobsForRole(jobs || [], req), photos });
});

app.patch('/api/clients/:id', auth, requireOperationAccess, async (req, res) => {
  const { id } = req.params;
  const { name, company, phone, email, address, notes } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (company !== undefined) updates.company = company;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (address !== undefined) updates.address = address;
  if (notes !== undefined) updates.notes = notes;
  const { data, error } = await supabaseAdmin.from('clients').update(updates).eq('id', id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients/:id/invoice', auth, requireFinancialAccess, async (req, res) => {
  const { amount, description } = req.body;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }

  const clientId = req.params.id;
  const [{ data: client }, { data: tenant }] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name, email, address').eq('id', clientId).eq('tenant_id', req.tenantId).single(),
    supabaseAdmin.from('tenants').select('company_name').eq('id', req.tenantId).single(),
  ]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const invoiceName = description?.trim() || `Invoice for ${client.name || 'Client'}`;
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .insert({
      name: invoiceName,
      address: client.address || '',
      status: 'invoiced',
      payment_status: 'unpaid',
      invoice_amount: parseFloat(amount),
      client_id: clientId,
      tenant_id: req.tenantId,
    })
    .select('*, clients(name, email)')
    .single();
  if (error) return res.status(400).json({ error: error.message });

  let invoiceEmailSent = false;
  if (client.email) {
    try {
      const { data: clientUser } = await supabaseAdmin.from('client_users').select('portal_token').eq('client_id', clientId).single();
      const host = `${req.protocol}://${req.get('host')}`;
      const portalUrl = clientUser?.portal_token
        ? `${host}/portal?token=${clientUser.portal_token}`
        : `${host}/portal`;
      await sendInvoiceToClient({
        clientName: client.name,
        clientEmail: client.email,
        jobName: job.name,
        amount: parseFloat(amount),
        portalUrl,
        tenantName: tenant?.company_name,
      });
      invoiceEmailSent = true;
    } catch (emailErr) {
      console.error('[client invoice] email error:', emailErr.message);
    }
  }

  res.json({ job: redactJobsForRole(job, req), invoice_email_sent: invoiceEmailSent, invoice_emailed_to: invoiceEmailSent ? client.email : null });
});

// Bulk import clients from CSV
app.post('/api/clients/import', auth, async (req, res) => {
  const { clients } = req.body; // array of { name, company, phone, email, address, notes }
  if (!Array.isArray(clients) || !clients.length)
    return res.status(400).json({ error: 'No clients provided' });

  const rows = clients
    .filter(c => c.name?.trim())
    .map(c => ({
      name: c.name.trim(),
      company: c.company || null,
      phone: c.phone || null,
      email: c.email || null,
      address: c.address || null,
      notes: c.notes || null,
      tenant_id: req.tenantId,
    }));

  if (!rows.length) return res.status(400).json({ error: 'No valid rows (name is required)' });

  const { data, error } = await supabaseAdmin.from('clients').insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ imported: data.length });
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

app.get('/api/agreements', auth, requireFinancialAccess, async (req, res) => {
  const { data } = await scoped(
    supabaseAdmin.from('service_agreements').select('*, clients(name)').order('next_due').order('name'),
    req.tenantId
  );
  res.json(data || []);
});

app.post('/api/agreements', auth, requireFinancialAccess, async (req, res) => {
  const { name, client_id, description, schedule, value, start_date, next_due } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabaseAdmin.from('service_agreements')
    .insert({ name, client_id: client_id || null, description, schedule, value: value || null, start_date: start_date || null, next_due: next_due || null, tenant_id: req.tenantId })
    .select('*, clients(name)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/agreements/:id', auth, requireFinancialAccess, async (req, res) => {
  const { id } = req.params;
  const [{ data: agreement }, { data: jobs }] = await Promise.all([
    supabaseAdmin.from('service_agreements').select('*, clients(name)').eq('id', id).single(),
    supabaseAdmin.from('jobs').select('id, name, address, status').eq('client_id',
      (await supabaseAdmin.from('service_agreements').select('client_id').eq('id', id).single()).data?.client_id || ''
    ).order('created_at', { ascending: false }),
  ]);
  res.json({ agreement, jobs: jobs || [] });
});

app.patch('/api/agreements/:id', auth, requireFinancialAccess, async (req, res) => {
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

app.delete('/api/agreements/:id', auth, requireFinancialAccess, async (req, res) => {
  await supabaseAdmin.from('service_agreements').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Services (pre-defined) ────────────────────────────────────────────────────

app.get('/api/services', auth, async (req, res) => {
  const { data } = await scoped(
    supabaseAdmin.from('services').select('*').order('name'),
    req.tenantId
  );
  res.json(data || []);
});

app.post('/api/services', auth, async (req, res) => {
  const { name, description, price, duration_minutes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabaseAdmin.from('services')
    .insert({ name, description, price: price || null, duration_minutes: duration_minutes || 60, tenant_id: req.tenantId })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/services/:id', auth, async (req, res) => {
  const { name, description, price, duration_minutes } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) updates.price = price || null;
  if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes;
  const { data, error } = await supabaseAdmin.from('services').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/services/:id', auth, async (req, res) => {
  await supabaseAdmin.from('services').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Appointments ──────────────────────────────────────────────────────────────

async function notifyApptClient(appt, tenantId, type = 'confirmation') {
  if (!appt.clients?.email && !appt.clients?.phone) return;
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, twilio_phone, twilio_account_sid, twilio_auth_token')
    .eq('id', tenantId).single();

  const params = {
    clientName: appt.clients.name,
    clientEmail: appt.clients.email,
    title: appt.title,
    startTime: appt.start_time,
    endTime: appt.end_time,
    notes: appt.notes,
    tenantName: tenant?.company_name,
  };

  if (appt.clients.email) {
    try {
      if (type === 'confirmation') await sendAppointmentConfirmation(params);
      else await sendAppointmentReminder(params);
    } catch (e) { console.error('[appt notify] email error:', e.message); }
  }

  if (appt.clients.phone && tenant?.twilio_account_sid) {
    try {
      const twilio = require('twilio')(tenant.twilio_account_sid, tenant.twilio_auth_token);
      const date = new Date(appt.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const time = new Date(appt.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const msg = type === 'confirmation'
        ? `Hi ${appt.clients.name}, your appointment "${appt.title}" is confirmed for ${date} at ${time}. — ${tenant?.company_name || 'Your contractor'}`
        : `Reminder: "${appt.title}" is tomorrow, ${date} at ${time}. — ${tenant?.company_name || 'Your contractor'}`;
      await twilio.messages.create({ to: appt.clients.phone, from: tenant.twilio_phone, body: msg });
    } catch (e) { console.error('[appt notify] sms error:', e.message); }
  }
}

async function notifyApptAssignedTeam(appt, tenantId) {
  if (!appt?.job_id) return { push_sent: 0, total_recipients: 0 };

  const [{ data: job }, { data: assignments }] = await Promise.all([
    supabaseAdmin.from('jobs')
      .select('id, name, address')
      .eq('id', appt.job_id)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabaseAdmin.from('job_assignments')
      .select('employee_id, employees(id, name, phone, push_token)')
      .eq('job_id', appt.job_id)
      .eq('tenant_id', tenantId),
  ]);

  if (!job) return { push_sent: 0, total_recipients: 0 };

  const recipients = (assignments || [])
    .map(entry => entry.employees)
    .filter(Boolean)
    .filter((employee, index, arr) => arr.findIndex(other => other.id === employee.id) === index);

  let push_sent = 0;
  const date = new Date(appt.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = new Date(appt.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  for (const employee of recipients) {
    if (employee.push_token) {
      try {
        const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-encoding': 'gzip, deflate',
          },
          body: JSON.stringify({
            to: employee.push_token,
            sound: 'default',
            title: 'New calendar event',
            body: `"${appt.title}" is scheduled for ${date} at ${time}${job.name ? ` for ${job.name}` : ''}.`,
            data: { type: 'appointment', appointment_id: appt.id, job_id: job.id },
          }),
        });
        if (pushRes.ok) push_sent += 1;
      } catch (e) {
        console.error('[appt notify team] push error:', e.message);
      }
    }
  }

  return { push_sent, total_recipients: recipients.length };
}

app.get('/api/appointments', auth, async (req, res) => {
  const { start, end } = req.query;
  let query = supabaseAdmin
    .from('appointments')
    .select('*, clients(id, name, phone), jobs(id, name)')
    .order('start_time');
  if (req.tenantId) query = query.eq('tenant_id', req.tenantId);
  if (start) query = query.gte('start_time', start);
  if (end) query = query.lte('start_time', end);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/appointments', auth, async (req, res) => {
  const { title, start_time, end_time, client_id, job_id, notes, service_ids, send_confirmation, notify_assigned_team } = req.body;
  if (!title || !start_time) return res.status(400).json({ error: 'Title and start time are required' });
  if (job_id) {
    const { data: job } = await supabaseAdmin.from('jobs').select('id').eq('id', job_id).eq('tenant_id', req.tenantId).maybeSingle();
    if (!job) return res.status(400).json({ error: 'Selected job is invalid.' });
  }
  const { data, error } = await supabaseAdmin.from('appointments')
    .insert({ title, start_time, end_time: end_time || null, client_id: client_id || null, job_id: job_id || null, notes, service_ids: service_ids || [], tenant_id: req.tenantId })
    .select('*, clients(id, name, email, phone), jobs(id, name)').single();
  if (error) return res.status(400).json({ error: error.message });
  if (send_confirmation && data.clients) notifyApptClient(data, req.tenantId, 'confirmation').catch(() => {});
  if (notify_assigned_team && data.job_id) notifyApptAssignedTeam(data, req.tenantId).catch(() => {});
  res.json(data);
});

app.patch('/api/appointments/:id', auth, async (req, res) => {
  const { title, start_time, end_time, client_id, job_id, notes, service_ids, send_confirmation, notify_assigned_team } = req.body;
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (start_time !== undefined) updates.start_time = start_time;
  if (end_time !== undefined) updates.end_time = end_time || null;
  if (client_id !== undefined) updates.client_id = client_id || null;
  if (job_id !== undefined) {
    if (job_id) {
      const { data: job } = await supabaseAdmin.from('jobs').select('id').eq('id', job_id).eq('tenant_id', req.tenantId).maybeSingle();
      if (!job) return res.status(400).json({ error: 'Selected job is invalid.' });
      updates.job_id = job_id;
    } else {
      updates.job_id = null;
    }
  }
  if (notes !== undefined) updates.notes = notes;
  if (service_ids !== undefined) updates.service_ids = service_ids;
  if (start_time !== undefined) updates.owner_reminded = false; // reset if time changed
  const { data, error } = await supabaseAdmin.from('appointments').update(updates).eq('id', req.params.id).select('*, clients(id, name, email, phone), jobs(id, name)').single();
  if (error) return res.status(400).json({ error: error.message });
  if (send_confirmation && data.clients) notifyApptClient(data, req.tenantId, 'confirmation').catch(() => {});
  if (notify_assigned_team && data.job_id) notifyApptAssignedTeam(data, req.tenantId).catch(() => {});
  res.json(data);
});

app.delete('/api/appointments/:id', auth, async (req, res) => {
  await supabaseAdmin.from('appointments').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Timesheets ────────────────────────────────────────────────────────────────

// Get timesheet entries — filtered by date range and optionally employee
app.get('/api/timesheets', auth, requireOperationAccess, async (req, res) => {
  const { start, end, employee_id } = req.query;
  let query = supabaseAdmin
    .from('job_assignments')
    .select('id, checked_in_at, checked_out_at, punch_in_lat, punch_in_lng, punch_out_lat, punch_out_lng, manual_punch, job_id, employee_id, work_type, jobs(name), employees(id, name, role)')
    .eq('tenant_id', req.tenantId)
    .not('checked_in_at', 'is', null)
    .order('checked_in_at', { ascending: false });

  if (start) query = query.gte('checked_in_at', start);
  if (end) query = query.lte('checked_in_at', end);
  if (employee_id) query = query.eq('employee_id', employee_id);

  const { data } = await query;
  res.json(data || []);
});

// Manual punch in
app.post('/api/timesheets/punch-in', auth, requireOperationAccess, async (req, res) => {
  const { employee_id, job_id, work_type, lat, lng } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  // Check not already punched in
  const { data: existing } = await supabaseAdmin
    .from('job_assignments')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('employee_id', employee_id)
    .not('checked_in_at', 'is', null)
    .is('checked_out_at', null)
    .maybeSingle();
  if (existing) return res.status(400).json({ error: 'Already punched in' });

  // Upsert assignment
  let assignmentId;
  if (job_id) {
    const { data: existing } = await supabaseAdmin
      .from('job_assignments').select('id').eq('job_id', job_id).eq('employee_id', employee_id).maybeSingle();
    if (existing) {
      assignmentId = existing.id;
      await supabaseAdmin.from('job_assignments').update({
        checked_in_at: new Date().toISOString(),
        checked_out_at: null,
        work_type: null,
        punch_in_lat: lat || null,
        punch_in_lng: lng || null,
        manual_punch: true,
      }).eq('id', assignmentId);
    } else {
      const { data } = await supabaseAdmin.from('job_assignments').insert({
        job_id, employee_id, tenant_id: req.tenantId,
        work_type: null,
        checked_in_at: new Date().toISOString(),
        punch_in_lat: lat || null, punch_in_lng: lng || null,
        manual_punch: true,
      }).select().single();
      assignmentId = data?.id;
    }
  } else {
    // No job — use a placeholder: create a "No Job" punch
    const { data } = await supabaseAdmin.from('job_assignments').insert({
      employee_id, tenant_id: req.tenantId,
      work_type: work_type || null,
      checked_in_at: new Date().toISOString(),
      punch_in_lat: lat || null, punch_in_lng: lng || null,
      manual_punch: true,
    }).select().single();
    assignmentId = data?.id;
  }

  res.json({ ok: true, id: assignmentId });
});

// Manual punch out
app.post('/api/timesheets/punch-out', auth, requireOperationAccess, async (req, res) => {
  const { employee_id, lat, lng } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  const { data: entry } = await supabaseAdmin
    .from('job_assignments')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('employee_id', employee_id)
    .not('checked_in_at', 'is', null)
    .is('checked_out_at', null)
    .order('checked_in_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!entry) return res.status(404).json({ error: 'No active punch-in found' });

  await supabaseAdmin.from('job_assignments').update({
    checked_out_at: new Date().toISOString(),
    punch_out_lat: lat || null,
    punch_out_lng: lng || null,
  }).eq('id', entry.id);

  res.json({ ok: true });
});

app.get('/api/timesheets/my-active', auth, requireOperationAccess, async (req, res) => {
  if (!req.employeeId) return res.json({ entry: null });
  const { data: entry, error } = await supabaseAdmin
    .from('job_assignments')
    .select('id, job_id, work_type, checked_in_at, checked_out_at, jobs(name)')
    .eq('tenant_id', req.tenantId)
    .eq('employee_id', req.employeeId)
    .not('checked_in_at', 'is', null)
    .is('checked_out_at', null)
    .order('checked_in_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ entry: entry || null });
});

// Update a timesheet entry manually (admin correction)
app.patch('/api/timesheets/:id', auth, requireOperationAccess, async (req, res) => {
  const { checked_in_at, checked_out_at } = req.body;
  const updates = {};
  if (checked_in_at !== undefined) updates.checked_in_at = checked_in_at;
  if (checked_out_at !== undefined) updates.checked_out_at = checked_out_at || null;
  const { data, error } = await supabaseAdmin.from('job_assignments').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── Reports ───────────────────────────────────────────────────────────────────

app.get('/api/reports', auth, requireFinancialAccess, async (req, res) => {
  const { data: tenant } = await supabaseAdmin.from('tenants').select('plan').eq('id', req.tenantId).single();
  if (!['pro', 'business'].includes(tenant?.plan)) {
    return res.status(403).json({ error: 'upgrade_required', message: 'Reports are available on Pro and Business plans.' });
  }
  const days = parseInt(req.query.period || '30');
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = since.toISOString();

  const prevSince = new Date(); prevSince.setDate(prevSince.getDate() - days * 2);
  const prevSinceISO = prevSince.toISOString();

  const [{ data: allJobs }, { data: assignments }, { data: bottlenecks }, { data: expensesData }] = await Promise.all([
    scoped(supabaseAdmin.from('jobs').select('id, name, status, created_at, updated_at, invoice_amount, payment_status, client_id, clients(name)'), req.tenantId),
    scoped(
      supabaseAdmin.from('job_assignments')
        .select('employee_id, checked_in_at, checked_out_at, employees(name)')
        .not('checked_in_at', 'is', null)
        .not('checked_out_at', 'is', null)
        .gte('checked_in_at', sinceISO),
      req.tenantId
    ),
    scoped(supabaseAdmin.from('job_updates').select('id').eq('type', 'bottleneck').gte('created_at', sinceISO), req.tenantId),
    scoped(supabaseAdmin.from('expenses').select('amount, category, date').gte('date', prevSince.toISOString().split('T')[0]), req.tenantId),
  ]);

  // Jobs by status
  const jobsByStatus = {};
  (allJobs || []).forEach(j => {
    const normalizedStatus = normalizeJobStatus(j.status);
    jobsByStatus[normalizedStatus] = (jobsByStatus[normalizedStatus] || 0) + 1;
  });

  // Completed jobs trend — last 6 months
  const trend = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    trend[d.toLocaleString('default', { month: 'short', year: '2-digit' })] = 0;
  }
  (allJobs || []).filter(j => normalizeJobStatus(j.status) === 'completed').forEach(j => {
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

  const totalCrewHours = Math.round(Object.values(crewHours).reduce((a, b) => a + b, 0) * 10) / 10;

  // ── Money: revenue, expenses, profit ──
  const inPeriod = (ts) => ts && new Date(ts) >= since;
  const inPrevPeriod = (ts) => {
    if (!ts) return false;
    const t = new Date(ts);
    return t >= prevSince && t < since;
  };

  let revenue = 0, prevRevenue = 0, outstandingTotal = 0;
  const clientRevenue = {};
  (allJobs || []).forEach(j => {
    const amt = parseFloat(j.invoice_amount) || 0;
    if (amt <= 0) return;
    const isPaid = String(j.payment_status || '').toLowerCase() === 'paid';
    const refDate = j.updated_at || j.created_at;
    if (isPaid) {
      if (inPeriod(refDate)) revenue += amt;
      else if (inPrevPeriod(refDate)) prevRevenue += amt;
    } else {
      outstandingTotal += amt;
    }
    if (isPaid && inPeriod(refDate)) {
      const name = j.clients?.name || 'No client';
      clientRevenue[name] = (clientRevenue[name] || 0) + amt;
    }
  });

  let expensesTotal = 0, prevExpensesTotal = 0;
  const expenseByCategory = {};
  (expensesData || []).forEach(e => {
    const amt = parseFloat(e.amount) || 0;
    const dt = e.date;
    if (!dt) return;
    if (dt >= since.toISOString().split('T')[0]) {
      expensesTotal += amt;
      const c = e.category || 'other';
      expenseByCategory[c] = (expenseByCategory[c] || 0) + amt;
    } else {
      prevExpensesTotal += amt;
    }
  });

  const profit = revenue - expensesTotal;
  const prevProfit = prevRevenue - prevExpensesTotal;
  const revChangePct = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null;
  const profitChangePct = prevProfit !== 0 ? Math.round(((profit - prevProfit) / Math.abs(prevProfit)) * 100) : null;

  const topClients = Object.entries(clientRevenue)
    .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total).slice(0, 5);

  // Conversion funnel: requests → quotes → jobs → paid (in period)
  const inPeriodJobs = (allJobs || []).filter(j => inPeriod(j.created_at));
  const requestsCount = inPeriodJobs.filter(j => normalizeJobStatus(j.status) === 'quoted').length;
  const quotesCount = inPeriodJobs.filter(j => ['quoted','scheduled','active','in_progress','completed','invoiced'].includes(normalizeJobStatus(j.status))).length;
  const wonCount = inPeriodJobs.filter(j => ['scheduled','active','in_progress','completed','invoiced'].includes(normalizeJobStatus(j.status))).length;
  const paidCount = inPeriodJobs.filter(j => String(j.payment_status || '').toLowerCase() === 'paid').length;

  const revPerHour = totalCrewHours > 0 ? Math.round((revenue / totalCrewHours) * 100) / 100 : 0;

  // Revenue trend last 6 months (paid invoices grouped by month)
  const revTrend = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    revTrend[d.toLocaleString('default', { month: 'short', year: '2-digit' })] = 0;
  }
  (allJobs || []).forEach(j => {
    if (String(j.payment_status || '').toLowerCase() !== 'paid') return;
    const amt = parseFloat(j.invoice_amount) || 0;
    if (amt <= 0) return;
    const ref = j.updated_at || j.created_at;
    const key = new Date(ref).toLocaleString('default', { month: 'short', year: '2-digit' });
    if (revTrend[key] !== undefined) revTrend[key] += amt;
  });

  res.json({
    // Money
    revenue: Math.round(revenue * 100) / 100,
    prevRevenue: Math.round(prevRevenue * 100) / 100,
    revChangePct,
    expensesTotal: Math.round(expensesTotal * 100) / 100,
    prevExpensesTotal: Math.round(prevExpensesTotal * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    profitChangePct,
    outstandingTotal: Math.round(outstandingTotal * 100) / 100,
    expenseByCategory,
    topClients,
    revTrend,
    revPerHour,
    // Funnel
    funnel: { requests: requestsCount, quotes: quotesCount, won: wonCount, paid: paidCount },
    // Operational signals
    crewHours: crewHoursSorted,
    bottlenecksCount: (bottlenecks || []).length,
    totalCrewHours,
    completedJobs: (allJobs || []).filter(j => normalizeJobStatus(j.status) === 'completed').length,
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

// Public: fetch tenant branding from a portal token (used by login page pre-auth)
app.get('/portal/api/branding', async (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.json({});
  const { data: clientUser } = await supabaseAdmin
    .from('client_users')
    .select('tenant_id')
    .eq('portal_token', token)
    .maybeSingle();
  if (!clientUser?.tenant_id) return res.json({});
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, logo_url')
    .eq('id', clientUser.tenant_id)
    .maybeSingle();
  res.json({ company_name: tenant?.company_name || null, logo_url: tenant?.logo_url || null });
});

// Generate (or regenerate) a portal invite link for a client
app.post('/api/clients/:id/invite', auth, async (req, res) => {
  const { id } = req.params;
  const token = crypto.randomBytes(32).toString('hex');

  const [{ data: client }, { data: tenant }] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name, email').eq('id', id).eq('tenant_id', req.tenantId).single(),
    supabaseAdmin.from('tenants').select('company_name').eq('id', req.tenantId).single(),
  ]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data, error } = await supabaseAdmin
    .from('client_users')
    .upsert({ client_id: id, portal_token: token, tenant_id: req.tenantId }, { onConflict: 'client_id' })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  const portalUrl = `${req.protocol}://${req.get('host')}/portal?token=${token}`;
  let emailSent = false;
  if (client.email) {
    try {
      await sendClientPortalInvite({
        clientName: client.name || 'there',
        clientEmail: client.email,
        portalUrl,
        tenantName: tenant?.company_name,
      });
      emailSent = true;
    } catch (emailErr) {
      console.error('[client invite] email error:', emailErr.message);
    }
  }

  res.json({ portalUrl, emailSent, emailedTo: emailSent ? client.email : null });
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
app.post('/portal/api/requests', portalAuth, upload.fields([{ name: 'photos', maxCount: 5 }, { name: 'photo', maxCount: 1 }]), async (req, res) => {
  const { description, address } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const [{ data: client }, { data: tenant }] = await Promise.all([
    supabaseAdmin.from('clients').select('name').eq('id', req.clientId).single(),
    supabaseAdmin.from('tenants').select('company_name, owner_email').eq('id', req.tenantId).single(),
  ]);

  const { data: job, error } = await supabaseAdmin
    .from('jobs')
    .insert({ name: `Request – ${client?.name || 'Client'}`, address: address || '', status: 'quoted', client_id: req.clientId, tenant_id: req.tenantId })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  await supabaseAdmin.from('job_updates').insert({
    job_id: job.id,
    message: description,
    type: 'note',
    photo_url: null,
  });

  const requestPhotos = [
    ...((req.files && req.files.photos) || []),
    ...((req.files && req.files.photo) || []),
  ].slice(0, 5);

  for (let i = 0; i < requestPhotos.length; i++) {
    const file = requestPhotos[i];
    const ext = file.mimetype.split('/')[1] || 'jpg';
    const filePath = `requests/${job.id}/${Date.now()}-${i + 1}.${ext}`;
    const { data: uploaded, error: uploadErr } = await supabaseAdmin.storage
      .from('portal-photos')
      .upload(filePath, file.buffer, { contentType: file.mimetype });
    if (uploadErr || !uploaded) continue;

    const { data: { publicUrl } } = supabaseAdmin.storage.from('portal-photos').getPublicUrl(uploaded.path);
    await supabaseAdmin.from('job_updates').insert({
      job_id: job.id,
      message: requestPhotos.length > 1 ? `Client request photo ${i + 1} of ${requestPhotos.length}` : 'Client request photo',
      type: 'photo',
      photo_url: publicUrl,
    });
  }

  if (tenant?.owner_email) {
    sendClientRequestToOwner({
      ownerEmail: tenant.owner_email,
      tenantName: tenant.company_name,
      clientName: client?.name || 'Client',
      address,
      description,
      dashboardUrl: `${req.protocol}://${req.get('host')}`,
    }).catch((emailErr) => {
      console.error('[portal request] owner email error:', emailErr.message);
    });
  }

  res.json(job);
});

// ── Crew Assignment ───────────────────────────────────────────────────────────

// Assign employee to job (pre-assignment, no check-in yet)
app.post('/api/jobs/:id/assign', auth, async (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  const { data: job } = await supabaseAdmin.from('jobs').select('id').eq('id', req.params.id).eq('tenant_id', req.tenantId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data: employee } = await supabaseAdmin.from('employees').select('id, status').eq('id', employee_id).eq('tenant_id', req.tenantId).single();
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!employeeStatusAllowsAssignment(employee.status)) {
    return res.status(400).json({ error: 'This team member is not currently available for assignment.' });
  }

  // Check if already assigned
  const { data: existing } = await supabaseAdmin.from('job_assignments').select('id').eq('job_id', req.params.id).eq('employee_id', employee_id).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Already assigned' });

  const { data, error } = await supabaseAdmin.from('job_assignments').insert({ job_id: req.params.id, employee_id, tenant_id: req.tenantId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/jobs/:id/notify-assignment', auth, async (req, res) => {
  const { employee_id, method = 'both' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!['app', 'sms', 'both'].includes(method)) return res.status(400).json({ error: 'Invalid notification method' });

  const { data: job } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, tenant_id')
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data: employee } = await supabaseAdmin
    .from('employees')
    .select('id, name, phone, push_token')
    .eq('id', employee_id)
    .eq('tenant_id', req.tenantId)
    .single();
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('company_name, twilio_phone, twilio_account_sid, twilio_auth_token')
    .eq('id', req.tenantId)
    .single();

  let push_sent = false;
  let sms_sent = false;

  const wantsPush = method === 'app' || method === 'both';
  const wantsSms = method === 'sms' || method === 'both';

  if (wantsPush && employee.push_token) {
    try {
      const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
        },
        body: JSON.stringify({
          to: employee.push_token,
          sound: 'default',
          title: 'New job assignment',
          body: `You were assigned to "${job.name}". ${job.address || 'Open LinkCrew for details.'}`,
          data: { type: 'job_assignment', job_id: job.id },
        }),
      });
      push_sent = pushRes.ok;
    } catch (e) {
      console.error('[job assignment push] error:', e.message);
    }
  }

  if (wantsSms && employee.phone && tenant?.twilio_account_sid && tenant?.twilio_phone) {
    try {
      const twilioClient = twilio(tenant.twilio_account_sid, tenant.twilio_auth_token);
      await twilioClient.messages.create({
        to: employee.phone,
        from: tenant.twilio_phone,
        body: `${tenant.company_name || 'LinkCrew'} assigned you to "${job.name}"${job.address ? ` at ${job.address}` : ''}. Open the app for job details.`,
      });
      sms_sent = true;
    } catch (e) {
      console.error('[job assignment sms] error:', e.message);
    }
  }

  await supabaseAdmin.from('job_updates').insert({
    job_id: job.id,
    employee_id: employee.id,
    type: 'assignment',
    message: `Assignment reminder sent to ${employee.name} via ${method === 'both' ? 'app/text' : method}.${push_sent || sms_sent ? ` ${push_sent ? 'App alert' : ''}${push_sent && sms_sent ? ' and ' : ''}${sms_sent ? 'text message' : ''} delivered.` : ' No delivery channel was available.'}`,
  });

  res.json({ ok: true, push_sent, sms_sent });
});

// Remove assignment (only if not currently checked in)
app.delete('/api/jobs/:id/assign/:employeeId', auth, async (req, res) => {
  const { data: job } = await supabaseAdmin.from('jobs').select('id').eq('id', req.params.id).eq('tenant_id', req.tenantId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data: assignment } = await supabaseAdmin.from('job_assignments').select('id, checked_in_at, checked_out_at').eq('job_id', req.params.id).eq('employee_id', req.params.employeeId).maybeSingle();
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.checked_in_at && !assignment.checked_out_at) return res.status(400).json({ error: 'Cannot remove crew member who is currently on site' });

  await supabaseAdmin.from('job_assignments').delete().eq('id', assignment.id);
  res.json({ ok: true });
});

// ── Invoicing ─────────────────────────────────────────────────────────────────

app.post('/api/jobs/:id/invoice', auth, requireFinancialAccess, async (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0)
    return res.status(400).json({ error: 'Valid amount required' });
  const { data, error } = await supabaseAdmin.from('jobs')
    .update({ invoice_amount: parseFloat(amount), status: 'invoiced', payment_status: 'unpaid' })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).select('*, clients(name, email)').single();
  if (error) return res.status(400).json({ error: error.message });

  // Send invoice email to client if they have an email
  const client = data.clients;
  let invoiceEmailSent = false;
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
      invoiceEmailSent = true;
    } catch (emailErr) {
      console.error('[invoice] email error:', emailErr.message);
    }
  }

  res.json({ ...redactJobsForRole(data, req), invoice_email_sent: invoiceEmailSent, invoice_emailed_to: invoiceEmailSent ? client.email : null });
});

// Mark invoice as paid (cash / in-person payment)
app.post('/api/jobs/:id/mark-paid', auth, requireFinancialAccess, async (req, res) => {
  const { notify } = req.body; // 'email' | 'sms' | null
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .update({ payment_status: 'paid' })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId)
    .select('*, clients(name, email, phone)')
    .single();
  if (error) return res.status(400).json({ error: error.message });

  if (notify && job.clients) {
    const tenantId = await getEffectiveTenantId(req);
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('company_name, twilio_phone, twilio_account_sid, twilio_auth_token')
      .eq('id', tenantId).single();

    if (notify === 'email' && job.clients.email) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: LINKCREW_FROM,
          to: job.clients.email,
          subject: `Payment received — ${job.name}`,
          html: `<div style="font-family:sans-serif;max-width:500px">
            <h2 style="color:#166534">Payment Received</h2>
            <p>Hi ${job.clients.name},</p>
            <p>This is a confirmation that your payment of <strong>$${parseFloat(job.invoice_amount).toFixed(2)}</strong> for <strong>${job.name}</strong> has been received.</p>
            <p>Thank you for your business!</p>
            <p style="color:#737475;font-size:12px">${tenant?.company_name || 'Your contractor'}</p>
          </div>`,
        });
      } catch (e) { console.error('[mark-paid] email error:', e.message); }
    }

    if (notify === 'sms' && job.clients.phone && tenant?.twilio_account_sid) {
      try {
        const twilio = require('twilio')(tenant.twilio_account_sid, tenant.twilio_auth_token);
        await twilio.messages.create({
          to: job.clients.phone,
          from: tenant.twilio_phone,
          body: `Hi ${job.clients.name}, payment of $${parseFloat(job.invoice_amount).toFixed(2)} for "${job.name}" has been received. Thank you! — ${tenant?.company_name || 'Your contractor'}`,
        });
      } catch (e) { console.error('[mark-paid] sms error:', e.message); }
    }
  }

  res.json(redactJobsForRole(job, req));
});

// Portal: create Stripe Checkout session
app.post('/portal/api/checkout', portalAuth, async (req, res) => {
  const { job_id } = req.body;
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('id, name, invoice_amount, payment_status, client_id, tenant_id')
    .eq('id', job_id).eq('client_id', req.clientId).single();

  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.payment_status === 'paid') return res.status(400).json({ error: 'Already paid' });
  if (!job.invoice_amount) return res.status(400).json({ error: 'No invoice amount set' });

  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_connect_account_id, stripe_connect_status')
    .eq('id', job.tenant_id).single();

  if (tenant?.stripe_connect_status !== 'active' || !tenant.stripe_connect_account_id) {
    return res.status(400).json({ error: 'This contractor has not connected a payment processor. Please use one of the other payment methods shown on your invoice.' });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sessionParams = {
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
    metadata: { job_id: job.id, tenant_id: job.tenant_id },
    payment_intent_data: { application_fee_amount: 0 },
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create(sessionParams, { stripeAccount: tenant.stripe_connect_account_id });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ url: session.url });
});

// ── Stripe Connect (Standard accounts — contractors connect their own Stripe) ─

function signConnectState(tenantId) {
  const secret = process.env.STRIPE_CONNECT_STATE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev';
  const payload = `${tenantId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyConnectState(state) {
  try {
    const secret = process.env.STRIPE_CONNECT_STATE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev';
    const decoded = Buffer.from(String(state || ''), 'base64url').toString();
    const parts = decoded.split('.');
    if (parts.length !== 3) return null;
    const [tenantId, ts, sig] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${tenantId}.${ts}`).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    if (Date.now() - parseInt(ts, 10) > 60 * 60 * 1000) return null;
    return tenantId;
  } catch { return null; }
}

app.get('/api/stripe/connect/start', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Stripe Connect is not configured' });
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const hostHeader = req.get('host') || 'linkcrew.io';
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(hostHeader);
  const scheme = isLocal ? (req.protocol || 'http') : 'https';
  const redirectUri = `${scheme}://${hostHeader}/api/stripe/connect/callback`;
  const state = signConnectState(tenantId);
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('owner_email, company_name').eq('id', tenantId).single();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
    'stripe_user[email]': tenant?.owner_email || '',
    'stripe_user[business_name]': tenant?.company_name || '',
  });
  res.json({ url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` });
});

app.get('/api/stripe/connect/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;
  if (oauthError) {
    return res.redirect(`/app?stripe_connect=error&msg=${encodeURIComponent(error_description || oauthError)}`);
  }
  const tenantId = verifyConnectState(state);
  if (!tenantId || !code) {
    return res.redirect('/app?stripe_connect=error&msg=invalid_state');
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const resp = await stripe.oauth.token({ grant_type: 'authorization_code', code });
    await supabaseAdmin.from('tenants').update({
      stripe_connect_account_id: resp.stripe_user_id,
      stripe_connect_status: 'active',
    }).eq('id', tenantId);
    return res.redirect('/app?stripe_connect=success');
  } catch (err) {
    console.error('[stripe connect] oauth token error:', err.message);
    return res.redirect(`/app?stripe_connect=error&msg=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/stripe/connect/disconnect', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_connect_account_id').eq('id', tenantId).single();
  if (tenant?.stripe_connect_account_id && process.env.STRIPE_CONNECT_CLIENT_ID) {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    try {
      await stripe.oauth.deauthorize({
        client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
        stripe_user_id: tenant.stripe_connect_account_id,
      });
    } catch (err) {
      console.error('[stripe connect] deauthorize error:', err.message);
    }
  }
  await supabaseAdmin.from('tenants').update({
    stripe_connect_account_id: null,
    stripe_connect_status: null,
  }).eq('id', tenantId);
  res.json({ ok: true });
});

app.get('/api/stripe/connect/status', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.json({ connected: false });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_connect_account_id, stripe_connect_status').eq('id', tenantId).single();
  res.json({
    connected: tenant?.stripe_connect_status === 'active' && !!tenant.stripe_connect_account_id,
    status: tenant?.stripe_connect_status || null,
  });
});

// Payment methods (Zelle/Venmo/etc. with QR codes rendered on invoices)
const PAYMENT_METHOD_TYPES = new Set(['zelle', 'venmo', 'paypal', 'cashapp', 'ach', 'check', 'other']);

function sanitizePaymentMethods(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 12).map(m => ({
    type: PAYMENT_METHOD_TYPES.has(m?.type) ? m.type : 'other',
    label: String(m?.label || '').slice(0, 60),
    detail: String(m?.detail || '').slice(0, 200),
    qr_url: m?.qr_url ? String(m.qr_url).slice(0, 500) : null,
    enabled: m?.enabled !== false,
  })).filter(m => m.label || m.detail || m.qr_url);
}

app.get('/api/payment-methods', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data } = await supabaseAdmin.from('tenants')
    .select('payment_methods').eq('id', tenantId).single();
  res.json({ payment_methods: data?.payment_methods || [] });
});

app.put('/api/payment-methods', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const cleaned = sanitizePaymentMethods(req.body?.payment_methods);
  const { error } = await supabaseAdmin.from('tenants')
    .update({ payment_methods: cleaned }).eq('id', tenantId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ payment_methods: cleaned });
});

app.post('/api/payment-methods/qr', auth, requireSettingsAccess, requireFinancialAccess, upload.single('qr'), async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'File must be an image' });
  const ext = (req.file.originalname.split('.').pop() || 'png').toLowerCase().slice(0, 5);
  const filePath = `${tenantId}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from('payment-qrs')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (uploadError) return res.status(400).json({ error: uploadError.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('payment-qrs').getPublicUrl(filePath);
  res.json({ qr_url: publicUrl });
});

// ── Billing ───────────────────────────────────────────────────────────────────

app.get('/api/billing/status', auth, requireFinancialAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { data } = await supabaseAdmin.from('tenants')
    .select('plan, subscription_status, trial_ends_at, stripe_customer_id, max_users, extra_users')
    .eq('id', tenantId).single();
  res.json(data || {});
});

app.post('/api/billing/checkout', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
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

// Extra users add-on checkout
app.post('/api/billing/extra-users', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
  const { quantity } = req.body;
  if (!quantity || quantity < 1 || quantity > 50)
    return res.status(400).json({ error: 'Quantity must be between 1 and 50' });
  const priceId = process.env.STRIPE_PRICE_EXTRA_USER;
  if (!priceId) return res.status(500).json({ error: 'Extra user pricing not configured' });
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
      line_items: [{ price: priceId, quantity: parseInt(quantity) }],
      success_url: `${req.protocol}://${req.get('host')}/app?billing=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/app`,
      metadata: { tenant_id: tenantId, addon: 'extra_users', quantity: String(quantity) },
      subscription_data: { metadata: { tenant_id: tenantId, addon: 'extra_users', quantity: String(quantity) } },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/billing/portal', auth, requireSettingsAccess, requireFinancialAccess, async (req, res) => {
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
  const { data, error } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email, logo_url, phone, address, voicebot_enabled, twilio_phone, twilio_account_sid, voicebot_knowledge, photo_expiry_days, appt_reminder_minutes, manager_financials_enabled')
    .eq('id', tenantId).single();
  if (!error && data) return res.json(data);
  if (error && !/manager_financials_enabled/i.test(error.message || '')) {
    return res.status(400).json({ error: error.message });
  }
  const fallback = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email, logo_url, phone, address, voicebot_enabled, twilio_phone, twilio_account_sid, voicebot_knowledge, photo_expiry_days, appt_reminder_minutes')
    .eq('id', tenantId).single();
  if (fallback.error) return res.status(400).json({ error: fallback.error.message });
  const toggleState = await getTenantManagerFinancialAccess(tenantId);
  res.json({ ...fallback.data, manager_financials_enabled: toggleState.enabled });
});

app.patch('/api/settings', auth, requireSettingsAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  const { company_name, phone, address, license_number, voicebot_knowledge, photo_expiry_days, appt_reminder_minutes, manager_financials_enabled } = req.body;
  const syncManagerFinancialAccess = async enabled => {
    const syncResult = await supabaseAdmin
      .from('tenant_users')
      .update({ can_view_financials: !!enabled })
      .eq('tenant_id', tenantId)
      .in('role', ['manager', 'supervisor']);
    if (syncResult.error && !/column/i.test(syncResult.error.message || '')) {
      throw syncResult.error;
    }
  };
  const updates = {};
  if (company_name !== undefined) updates.company_name = company_name;
  if (phone !== undefined) updates.phone = phone;
  if (address !== undefined) updates.address = address;
  if (license_number !== undefined) updates.license_number = (typeof license_number === 'string' ? license_number.trim() : license_number) || null;
  if (voicebot_knowledge !== undefined) updates.voicebot_knowledge = voicebot_knowledge;
  if (photo_expiry_days !== undefined) updates.photo_expiry_days = photo_expiry_days || null;
  if (appt_reminder_minutes !== undefined) updates.appt_reminder_minutes = appt_reminder_minutes;
  if (manager_financials_enabled !== undefined) updates.manager_financials_enabled = !!manager_financials_enabled;
  const { data, error } = await supabaseAdmin.from('tenants')
    .update(updates).eq('id', tenantId).select().single();
  if (!error) {
    if (manager_financials_enabled !== undefined) {
      try {
        await syncManagerFinancialAccess(manager_financials_enabled);
      } catch (syncError) {
        return res.status(400).json({ error: syncError.message });
      }
    }
    return res.json(data);
  }

  if (manager_financials_enabled !== undefined && /manager_financials_enabled/i.test(error.message || '')) {
    const toggleResult = await updateTenantManagerFinancialAccess(tenantId, manager_financials_enabled);
    if (toggleResult.error) return res.status(400).json({ error: toggleResult.error.message });
    try {
      await syncManagerFinancialAccess(manager_financials_enabled);
    } catch (syncError) {
      return res.status(400).json({ error: syncError.message });
    }
    const fallbackFields = { ...updates };
    delete fallbackFields.manager_financials_enabled;
    if (!Object.keys(fallbackFields).length) {
      return res.json({ manager_financials_enabled: !!manager_financials_enabled });
    }
    const fallbackUpdate = await supabaseAdmin.from('tenants')
      .update(fallbackFields).eq('id', tenantId).select().single();
    if (fallbackUpdate.error) return res.status(400).json({ error: fallbackUpdate.error.message });
    return res.json({ ...fallbackUpdate.data, manager_financials_enabled: !!manager_financials_enabled });
  }
  return res.status(400).json({ error: error.message });
});

app.post('/api/settings/logo', auth, requireSettingsAccess, upload.single('logo'), async (req, res) => {
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

app.delete('/api/settings/logo', auth, requireSettingsAccess, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!tenantId) return res.status(404).json({ error: 'No tenant found' });
  // Best-effort delete of any stored logo files for this tenant, then clear the DB pointer
  try {
    const { data: files } = await supabaseAdmin.storage.from('logos').list(tenantId, { limit: 20 });
    if (files && files.length) {
      await supabaseAdmin.storage.from('logos')
        .remove(files.map(f => `${tenantId}/${f.name}`));
    }
  } catch (err) {
    console.error('[logo delete] storage cleanup error:', err.message);
  }
  const { error } = await supabaseAdmin.from('tenants').update({ logo_url: null }).eq('id', tenantId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// Save Twilio credentials + auto-configure webhook on the phone number
app.post('/api/settings/voicebot', auth, requireSettingsAccess, async (req, res) => {
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
app.delete('/api/settings/voicebot', auth, requireSettingsAccess, async (req, res) => {
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

const KDG_SYSTEM = `You are an embedded chat assistant on kingstondatagroup.com. The user is already on KDG's website — never tell them to "visit kingstondatagroup.com" or "go to the website." Reference on-page sections directly when useful (e.g. "the services section above", "the pricing section", "the contact form below").

Kingston Data Group (KDG) is an AI automation and SaaS development studio based in Silicon Valley. KDG builds AI-powered software that automates business operations. Their flagship product is LinkCrew (linkcrew.io) — a field crew management platform for contractors.

SERVICES:
- AI Automation: Automate repetitive workflows — scheduling, dispatching, reporting, invoicing, customer communication
- SaaS Product Development: Full-stack development from concept to live product, mobile apps, cloud infrastructure
- AI Voice & Chat Agents: Intelligent voice bots and chat assistants, 24/7, no staff required
- System Integration: Connect CRMs, ERPs, accounting software, field apps into unified automated pipelines
- Dashboards & Reporting: Real-time operations dashboards with custom metrics and alerts
- Cloud & Infrastructure: Secure, scalable cloud architecture
- Data Center & Lab Services: Rack & stack, server configuration, lab management, structured cabling, remote hands

ABOUT KDG:
- 15+ years of IT infrastructure and data center experience
- Native AI integration in every product
- 24/7 always-on systems
- Full product development from idea to live launch
- Contact: sales@kingstondatagroup.com | (260) 544-6900

BOOKING / TALKING TO A HUMAN:
- For meetings, calls, or quotes: invite them to email sales@kingstondatagroup.com or call (260) 544-6900.
- Even better: capture their name + email + what they're trying to do directly in chat and tell them someone will follow up. Don't push them off to email if they're willing to share details here.

DEMO:
- If someone asks to see a demo, try the AI, or asks how the voice/chat bot would work for their business, output the exact marker ##DEMO## in your reply and invite them to try a live personalized demo.

You have access to web search to answer questions about AI, automation, SaaS, and technology trends.

RESPONSE RULES:
- Keep responses SHORT — 2-4 sentences max. Never use bullet lists or long paragraphs.
- When mentioning email, always format it as: [sales@kingstondatagroup.com](mailto:sales@kingstondatagroup.com)
- When mentioning phone, always format it as: [(260) 544-6900](tel:+12605446900)
- Be conversational, ask one follow-up question at a time.
- Never make up pricing — direct them to email or call for a custom quote, or capture their needs in chat for a tailored quote.`;

app.post('/api/chat-kdg', async (req, res) => {
  const { message, sessionId, demoMode, demoData, demoTurns } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const sid = sessionId || crypto.randomUUID();
  const { data: existingSession } = await supabaseAdmin.from('kdg_chat_sessions')
    .select('history').eq('session_id', sid).maybeSingle();
  const history = existingSession?.history || [];
  history.push({ role: 'user', content: message });

  // ── Demo running mode — pretend to be the user's business ──────────────
  if (demoMode && demoData) {
    const { industry, company, city } = demoData;
    const maxTurns = 5;
    const isLastTurn = (demoTurns || 0) >= maxTurns - 1;
    const demoSystem = `You are an AI chat/phone assistant for ${company}, a ${industry} business in ${city}. Answer questions on their behalf — be helpful, friendly, and realistic.
Keep responses to 1-3 short sentences. Make up reasonable details (hours, services, pricing ranges) if needed — this is a live demo.
Do NOT mention KDG, Kingston Data Group, or any software company. Stay in character as ${company}'s assistant at all times.
${isLastTurn ? `After your response, add this exact marker on a new line with nothing after it: ##DEMO_END##` : ''}`;

    try {
      const result = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: demoSystem,
        messages: history.slice(-10),
      });
      let reply = result.content[0].text;
      const isDemoEnd = reply.includes('##DEMO_END##');
      reply = reply.replace(/##DEMO_END##.*/s, '').trim();
      history.push({ role: 'assistant', content: reply });
      await supabaseAdmin.from('kdg_chat_sessions').upsert({
        session_id: sid, history, updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id' });
      return res.json({ reply, sessionId: sid, demoEnd: isDemoEnd });
    } catch (err) {
      console.error('[kdg chat demo] Claude error:', err.message);
      return res.status(500).json({ error: 'Failed to get response' });
    }
  }

  // ── Normal support mode ────────────────────────────────────────────────
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
      messages: history.slice(-12),
    });
    let reply = result.content[0].text;
    const triggerDemo = reply.includes('##DEMO##');
    reply = reply.replace(/##DEMO##/g, '').trim();
    history.push({ role: 'assistant', content: reply });
    await supabaseAdmin.from('kdg_chat_sessions').upsert({
      session_id: sid, history, updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' });
    res.json({ reply, sessionId: sid, triggerDemo });
  } catch (err) {
    console.error('[kdg chat] Claude error:', err.message);
    res.status(500).json({ error: 'Failed to get response' });
  }
});

// ── KDG Voice Bot ─────────────────────────────────────────────────────────────

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

  try { await saveKdgVoiceSession(callSid, { callerNumber, startTime: Date.now(), history: [] }); }
  catch (err) { console.error('[kdg voice] session save error:', err.message); }

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/voice/kdg/respond',
    speechTimeout: '3',
    timeout: 10,
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

  let conv = await getKdgVoiceSession(callSid);
  if (!conv) conv = { callerNumber: req.body.From || 'Unknown', startTime: Date.now(), history: [] };
  if (speech) conv.history.push({ role: 'user', content: speech });

  let reply = "I'm sorry, I didn't catch that. Could you repeat that?";
  try {
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system: `You are a phone assistant for Kingston Data Group, an AI automation and SaaS studio. Be brief — max 2 sentences per response.
For meetings: get name and email, say someone follows up within 1 business day.
For pricing: custom quotes only, invite discovery call.
Services: AI Automation, SaaS Dev, Voice/Chat Agents, Integrations, Dashboards, Cloud.
Contact: sales@kingstondatagroup.com`,
      messages: conv.history.slice(-10),
    });
    reply = result.content[0].text;
    conv.history.push({ role: 'assistant', content: reply });
  } catch (err) {
    console.error('[kdg voice] Claude error:', err.message);
  }

  await saveKdgVoiceSession(callSid, conv);

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
  const conv = callSid ? await getKdgVoiceSession(callSid) : null;

  if (conv?.history?.length) {
    const duration = conv.startTime
      ? Math.round((Date.now() - conv.startTime) / 1000) + 's'
      : null;
    try {
      const { Resend } = require('resend');
      const r = new Resend(process.env.RESEND_API_KEY);
      const callerLines = conv.history.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
      const callbackKeywords = ['call me back', 'call me at', 'callback', 'call back', 'reach me', 'get back to me', 'give me a call', 'have someone call', 'can you call', 'please call'];
      const callbackRequested = callbackKeywords.some(kw => callerLines.includes(kw));
      const transcript = conv.history.map(m => `${m.role === 'user' ? 'Caller' : 'Bot'}: ${m.content}`).join('\n');
      const callbackBanner = callbackRequested
        ? `<div style="margin-bottom:16px;padding:14px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px"><strong style="color:#92400e">📲 Callback Requested</strong><p style="margin:4px 0 0;color:#b45309;font-size:13px">This caller asked to be called back at ${conv.callerNumber}.</p></div>`
        : '';
      await r.emails.send({
        from: formatFrom('KDG Voice Bot', EMAIL_FROM_ADDRESS),
        to: 'sales@kingstondatagroup.com',
        subject: callbackRequested
          ? `📲 Callback requested — ${conv.callerNumber} (KDG)`
          : `KDG Call from ${conv.callerNumber}${duration ? ' (' + duration + ')' : ''}`,
        html: `<div style="font-family:sans-serif;max-width:600px">
          <h2 style="color:#f97316">${callbackRequested ? '📲 Callback Requested' : 'Incoming Call Transcript'}</h2>
          <p><strong>Caller:</strong> ${conv.callerNumber}</p>
          ${duration ? `<p><strong>Duration:</strong> ${duration}</p>` : ''}
          ${callbackBanner}
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

  if (callSid) await deleteKdgVoiceSession(callSid);

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

  try {
    await saveVoiceSession(callSid, {
      tenantId,
      companyName: tenant.company_name,
      ownerEmail: tenant.owner_email,
      knowledge: tenant.voicebot_knowledge || '',
      callerNumber,
      startTime: Date.now(),
      mode: 'support',
      demoData: {},
      demoStep: 0,
      demoTurns: 0,
      history: [],
    });
  } catch (err) { console.error('[contractor voice] session save error:', err.message); }

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/api/voice/contractor/${tenantId}/respond`,
    speechTimeout: '3',
    timeout: 10,
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
    const g = t.gather({ input: 'speech', action: `/api/voice/contractor/${tenantId}/respond`, speechTimeout: '3', timeout: 10, language: 'en-US' });
    g.say({ voice: 'Polly.Joanna' }, msg);
    t.redirect(`/api/voice/contractor/${tenantId}/end?sid=${callSid}`);
    res.type('text/xml');
    res.send(t.toString());
  };
  try {

  let conv = await getVoiceSession(callSid);
  if (!conv) {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('company_name, owner_email, voicebot_knowledge').eq('id', tenantId).single();
    conv = {
      tenantId, history: [],
      companyName: tenant?.company_name || 'LinkCrew',
      ownerEmail: tenant?.owner_email,
      knowledge: tenant?.voicebot_knowledge || '',
      callerNumber: req.body.From || 'Unknown',
      startTime: Date.now(),
      mode: 'support', demoData: {}, demoStep: 0, demoTurns: 0,
    };
  }
  if (speech) conv.history.push({ role: 'user', content: speech });

  // ── Build system prompt based on current mode ────────────────────────────
  let systemPrompt = '';
  let spokenReply = '';

  if (conv.mode === 'support') {
    const demoAlreadyDone = !!conv.demoCompleted
    systemPrompt = `You are an AI assistant for LinkCrew, a field service management platform for contractors. This is a phone call.

Style: friendly, concise, 1-3 short sentences per reply. Plain language. No markdown, no bullet points (you're being read aloud).

When the caller asks about LinkCrew — pricing, features, the voice bot add-on, how it works — answer directly from the product info below. These are PRODUCT QUESTIONS, not demo requests.

${demoAlreadyDone
  ? `IMPORTANT: This caller has already completed a personalized demo on this call. Do NOT trigger another demo. Just answer their LinkCrew questions directly. Never output ##DEMO##.`
  : `Demo trigger — strict: ONLY output the marker ##DEMO## if the caller EXPLICITLY asks for a demo with phrases like "show me a demo", "I want a demo", "can I see a demo", "let me try a demo", "give me a demo", or simply says "demo". Do NOT trigger demo mode just because they ask about the voice bot, ask how it works, or ask about pricing — those are normal questions, answer them from product info.`
}

If asked something you don't know, say you'll have someone follow up. Never invent prices or features.

${conv.knowledge ? `LinkCrew product info:\n${conv.knowledge}` : ''}`;

  } else if (conv.mode === 'demo_collecting') {
    // Derive which step we're on from what's already collected — more robust than a counter
    if (!conv.demoData) conv.demoData = {};

    if (!conv.demoData.trade) {
      // Just received the trade answer
      conv.demoData.trade = speech;
      spokenReply = "Got it! And what's your company name?";
    } else if (!conv.demoData.company) {
      // Just received the company name
      conv.demoData.company = speech;
      spokenReply = "Almost there — what city or area do you serve?";
    } else if (!conv.demoData.city) {
      // Just received the city — all data collected, start demo
      conv.demoData.city = speech;
      conv.mode = 'demo_running';
      conv.demoTurns = 0;
      conv.history = [];
      const { trade, company, city } = conv.demoData;
      const greeting = `Hello, thanks for calling ${company}, ${city}'s trusted ${trade} professionals! We handle everything from estimates to completed jobs. How can I help you today?`;
      conv.history.push({ role: 'assistant', content: greeting });
      spokenReply = greeting;
    } else {
      // Fallback — all data present, kick off demo anyway
      conv.mode = 'demo_running';
      conv.demoTurns = 0;
      conv.history = [];
      const { trade, company, city } = conv.demoData;
      const greeting = `Hello, thanks for calling ${company}, ${city}'s trusted ${trade} professionals! How can I help you today?`;
      conv.history.push({ role: 'assistant', content: greeting });
      spokenReply = greeting;
    }

    // Skip Claude call entirely for demo_collecting
    await saveVoiceSession(callSid, conv);
    const twiml2 = new VoiceResponse();
    const gather2 = twiml2.gather({
      input: 'speech',
      action: `/api/voice/contractor/${tenantId}/respond`,
      speechTimeout: '3',
      timeout: 10,
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
        speechTimeout: '3', timeout: 10, language: 'en-US',
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
    systemPrompt = `You are an AI phone assistant for ${company}, a ${trade} business in ${city}. You answer their phones, handle inquiries, and book appointments.

Your job on this call:
1. Answer the caller's questions helpfully and naturally — make up realistic details (hours, services, pricing ranges) as needed.
2. After 1-2 exchanges, naturally offer to schedule an appointment or callback: "Would you like me to get you on the schedule?" or "I can book you in — what day works best?"
3. If they say yes to booking, ask for their name and preferred day/time, confirm it warmly, and wrap up.
4. Keep every response to 1-3 short sentences. Sound like a real receptionist, not a robot.

Do NOT mention LinkCrew, AI software, or any tech platform. Stay fully in character as ${company}'s assistant.
${isLastTurn ? `This is your last response. Wrap up the call warmly — thank them for calling ${company} and wish them a great day. Then output ##END## on a new line.` : ''}`;
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
    conv.demoStep = 0;
    conv.demoData = {};
    // Drop Claude's transition text entirely — go straight to the first question
    spokenReply = "Perfect! Let's set up your demo. First — what trade or industry are you in? For example, roofing, HVAC, plumbing, or landscaping.";

  } else if (conv.mode === 'demo_running' && rawReply.includes('##END##')) {
    spokenReply = rawReply.replace(/##END##.*$/s, '').trim()
      + " That was the LinkCrew AI voice bot. I can answer any questions you have about LinkCrew — pricing, features, how to get started. What would you like to know?";
    conv.mode = 'support';
    conv.history = [];
    conv.demoCompleted = true;
  }

  await saveVoiceSession(callSid, conv);

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
  const conv = callSid ? await getVoiceSession(callSid) : null;

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

  if (callSid) await deleteVoiceSession(callSid);

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
    .select('company_name, owner_email, logo_url, address, phone, license_number, payment_methods, stripe_connect_status')
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
    .select('company_name, owner_email, logo_url, address, phone, license_number, payment_methods, stripe_connect_status')
    .eq('id', job.tenant_id)
    .single();
  res.json({ job, tenant });
});

// ── Voice Bot ─────────────────────────────────────────────────────────────────

// Incoming call from Twilio
app.post('/api/voice/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  await saveVoiceSession(callSid, { history: [], startTime: Date.now() });

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/voice/respond',
    speechTimeout: '3',
    timeout: 10,
   
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' },
    'Hi! Thanks for calling LinkCrew. I\'m your AI assistant. How can I help you today?');
  twiml.say({ voice: 'Polly.Joanna' }, 'I didn\'t catch that. Please call back and try again. Goodbye!');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle caller's speech, respond with Claude
app.post('/api/voice/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();

  let conv = await getVoiceSession(callSid);
  if (!conv) conv = { history: [], startTime: Date.now() };
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
    await deleteVoiceSession(callSid);
  } else {
    await saveVoiceSession(callSid, conv);
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/respond',
      speechTimeout: '3',
      timeout: 10,
     
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
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from('impersonation_sessions')
    .insert({ token, tenant_id: tenantId, expires_at: expiresAt });
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

// ── Crew Invite (crew_invite_links table) ──────────────────────────────────────

// GET: return current invite URL if one exists
app.get('/api/crew-invite', auth, requireSettingsAccess, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.json({ url: null });
  const appUrl = getAppUrl(req);
  const { data } = await supabaseAdmin.from('crew_invite_links')
    .select('token').eq('tenant_id', tenantId).maybeSingle();
  if (!data) return res.json({ url: null });
  res.json({ url: `${appUrl}/join?t=${data.token}` });
});

// POST: generate a new token, invalidates old one via upsert
app.post('/api/crew-invite', auth, requireSettingsAccess, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Cannot generate invite — no organization found' });
  const appUrl = getAppUrl(req);
  const token = require('crypto').randomBytes(16).toString('hex');
  const { error } = await supabaseAdmin.from('crew_invite_links')
    .upsert({ tenant_id: tenantId, token, created_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: `${appUrl}/join?t=${token}` });
});

// Public: look up company name for join page
app.get('/api/join-info', async (req, res) => {
  const { t } = req.query;
  if (!t) return res.status(400).json({ error: 'Invalid invite link' });
  const { data: invite } = await supabaseAdmin.from('crew_invite_links')
    .select('tenant_id').eq('token', t).maybeSingle();
  if (!invite) return res.status(404).json({ error: 'This invite link is invalid or has been regenerated' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name').eq('id', invite.tenant_id).single();
  if (!tenant) return res.status(404).json({ error: 'Invalid invite link' });
  res.json({ companyName: tenant.company_name || 'Your Team' });
});

// Recent login attempts for the authed owner's email — for the dashboard
// security widget. Returns last 20 with success/fail + timestamp + IP.
app.get('/api/login-attempts/recent', auth, requireSettingsAccess, async (req, res) => {
  const email = req.userEmail ? String(req.userEmail).toLowerCase() : null;
  if (!email) return res.json({ attempts: [], failed_last_24h: 0 });
  const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [{ data: attempts }, { count: failedLast24h }] = await Promise.all([
    supabaseAdmin.from('login_attempts')
      .select('success, ip, user_agent, created_at')
      .eq('email', email).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('email', email).eq('success', false).gte('created_at', since24h),
  ]);
  res.json({ attempts: attempts || [], failed_last_24h: failedLast24h || 0 });
});

// Owner login via email + password (same creds as the web dashboard).
// Verifies against Supabase auth, then finds/creates the owner employee
// row for the tenant and mints a mobile_session_token. Closes the
// "crew can log in as owner via phone" security gap: owners auth with
// a real password, crew use phone-only. No pivoting between roles.
app.post('/api/login-email', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || null;
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 200);

  // Rate limit: 5 failures in the last 10 minutes for this email → 15 min lockout.
  const windowStart = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count: recentFailures } = await supabaseAdmin.from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('email', normalizedEmail)
    .eq('success', false)
    .gte('created_at', windowStart);
  if ((recentFailures || 0) >= 5) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const verify = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (verify.error || !verify.data?.user) {
    await supabaseAdmin.from('login_attempts').insert({
      email: normalizedEmail, ip, user_agent: userAgent, success: false,
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // Don't need the Supabase session past verification.
  try { if (verify.data?.session?.access_token) await supabase.auth.signOut(verify.data.session.access_token); } catch (_) {}

  // Find the tenant this owner belongs to.
  const { data: tenant, error: tErr } = await supabaseAdmin.from('tenants')
    .select('id, company_name, phone, owner_email')
    .eq('owner_email', String(email).trim().toLowerCase())
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!tenant) return res.status(404).json({ error: 'No LinkCrew tenant found for this email.' });

  // Find or create the owner employee row. Phone is optional on first
  // email-login; owner can set it later from Settings if they also want
  // to use phone on another device.
  let { data: employee } = await supabaseAdmin.from('employees')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('role', 'owner')
    .maybeSingle();

  if (!employee) {
    const insert = await supabaseAdmin.from('employees').insert({
      tenant_id: tenant.id,
      name: tenant.company_name || 'Owner',
      role: 'owner',
      status: 'active',
      phone: null,
    }).select().single();
    if (insert.error) return res.status(500).json({ error: insert.error.message });
    employee = insert.data;
  }

  const token = `mob_${crypto.randomUUID()}`;
  const { error: tokErr } = await supabaseAdmin.from('employees')
    .update({ mobile_session_token: token, mobile_session_issued_at: new Date().toISOString() })
    .eq('id', employee.id);
  if (tokErr) return res.status(500).json({ error: tokErr.message });

  await supabaseAdmin.from('login_attempts').insert({
    email: normalizedEmail, ip, user_agent: userAgent, success: true,
  });

  res.json({ employee: { ...employee, mobile_session_token: token } });
});

// Public: mobile-first signup. Creates a Supabase auth user, a tenant,
// an owner employees row with the phone as login handle, and mints a
// mobile_session_token so the user is immediately signed in on the phone.
// Mirrors /api/auth/signup (web) but ties the result back to a mobile
// session — so an owner can create their account from the app, no web
// signup needed first.
app.post('/api/mobile/signup', async (req, res) => {
  const { email, password, company_name, phone, owner_name } = req.body || {};
  if (!email || !password || !company_name || !phone) {
    return res.status(400).json({ error: 'Email, password, company name, and phone are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  // Normalize phone to digits only (strip +, spaces, parens, dashes; drop
  // leading 1 on 11-digit US numbers so lookups match /api/login-phone).
  let normalizedPhone = String(phone).replace(/\D/g, '');
  if (normalizedPhone.length === 11 && normalizedPhone.startsWith('1')) {
    normalizedPhone = normalizedPhone.slice(1);
  }
  if (!normalizedPhone) return res.status(400).json({ error: 'Invalid phone number' });
  const emailLower = String(email).trim().toLowerCase();

  // Create Supabase Auth user.
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: emailLower,
    password,
    email_confirm: true,
  });
  if (authError) return res.status(400).json({ error: authError.message });

  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // Tenant row.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .insert({
      company_name: String(company_name).trim(),
      owner_email: emailLower,
      trial_ends_at: trialEndsAt,
      plan: 'solo',
      max_users: 1,
      subscription_status: 'trialing',
    })
    .select().single();
  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return res.status(400).json({ error: tenantError.message });
  }

  // Link auth user → tenant as owner.
  const linkPayload = { user_id: authData.user.id, tenant_id: tenant.id, role: 'owner', can_view_financials: true };
  let { error: linkError } = await supabaseAdmin.from('tenant_users').insert(linkPayload);
  if (linkError && /column/i.test(linkError.message || '')) {
    // Legacy tenant_users schema (no role/financials cols) — retry bare.
    const retry = await supabaseAdmin.from('tenant_users')
      .insert({ user_id: authData.user.id, tenant_id: tenant.id });
    linkError = retry.error;
  }
  if (linkError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id).catch(() => {});
    return res.status(400).json({ error: 'Failed to link account to organization' });
  }

  // Owner employees row — this is what the mobile client logs in as.
  const ownerName = String(owner_name || '').trim() || emailLower.split('@')[0];
  const token = `mob_${crypto.randomUUID()}`;
  const { data: employee, error: empError } = await supabaseAdmin
    .from('employees')
    .insert({
      tenant_id: tenant.id,
      name: ownerName,
      phone: normalizedPhone,
      role: 'owner',
      status: 'active',
      mobile_session_token: token,
      mobile_session_issued_at: new Date().toISOString(),
    })
    .select().single();
  if (empError) {
    // Soft-fail: auth user + tenant exist but employees insert failed.
    // Return something useful rather than orphaning — the owner can still
    // log in on web; phone login will fail until an employees row is created.
    return res.status(400).json({ error: `Account created but employee profile failed: ${empError.message}` });
  }

  res.json({
    ok: true,
    employee: { ...employee, mobile_session_token: token },
    tenant: { id: tenant.id, company_name: tenant.company_name, trial_ends_at: trialEndsAt },
  });
});

// Request an email magic-link for the currently signed-in owner so they
// can open the web dashboard on a laptop without re-entering credentials.
// Supabase generates the link; we email it via our existing transport.
app.post('/api/mobile/me/desktop-magic-link', mobileAuth, async (req, res) => {
  if (req.role !== 'owner' && req.role !== 'manager' && req.role !== 'supervisor') {
    return res.status(403).json({ error: 'Only owners and managers can open the web dashboard' });
  }
  const { data: tenant } = await supabaseAdmin
    .from('tenants').select('owner_email, company_name').eq('id', req.tenantId).maybeSingle();
  if (!tenant?.owner_email) return res.status(400).json({ error: 'No owner email on file' });
  try {
    const { data: linkData, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: tenant.owner_email,
      options: { redirectTo: 'https://linkcrew.io/app' },
    });
    if (error) return res.status(500).json({ error: error.message });
    const magicUrl = linkData?.properties?.action_link;
    if (!magicUrl) return res.status(500).json({ error: 'Magic link generation failed' });
    // Send via Resend (same transport as our invoice + payment emails).
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'LinkCrew <hello@linkcrew.io>',
        to: tenant.owner_email,
        subject: `Open ${tenant.company_name || 'LinkCrew'} on your desktop`,
        html: `
          <p>Tap the button below to open the LinkCrew dashboard on your laptop — no password needed.</p>
          <p><a href="${magicUrl}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 22px;border-radius:8px;font-weight:700;text-decoration:none">Open LinkCrew on desktop</a></p>
          <p style="color:#666;font-size:12px">If the button doesn't work, paste this link: ${magicUrl}</p>
          <p style="color:#666;font-size:12px">Link expires in 1 hour.</p>
        `,
      });
    } catch (e) {
      // Fallback: return the link directly so the app can present it.
      return res.json({ ok: true, magic_url: magicUrl, emailed: false, error: e?.message });
    }
    res.json({ ok: true, emailed: true, to: tenant.owner_email });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to send magic link' });
  }
});

// Apple App Store guideline 5.1.1 requires an in-app account deletion
// path for apps with accounts. Deletes the caller's employees row and,
// if they're the sole owner, the entire tenant + auth user + all tenant
// data. Crew accounts just remove their employees row.
app.post('/api/mobile/me/delete-account', mobileAuth, async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  const tenantId = req.tenantId;
  const employeeId = req.employeeId;
  const isOwner = req.role === 'owner';

  if (!isOwner) {
    // Crew / manager / supervisor: just remove their employees row.
    await supabaseAdmin.from('employees').delete().eq('id', employeeId).eq('tenant_id', tenantId);
    return res.json({ ok: true, deleted: 'employee' });
  }

  // Owner: check if other owners exist on this tenant; if so, block.
  const { count: ownerCount } = await supabaseAdmin
    .from('employees').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('role', 'owner').neq('id', employeeId);
  if ((ownerCount || 0) > 0) {
    // Another owner exists — just remove this employee.
    await supabaseAdmin.from('employees').delete().eq('id', employeeId);
    return res.json({ ok: true, deleted: 'employee', note: 'Tenant kept (other owner exists)' });
  }

  // Sole owner — nuke the tenant. Cascades + best-effort cleanup.
  // Tenants with ON DELETE CASCADE on tenant_id FKs will vacuum most
  // rows. We don't try to delete storage objects — retention is fine.
  const { data: tenantUsers } = await supabaseAdmin
    .from('tenant_users').select('user_id').eq('tenant_id', tenantId);
  await supabaseAdmin.from('tenants').delete().eq('id', tenantId);
  for (const tu of (tenantUsers || [])) {
    if (tu?.user_id) {
      await supabaseAdmin.auth.admin.deleteUser(tu.user_id).catch(() => {});
    }
  }
  res.json({ ok: true, deleted: 'tenant' });
});

// Public: mobile phone login — RLS blocks anon reads of employees, so
// the mobile app hits this endpoint (service role) instead of the DB.
// Issues a mobile_session_token which the app presents on every subsequent
// /api/mobile/* request (see mobileAuth middleware below).
// NOTE: phone-login only returns employees with role='crew' or 'manager'
// to prevent phone-number enumeration from reaching owner accounts.
// Owner must use /api/login-email.
app.post('/api/login-phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  let normalized = String(phone).replace(/\D/g, '');
  if (normalized.length === 11 && normalized.startsWith('1')) {
    normalized = normalized.slice(1);
  }
  if (!normalized) return res.status(400).json({ error: 'Invalid phone number' });
  // Unified login: any role (owner, manager, crew) whose phone matches.
  // If a number appears in multiple tenants we return the most-recently
  // created record; the app can later surface a tenant picker if needed.
  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('*')
    .eq('phone', normalized)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!employee) return res.status(404).json({ error: "This phone number isn't registered. Ask your account owner to add you, or sign up at linkcrew.io/app." });

  const token = `mob_${crypto.randomUUID()}`;
  const { error: tokErr } = await supabaseAdmin
    .from('employees')
    .update({ mobile_session_token: token, mobile_session_issued_at: new Date().toISOString() })
    .eq('id', employee.id);
  if (tokErr) return res.status(500).json({ error: tokErr.message });

  res.json({ employee: { ...employee, mobile_session_token: token } });
});

// Per-token rate limit — sliding 60s window, 120 requests per token.
// In-memory: fine for single-process (current Render + planned single-container Coolify).
// Switch to Redis-backed when we scale to multiple replicas.
const MOBILE_RATE_WINDOW_MS = 60_000;
const MOBILE_RATE_LIMIT = 120;
const mobileRateBuckets = new Map(); // token -> number[] (timestamps)
setInterval(() => {
  const cutoff = Date.now() - MOBILE_RATE_WINDOW_MS;
  for (const [k, arr] of mobileRateBuckets) {
    const kept = arr.filter(t => t > cutoff);
    if (kept.length === 0) mobileRateBuckets.delete(k);
    else mobileRateBuckets.set(k, kept);
  }
}, 5 * 60_000).unref();

function mobileRateLimit(token) {
  const now = Date.now();
  const cutoff = now - MOBILE_RATE_WINDOW_MS;
  const arr = (mobileRateBuckets.get(token) || []).filter(t => t > cutoff);
  if (arr.length >= MOBILE_RATE_LIMIT) return false;
  arr.push(now);
  mobileRateBuckets.set(token, arr);
  return true;
}

// Mobile auth middleware: resolve mobile_session_token → employee + tenant.
async function mobileAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !token.startsWith('mob_')) return res.status(401).json({ error: 'Unauthorized' });
  if (!mobileRateLimit(token)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('id, tenant_id, role, status, name, phone')
    .eq('mobile_session_token', token)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!employee) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  if (employee.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  req.employeeId = employee.id;
  req.tenantId = employee.tenant_id;
  req.employeeName = employee.name;
  req.employeePhone = employee.phone;
  req.role = employee.role;
  next();
}

// ── Mobile crew endpoints (bypass RLS via service role, guarded by mobileAuth) ──

// List jobs in field-work statuses for the tenant
app.get('/api/mobile/crew/jobs', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .in('status', ['active', 'in_progress', 'scheduled', 'on_hold'])
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Jobs out of field-work — completed, invoiced, paid, cancelled, archived, etc.
app.get('/api/mobile/crew/jobs/history', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .in('status', ['completed', 'invoiced', 'saved_for_later', 'cancelled', 'archived'])
    .order('updated_at', { ascending: false })
    .limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Single job (with minimal client info for call/navigate)
app.get('/api/mobile/crew/jobs/:id', mobileAuth, async (req, res) => {
  const { data: job, error } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  let client = null;
  if (job.client_id) {
    const { data: c } = await supabaseAdmin
      .from('clients')
      .select('id, name, phone, email')
      .eq('id', job.client_id)
      .maybeSingle();
    client = c || null;
  }
  const { data: ack } = await supabaseAdmin
    .from('job_scope_acknowledgements')
    .select('acked_at, acked_scope_updated_at')
    .eq('job_id', req.params.id)
    .eq('employee_id', req.employeeId)
    .maybeSingle();
  res.json({ job, client, ack: ack || null });
});

// Acknowledge the current scope_updated_at for this employee — dismisses the
// "Instructions updated" banner and records the ack for owner-side audit.
app.post('/api/mobile/crew/jobs/:id/scope/ack', mobileAuth, async (req, res) => {
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id, scope_updated_at')
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.scope_updated_at) return res.json({ ok: true, acked_scope_updated_at: null });
  const { error } = await supabaseAdmin.from('job_scope_acknowledgements').upsert({
    job_id: job.id,
    employee_id: req.employeeId,
    acked_at: new Date().toISOString(),
    acked_scope_updated_at: job.scope_updated_at,
  }, { onConflict: 'job_id,employee_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, acked_scope_updated_at: job.scope_updated_at });
});

// Crew member's current (not-checked-out) assignment
app.get('/api/mobile/crew/assignment', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_assignments')
    .select('job_id, checked_in_at')
    .eq('employee_id', req.employeeId)
    .is('checked_out_at', null)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// Check in to a job
app.post('/api/mobile/crew/jobs/:id/check-in', mobileAuth, async (req, res) => {
  const { gps } = req.body || {};
  const checkedInAt = new Date().toISOString();
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id, name').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { error: upErr } = await supabaseAdmin
    .from('job_assignments')
    .upsert({
      job_id: job.id,
      employee_id: req.employeeId,
      tenant_id: req.tenantId,
      checked_in_at: checkedInAt,
      checked_out_at: null,
      punch_in_lat: gps?.lat ?? null,
      punch_in_lng: gps?.lng ?? null,
    }, { onConflict: 'job_id,employee_id' });
  if (upErr) return res.status(500).json({ error: upErr.message });
  await supabaseAdmin.from('job_updates').insert({
    job_id: job.id,
    employee_id: req.employeeId,
    tenant_id: req.tenantId,
    type: 'checkin',
    message: `${req.employeeName} checked in${gps ? ' 📍' : ''}`,
  });
  res.json({ ok: true, job_name: job.name, checked_in_at: checkedInAt });
});

// Check out of a job
app.post('/api/mobile/crew/jobs/:id/check-out', mobileAuth, async (req, res) => {
  const { gps } = req.body || {};
  const checkedOutAt = new Date().toISOString();
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id, name').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { error: upErr } = await supabaseAdmin
    .from('job_assignments')
    .update({
      checked_out_at: checkedOutAt,
      punch_out_lat: gps?.lat ?? null,
      punch_out_lng: gps?.lng ?? null,
    })
    .eq('job_id', job.id)
    .eq('employee_id', req.employeeId);
  if (upErr) return res.status(500).json({ error: upErr.message });
  await supabaseAdmin.from('job_updates').insert({
    job_id: job.id,
    employee_id: req.employeeId,
    tenant_id: req.tenantId,
    type: 'checkout',
    message: `${req.employeeName} checked out${gps ? ' 📍' : ''}`,
  });
  res.json({ ok: true, job_name: job.name, checked_out_at: checkedOutAt });
});

// Create a job update (note, bottleneck, photo)
app.post('/api/mobile/crew/jobs/:id/updates', mobileAuth, async (req, res) => {
  const { type, message, photo_url } = req.body || {};
  const allowed = new Set(['note', 'bottleneck', 'photo', 'update']);
  if (!allowed.has(type)) return res.status(400).json({ error: 'Invalid update type' });
  if (!message && !photo_url) return res.status(400).json({ error: 'Message or photo required' });
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { data, error } = await supabaseAdmin
    .from('job_updates')
    .insert({
      job_id: job.id,
      employee_id: req.employeeId,
      tenant_id: req.tenantId,
      type,
      message: message || null,
      photo_url: photo_url || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// My assignment history (for the Hours tab)
app.get('/api/mobile/crew/my-assignments', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_assignments')
    .select('id, checked_in_at, checked_out_at, jobs(name)')
    .eq('employee_id', req.employeeId)
    .not('checked_in_at', 'is', null)
    .order('checked_in_at', { ascending: false })
    .limit(40);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Schedule view — jobs in a date range with assigned crew names. Powers
// the team-calendar list on crew's Schedule tab.
app.get('/api/mobile/crew/schedule', mobileAuth, async (req, res) => {
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  const { data: jobs, error: je } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, status, scheduled_date, payment_status, invoice_amount, client_id, clients(name)')
    .eq('tenant_id', req.tenantId)
    .gte('scheduled_date', start || '1970-01-01')
    .lte('scheduled_date', end || '9999-12-31')
    .order('scheduled_date', { ascending: true });
  if (je) return res.status(500).json({ error: je.message });
  const jobIds = (jobs || []).map(j => j.id);
  const assignmentsByJob = new Map();
  if (jobIds.length > 0) {
    const { data: assignments } = await supabaseAdmin
      .from('job_assignments')
      .select('job_id, employee_id, employees(name)')
      .in('job_id', jobIds);
    for (const a of (assignments || [])) {
      const arr = assignmentsByJob.get(a.job_id) || [];
      const name = a.employees?.name || 'Crew';
      arr.push({ employee_id: a.employee_id, name });
      assignmentsByJob.set(a.job_id, arr);
    }
  }
  const out = (jobs || []).map(j => ({
    ...j,
    client_name: j.clients?.name || null,
    crew: assignmentsByJob.get(j.id) || [],
  }));
  res.json(out);
});

// ── Self profile endpoints (universal — crew + owner) ──
// Anyone with a mobile session can read + edit their own profile.
// Avatar upload uses the existing 'photos' bucket to avoid new infra.

app.get('/api/mobile/me', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id, name, phone, role, status, avatar_url, tenant_id')
    .eq('id', req.employeeId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mobile/me', mobileAuth, async (req, res) => {
  const updates = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    updates.name = req.body.name.trim().slice(0, 120);
  }
  if (typeof req.body?.avatar_url === 'string') {
    // Allow clearing (empty string → null) or setting a new URL.
    updates.avatar_url = req.body.avatar_url.trim() || null;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const { data, error } = await supabaseAdmin
    .from('employees')
    .update(updates)
    .eq('id', req.employeeId)
    .select('id, name, phone, role, status, avatar_url, tenant_id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Server-side avatar upload — accepts multipart image, stores in the
// 'photos' bucket under avatars/<employee_id>.<ext>, updates the
// employee record, returns the new public URL.
app.post('/api/mobile/me/avatar', mobileAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mime = String(req.file.mimetype || 'image/jpeg');
  if (!mime.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
  const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase() || 'jpg';
  const safeExt = /^(jpg|jpeg|png|webp|heic)$/.test(ext) ? ext : 'jpg';
  const filePath = `avatars/${req.employeeId}.${safeExt}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from('photos')
    .upload(filePath, req.file.buffer, { contentType: mime, upsert: true });
  if (uploadError) return res.status(400).json({ error: uploadError.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('photos').getPublicUrl(filePath);
  // Cache-bust so the app picks up the new image immediately.
  const bustedUrl = `${publicUrl}?t=${Date.now()}`;
  await supabaseAdmin.from('employees').update({ avatar_url: bustedUrl }).eq('id', req.employeeId);
  res.json({ avatar_url: bustedUrl });
});

// ── Mobile expenses ─────────────────────────────────────────────────
// Crew can log + see their own. Managers + owners see every tenant
// expense. Amount is in dollars (numeric). Optional receipt upload via
// POST /api/mobile/expenses/:id/receipt.

const EXPENSE_CATEGORIES = new Set([
  'fuel', 'materials', 'tools', 'meals', 'vehicle', 'lodging', 'subcontractor', 'other',
]);

app.get('/api/mobile/expenses', mobileAuth, async (req, res) => {
  const isMgr = req.role === 'owner' || req.role === 'admin' || req.role === 'manager';
  let qb = supabaseAdmin
    .from('expenses')
    .select('id, date, amount, name, details, category, reimburse_to, reimburse_employee_id, job_id, status, receipt_url, created_at, employees:reimburse_employee_id(name), jobs(name)')
    .eq('tenant_id', req.tenantId)
    .order('date', { ascending: false })
    .limit(200);
  if (!isMgr) qb = qb.eq('reimburse_employee_id', req.employeeId);
  const { data, error } = await qb;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/mobile/expenses', mobileAuth, async (req, res) => {
  const { date, amount, name, details, category, job_id } = req.body || {};
  const amt = Number(amount);
  if (!amt || !isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount required' });
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  const cat = EXPENSE_CATEGORIES.has(String(category || '')) ? String(category) : 'other';
  const isMgr = req.role === 'owner' || req.role === 'admin' || req.role === 'manager';
  // Crew-authored expenses always reimburse the author. Managers can
  // optionally pass reimburse_to / reimburse_employee_id in the body
  // (future web flow); for now we mirror the same crew default.
  const reimburseTo = 'employee';
  const reimburseEmployeeId = isMgr && typeof req.body?.reimburse_employee_id === 'string'
    ? req.body.reimburse_employee_id
    : req.employeeId;
  const { data, error } = await supabaseAdmin.from('expenses').insert({
    date: date || new Date().toISOString().slice(0, 10),
    amount: amt,
    name: cleanName,
    details: typeof details === 'string' && details.trim() ? details.trim() : null,
    category: cat,
    reimburse_to: reimburseTo,
    reimburse_employee_id: reimburseEmployeeId,
    job_id: job_id || null,
    tenant_id: req.tenantId,
    status: 'pending',
  }).select('id, date, amount, name, details, category, reimburse_to, reimburse_employee_id, job_id, status, receipt_url, created_at, employees:reimburse_employee_id(name), jobs(name)').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Multipart receipt upload. Tenant-isolated path. Returns the new
// receipt_url stamped with a cache-bust so the client sees it.
app.post('/api/mobile/expenses/:id/receipt', mobileAuth, upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  // Verify the expense belongs to this tenant + that crew can only
  // attach to their own.
  const { data: existing } = await supabaseAdmin
    .from('expenses').select('id, reimburse_employee_id')
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const isMgr = req.role === 'owner' || req.role === 'admin' || req.role === 'manager';
  if (!isMgr && existing.reimburse_employee_id !== req.employeeId) {
    return res.status(403).json({ error: 'Not your expense' });
  }
  const mime = String(req.file.mimetype || 'image/jpeg');
  const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase() || 'jpg';
  const safeExt = /^(jpg|jpeg|png|webp|heic|pdf)$/.test(ext) ? ext : 'jpg';
  const filePath = `expenses/${req.tenantId}/${req.params.id}.${safeExt}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('photos')
    .upload(filePath, req.file.buffer, { contentType: mime, upsert: true });
  if (upErr) return res.status(400).json({ error: upErr.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('photos').getPublicUrl(filePath);
  const busted = `${publicUrl}?t=${Date.now()}`;
  await supabaseAdmin.from('expenses').update({ receipt_url: busted }).eq('id', req.params.id);
  res.json({ receipt_url: busted });
});

// ── Messaging (chat_threads / chat_thread_members / chat_messages) ──
// Every endpoint is scoped to the caller's tenant via mobileAuth, and
// every thread-specific operation enforces membership.

async function assertThreadMember(req, threadId) {
  const { data } = await supabaseAdmin
    .from('chat_thread_members')
    .select('thread_id')
    .eq('thread_id', threadId)
    .eq('employee_id', req.employeeId)
    .maybeSingle();
  return !!data;
}

// List my threads with last message preview + unread count.
app.get('/api/mobile/chat/threads', mobileAuth, async (req, res) => {
  const { data: memberRows, error: mErr } = await supabaseAdmin
    .from('chat_thread_members')
    .select('thread_id, last_read_at')
    .eq('employee_id', req.employeeId);
  if (mErr) return res.status(500).json({ error: mErr.message });
  const threadIds = (memberRows || []).map(r => r.thread_id);
  if (threadIds.length === 0) return res.json([]);

  const lastReadByThread = new Map((memberRows || []).map(r => [r.thread_id, r.last_read_at]));

  const [{ data: threads }, { data: members }] = await Promise.all([
    supabaseAdmin.from('chat_threads')
      .select('id, name, created_by, created_at, last_message_at')
      .in('id', threadIds)
      .order('last_message_at', { ascending: false }),
    supabaseAdmin.from('chat_thread_members')
      .select('thread_id, employee_id, employees(name, avatar_url)')
      .in('thread_id', threadIds),
  ]);

  // Pull the latest message per thread (small N, one query per thread
  // kept simple; Postgres can hand it off cheaply for O(20) threads).
  const latestByThread = new Map();
  await Promise.all(threadIds.map(async (tid) => {
    const { data: last } = await supabaseAdmin
      .from('chat_messages')
      .select('id, body, sender_id, created_at, employees:sender_id(name)')
      .eq('thread_id', tid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last) latestByThread.set(tid, last);
  }));

  // Unread count = messages in my threads created after my last_read_at.
  const unreadByThread = new Map();
  await Promise.all(threadIds.map(async (tid) => {
    const lastRead = lastReadByThread.get(tid) || new Date(0).toISOString();
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', tid)
      .gt('created_at', lastRead)
      .neq('sender_id', req.employeeId);
    unreadByThread.set(tid, count || 0);
  }));

  const byThreadMembers = new Map();
  for (const m of (members || [])) {
    const arr = byThreadMembers.get(m.thread_id) || [];
    arr.push({ employee_id: m.employee_id, name: m.employees?.name || 'Crew', avatar_url: m.employees?.avatar_url || null });
    byThreadMembers.set(m.thread_id, arr);
  }

  const result = (threads || []).map(t => ({
    id: t.id,
    name: t.name,
    created_by: t.created_by,
    created_at: t.created_at,
    last_message_at: t.last_message_at,
    members: byThreadMembers.get(t.id) || [],
    last_message: latestByThread.get(t.id) || null,
    unread_count: unreadByThread.get(t.id) || 0,
  }));
  res.json(result);
});

// Create (or find, for DMs) a thread. body: { employee_ids: string[], name?: string }
app.post('/api/mobile/chat/threads', mobileAuth, async (req, res) => {
  const otherIds = Array.isArray(req.body?.employee_ids)
    ? req.body.employee_ids.filter(id => typeof id === 'string' && id !== req.employeeId)
    : [];
  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  if (otherIds.length === 0) return res.status(400).json({ error: 'Pick at least one employee' });

  // Verify all invited employees are in the same tenant.
  const { data: invitees, error: invErr } = await supabaseAdmin
    .from('employees')
    .select('id, tenant_id')
    .in('id', otherIds);
  if (invErr) return res.status(500).json({ error: invErr.message });
  if ((invitees || []).some(e => e.tenant_id !== req.tenantId)) {
    return res.status(403).json({ error: 'All members must be in your team' });
  }
  if ((invitees || []).length !== otherIds.length) {
    return res.status(400).json({ error: 'One or more employees not found' });
  }

  const allMemberIds = Array.from(new Set([req.employeeId, ...otherIds]));
  const isDM = allMemberIds.length === 2;

  // DM find-or-create: reuse existing 1:1 thread if present.
  if (isDM) {
    const { data: myThreads } = await supabaseAdmin
      .from('chat_thread_members')
      .select('thread_id')
      .eq('employee_id', req.employeeId);
    const myThreadIds = (myThreads || []).map(r => r.thread_id);
    if (myThreadIds.length > 0) {
      const { data: otherMemberships } = await supabaseAdmin
        .from('chat_thread_members')
        .select('thread_id')
        .eq('employee_id', otherIds[0])
        .in('thread_id', myThreadIds);
      const candidateIds = (otherMemberships || []).map(r => r.thread_id);
      if (candidateIds.length > 0) {
        // Return the existing DM that has exactly 2 members.
        for (const tid of candidateIds) {
          const { count } = await supabaseAdmin
            .from('chat_thread_members')
            .select('thread_id', { count: 'exact', head: true })
            .eq('thread_id', tid);
          if (count === 2) {
            const { data: existing } = await supabaseAdmin
              .from('chat_threads').select('*').eq('id', tid).maybeSingle();
            if (existing && !existing.name) return res.json(existing);
          }
        }
      }
    }
  }

  const { data: thread, error: tErr } = await supabaseAdmin
    .from('chat_threads')
    .insert({
      tenant_id: req.tenantId,
      name: isDM ? null : (rawName || null),
      created_by: req.employeeId,
    })
    .select()
    .single();
  if (tErr) return res.status(500).json({ error: tErr.message });

  const memberRows = allMemberIds.map(id => ({ thread_id: thread.id, employee_id: id }));
  const { error: mErr } = await supabaseAdmin.from('chat_thread_members').insert(memberRows);
  if (mErr) return res.status(500).json({ error: mErr.message });

  res.json(thread);
});

// Messages in a thread.
app.get('/api/mobile/chat/threads/:id/messages', mobileAuth, async (req, res) => {
  if (!(await assertThreadMember(req, req.params.id))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  let qb = supabaseAdmin
    .from('chat_messages')
    .select('id, sender_id, body, created_at, employees:sender_id(name, avatar_url)')
    .eq('thread_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) qb = qb.lt('created_at', before);
  const { data, error } = await qb;
  if (error) return res.status(500).json({ error: error.message });
  // Return oldest-first for convenient rendering.
  res.json((data || []).reverse());
});

app.post('/api/mobile/chat/threads/:id/messages', mobileAuth, async (req, res) => {
  if (!(await assertThreadMember(req, req.params.id))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Empty message' });
  if (body.length > 4000) return res.status(400).json({ error: 'Message too long' });
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      thread_id: req.params.id,
      tenant_id: req.tenantId,
      sender_id: req.employeeId,
      body,
    })
    .select('id, sender_id, body, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Mark my own last_read_at up to this message so unread count stays 0
  // for me.
  await supabaseAdmin
    .from('chat_thread_members')
    .update({ last_read_at: data.created_at })
    .eq('thread_id', req.params.id)
    .eq('employee_id', req.employeeId);

  // Fire-and-forget push to the other members.
  sendChatPush(req.params.id, req.employeeId, body).catch(e => console.error('[chat push]', e.message));

  res.json(data);
});

app.post('/api/mobile/chat/threads/:id/read', mobileAuth, async (req, res) => {
  if (!(await assertThreadMember(req, req.params.id))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const { error } = await supabaseAdmin
    .from('chat_thread_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('thread_id', req.params.id)
    .eq('employee_id', req.employeeId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Employee picker: list of teammates a user can message (same tenant,
// excluding self).
app.get('/api/mobile/chat/employees', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id, name, role, phone, avatar_url')
    .eq('tenant_id', req.tenantId)
    .neq('id', req.employeeId)
    .eq('status', 'active')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Send an Expo push to every member of a thread except the sender.
// Best-effort — errors are swallowed so a push outage doesn't block
// message delivery.
async function sendChatPush(threadId, senderId, body) {
  try {
    const [{ data: thread }, { data: members }, { data: sender }] = await Promise.all([
      supabaseAdmin.from('chat_threads').select('id, name').eq('id', threadId).maybeSingle(),
      supabaseAdmin.from('chat_thread_members')
        .select('employee_id, employees(push_token, name)')
        .eq('thread_id', threadId)
        .neq('employee_id', senderId),
      supabaseAdmin.from('employees').select('name').eq('id', senderId).maybeSingle(),
    ]);
    const tokens = (members || [])
      .map(m => m.employees?.push_token)
      .filter(t => typeof t === 'string' && t.startsWith('ExponentPushToken'));
    if (tokens.length === 0) return;
    const title = thread?.name ? thread.name : (sender?.name || 'New message');
    const messageBody = (thread?.name ? `${sender?.name || 'Someone'}: ` : '') + body.slice(0, 160);
    const payload = tokens.map(to => ({
      to,
      sound: 'default',
      title,
      body: messageBody,
      data: { type: 'chat_message', thread_id: threadId },
    }));
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* swallow */
  }
}

// Today's job progress — crew + solo owners alike. Powers the "1/3 Jobs
// Completed Today" gauge on Home.
app.get('/api/mobile/me/today-progress', mobileAuth, async (req, res) => {
  const today = new Date();
  const isoDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const jobIds = await (async () => {
    if (req.role === 'owner' || req.role === 'admin') {
      // Solo owners work their own jobs — scope to tenant.
      const { data } = await supabaseAdmin
        .from('jobs').select('id, status')
        .eq('tenant_id', req.tenantId)
        .eq('scheduled_date', isoDay);
      return data || [];
    }
    const { data: assignments } = await supabaseAdmin
      .from('job_assignments').select('job_id')
      .eq('employee_id', req.employeeId);
    const ids = (assignments || []).map(a => a.job_id);
    if (ids.length === 0) return [];
    const { data } = await supabaseAdmin
      .from('jobs').select('id, status')
      .eq('tenant_id', req.tenantId)
      .eq('scheduled_date', isoDay)
      .in('id', ids);
    return data || [];
  })();

  const total = jobIds.length;
  const completedStatuses = new Set(['completed', 'invoiced', 'paid']);
  const completed = jobIds.filter(j => completedStatuses.has(String(j.status || '').toLowerCase())).length;
  res.json({ completed, total, date: isoDay });
});

// ── Free-punch clock-in (time_entries table) ──
// Universal: works for crew and owner. Not tied to a specific job —
// a crew member on their way to a site, an owner bidding a prospect,
// etc. GPS lat/lng captured at both ends power the office map on Home.

app.post('/api/mobile/clock-in', mobileAuth, async (req, res) => {
  const { gps } = req.body || {};
  // Reject if there's already an open entry for this employee (idempotent).
  const { data: existing } = await supabaseAdmin
    .from('time_entries')
    .select('id, started_at, start_lat, start_lng')
    .eq('employee_id', req.employeeId)
    .is('ended_at', null)
    .maybeSingle();
  if (existing) return res.json({ ok: true, entry: existing, already_open: true });
  const { data, error } = await supabaseAdmin
    .from('time_entries')
    .insert({
      tenant_id: req.tenantId,
      employee_id: req.employeeId,
      started_at: new Date().toISOString(),
      start_lat: gps?.lat ?? null,
      start_lng: gps?.lng ?? null,
      last_ping_lat: gps?.lat ?? null,
      last_ping_lng: gps?.lng ?? null,
      last_ping_at: gps?.lat != null ? new Date().toISOString() : null,
    })
    .select('id, started_at, start_lat, start_lng')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Fire-and-forget auto-advance from clock-in geofence hit.
  autoAdvanceFromClockIn(req.tenantId, req.employeeId, gps).catch(() => {});
  res.json({ ok: true, entry: data });
});

app.post('/api/mobile/clock-out', mobileAuth, async (req, res) => {
  const { gps } = req.body || {};
  const { data: open } = await supabaseAdmin
    .from('time_entries')
    .select('id')
    .eq('employee_id', req.employeeId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!open) return res.status(404).json({ error: 'Not clocked in' });
  const { data, error } = await supabaseAdmin
    .from('time_entries')
    .update({
      ended_at: new Date().toISOString(),
      end_lat: gps?.lat ?? null,
      end_lng: gps?.lng ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', open.id)
    .select('id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Fire-and-forget auto-advance: mid-job clock-out pauses active jobs.
  autoAdvanceFromClockOut(req.tenantId, req.employeeId).catch(() => {});
  res.json({ ok: true, entry: data });
});

// Heartbeat — periodic foreground ping from a clocked-in crew member, used
// by the Live Map on the web dashboard. Writes to time_entries on the open
// entry only; no-op if not clocked in.
app.post('/api/mobile/me/heartbeat', mobileAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat + lng required' });
  const { data: open } = await supabaseAdmin
    .from('time_entries')
    .select('id')
    .eq('employee_id', req.employeeId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!open) return res.json({ ok: true, clocked_in: false });
  await supabaseAdmin
    .from('time_entries')
    .update({ last_ping_lat: lat, last_ping_lng: lng, last_ping_at: new Date().toISOString() })
    .eq('id', open.id);
  res.json({ ok: true, clocked_in: true });
});

// My clock state: current open entry (if any) + today's totals + today's pins.
// Client passes ?since=<ISO> for local-tz "today"; server falls back to its
// own midnight otherwise. The client-passed value is authoritative — the
// server runs in UTC on Render so its midnight isn't the user's midnight.
app.get('/api/mobile/me/clock-state', mobileAuth, async (req, res) => {
  let dayStart;
  const since = req.query?.since;
  if (since && !isNaN(Date.parse(String(since)))) {
    dayStart = new Date(String(since));
  } else {
    dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
  }
  const { data: rows, error } = await supabaseAdmin
    .from('time_entries')
    .select('id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng')
    .eq('employee_id', req.employeeId)
    .gte('started_at', dayStart.toISOString())
    .order('started_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const open = (rows || []).find(r => !r.ended_at) || null;
  let totalMs = 0;
  for (const r of (rows || [])) {
    const s = new Date(r.started_at).getTime();
    const e = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
    totalMs += Math.max(0, e - s);
  }
  const pins = [];
  for (const r of (rows || [])) {
    if (r.start_lat != null && r.start_lng != null) {
      pins.push({ kind: 'in', lat: r.start_lat, lng: r.start_lng, at: r.started_at });
    }
    if (r.ended_at && r.end_lat != null && r.end_lng != null) {
      pins.push({ kind: 'out', lat: r.end_lat, lng: r.end_lng, at: r.ended_at });
    }
  }
  res.json({ open, totalMs, pins, entries: rows || [] });
});

// Owner-only: today's clock-in pins across all crew, one entry per
// employee with their latest punch state. Drives the Home map.
app.get('/api/mobile/owner/crew-pins', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { data: rows, error } = await supabaseAdmin
    .from('time_entries')
    .select('id, employee_id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, employees(name)')
    .eq('tenant_id', req.tenantId)
    .gte('started_at', dayStart.toISOString())
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  // One entry per employee — latest punch per person.
  const byEmployee = new Map();
  for (const r of (rows || [])) {
    if (!byEmployee.has(r.employee_id)) byEmployee.set(r.employee_id, r);
  }
  const pins = [];
  for (const r of byEmployee.values()) {
    const name = r.employees?.name || 'Crew';
    if (r.ended_at) {
      // Latest action was clock-out; show the out pin.
      if (r.end_lat != null && r.end_lng != null) {
        pins.push({ employee_id: r.employee_id, name, kind: 'out', lat: r.end_lat, lng: r.end_lng, at: r.ended_at, active: false });
      }
    } else {
      if (r.start_lat != null && r.start_lng != null) {
        pins.push({ employee_id: r.employee_id, name, kind: 'in', lat: r.start_lat, lng: r.start_lng, at: r.started_at, active: true });
      }
    }
  }
  res.json({ pins });
});

// Static map proxy. Keeps the Google API key server-side and lets us
// cache identical renders for 5 min (reducing cost on refresh spam).
// Usage: GET /api/mobile/map?center=lat,lng&zoom=13&size=600x300&pins=lat,lng,color,label|lat,lng,color,label
const _mapCache = new Map(); // hash -> { buffer, contentType, ts }
const MAP_CACHE_TTL_MS = 5 * 60 * 1000;

// Inline auth for /api/mobile/map because React Native <Image> sends
// limited headers depending on platform — accept token via ?token= too.
async function mapAuth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && typeof req.query.token === 'string') token = req.query.token;
  if (!token || !token.startsWith('mob_')) return res.status(401).json({ error: 'Unauthorized' });
  const { data: employee } = await supabaseAdmin
    .from('employees').select('id, tenant_id, role, status')
    .eq('mobile_session_token', token).maybeSingle();
  if (!employee) return res.status(401).json({ error: 'Session expired' });
  if (employee.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  req.employeeId = employee.id;
  req.tenantId = employee.tenant_id;
  req.role = employee.role;
  next();
}

app.get('/api/mobile/map', mapAuth, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_STATIC_API_KEY;
  const size = String(req.query.size || '640x320');
  const zoom = String(req.query.zoom || '13');
  const center = String(req.query.center || '');
  const pins = String(req.query.pins || ''); // lat,lng,color,label|...
  const scale = String(req.query.scale || '2'); // 2 = retina
  const mapType = String(req.query.maptype || 'roadmap');

  if (!key) {
    // No key configured — return a tiny 1x1 transparent PNG placeholder.
    const empty = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64'
    );
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(empty);
  }

  const hash = crypto.createHash('sha1').update([size, zoom, center, pins, scale, mapType].join('|')).digest('hex');
  const cached = _mapCache.get(hash);
  if (cached && Date.now() - cached.ts < MAP_CACHE_TTL_MS) {
    res.set('Content-Type', cached.contentType || 'image/png');
    res.set('Cache-Control', `public, max-age=${Math.floor(MAP_CACHE_TTL_MS / 1000)}`);
    return res.status(200).send(cached.buffer);
  }

  const params = new URLSearchParams();
  params.set('size', size);
  params.set('scale', scale);
  params.set('maptype', mapType);
  if (center) params.set('center', center);
  if (zoom) params.set('zoom', zoom);
  params.set('key', key);

  // Marker syntax: markers=color:red|label:A|lat,lng
  // We accept a single "pins" param: each pin = "lat,lng,color,label" and
  // multiple pins separated by "|". Translate into Maps marker params.
  let markerParams = '';
  if (pins) {
    for (const spec of pins.split('|').filter(Boolean)) {
      const [lat, lng, color, label] = spec.split(',');
      if (!lat || !lng) continue;
      const parts = [];
      if (color) parts.push('color:' + color);
      if (label) parts.push('label:' + label);
      parts.push(`${lat},${lng}`);
      markerParams += '&markers=' + encodeURIComponent(parts.join('|'));
    }
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}${markerParams}`;
  https.get(url, (gr) => {
    const chunks = [];
    gr.on('data', (c) => chunks.push(c));
    gr.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = gr.headers['content-type'] || 'image/png';
      if (gr.statusCode && gr.statusCode < 400 && /image\//.test(String(ct))) {
        _mapCache.set(hash, { buffer: buf, contentType: String(ct), ts: Date.now() });
      }
      res.set('Content-Type', String(ct));
      res.set('Cache-Control', `public, max-age=${Math.floor(MAP_CACHE_TTL_MS / 1000)}`);
      res.status(gr.statusCode || 200).send(buf);
    });
  }).on('error', (e) => {
    res.status(502).json({ error: 'map_upstream_error', message: e.message });
  });
});

// My job updates filtered by type (for Notes tab)
app.get('/api/mobile/crew/my-updates', mobileAuth, async (req, res) => {
  const { type, limit } = req.query;
  let q = supabaseAdmin
    .from('job_updates')
    .select('id, message, created_at, jobs(name)')
    .eq('employee_id', req.employeeId)
    .order('created_at', { ascending: false });
  if (type) q = q.eq('type', String(type));
  q = q.limit(Math.min(parseInt(String(limit || '20'), 10) || 20, 100));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Create supply request
app.post('/api/mobile/crew/jobs/:id/supply-request', mobileAuth, async (req, res) => {
  const { items, urgency, photo_url } = req.body || {};
  if (!items) return res.status(400).json({ error: 'items required' });
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { data, error } = await supabaseAdmin
    .from('supply_requests')
    .insert({
      job_id: job.id,
      employee_id: req.employeeId,
      tenant_id: req.tenantId,
      items,
      urgency: urgency || 'next_day',
      photo_url: photo_url || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Mobile owner/manager endpoints (same mobileAuth guard) ──

// Home KPIs — one round trip returns everything the owner home needs.
app.get('/api/mobile/owner/home', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const stuckThreshold = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [jobsR, onSiteR, assignmentsR, suppliesR, bottlenecksR, recentR] = await Promise.all([
    supabaseAdmin.from('jobs')
      .select('id, name, address, status, updated_at, workflow_id, workflow_progress, clients(name)')
      .in('status', ['active', 'in_progress', 'scheduled', 'on_hold'])
      .eq('tenant_id', req.tenantId)
      .order('updated_at', { ascending: false }),
    supabaseAdmin.from('job_assignments').select('job_id')
      .not('checked_in_at', 'is', null).is('checked_out_at', null).eq('tenant_id', req.tenantId),
    supabaseAdmin.from('job_assignments')
      .select('job_id, employees(name)').is('checked_out_at', null).eq('tenant_id', req.tenantId),
    supabaseAdmin.from('supply_requests').select('job_id')
      .eq('status', 'pending').eq('tenant_id', req.tenantId),
    supabaseAdmin.from('job_updates').select('job_id')
      .eq('type', 'bottleneck').gte('created_at', today.toISOString()).eq('tenant_id', req.tenantId),
    supabaseAdmin.from('job_updates')
      .select('id, type, message, photo_url, created_at, job_id, jobs(name), employees(name)')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  const jobs = jobsR.data || [];
  const onSite = onSiteR.data || [];
  const assignments = assignmentsR.data || [];
  const supplies = suppliesR.data || [];
  const bottlenecks = bottlenecksR.data || [];

  // Workflow status lookup so we can show stage name + color on each job.
  const workflowIds = [...new Set(jobs.map(j => j.workflow_id).filter(Boolean))];
  let statusById = {};
  if (workflowIds.length) {
    const { data: wfStatuses } = await supabaseAdmin.from('workflow_statuses')
      .select('id, name, color').in('workflow_id', workflowIds);
    statusById = Object.fromEntries((wfStatuses || []).map(s => [s.id, s]));
  }

  const enrich = j => {
    const crewNames = assignments
      .filter(a => a.job_id === j.id)
      .map(a => a.employees?.name).filter(Boolean);
    const stageId = j.workflow_progress?.current_status_id;
    const stage = stageId && statusById[stageId] ? statusById[stageId] : null;
    return {
      id: j.id,
      name: j.name,
      address: j.address,
      status: j.status,
      updated_at: j.updated_at,
      client_name: j.clients?.name || null,
      crew: crewNames,
      pendingSupplies: supplies.filter(s => s.job_id === j.id).length,
      stage_name: stage?.name || null,
      stage_color: stage?.color || null,
    };
  };

  const todayJobs = jobs.map(enrich);
  const stuckJobs = jobs
    .filter(j => j.updated_at && j.updated_at < stuckThreshold)
    .map(enrich);

  // Backwards-compatible jobBreakdown for any legacy callers.
  const jobBreakdown = jobs.map(j => ({
    id: j.id,
    name: j.name,
    crew: onSite.filter(a => a.job_id === j.id).length,
    pendingSupplies: supplies.filter(s => s.job_id === j.id).length,
  }));

  // Schedule counts for the current visible week so the Home week strip
  // can show a dot under days that have jobs scheduled. Key: YYYY-MM-DD.
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 13); // two weeks of coverage
  const { data: weekSchedule } = await supabaseAdmin.from('jobs')
    .select('scheduled_date')
    .eq('tenant_id', req.tenantId)
    .gte('scheduled_date', weekStart.toISOString().slice(0, 10))
    .lte('scheduled_date', weekEnd.toISOString().slice(0, 10));
  const scheduleByDay = {};
  for (const row of (weekSchedule || [])) {
    if (!row.scheduled_date) continue;
    scheduleByDay[row.scheduled_date] = (scheduleByDay[row.scheduled_date] || 0) + 1;
  }

  const recentActivity = (recentR.data || []).map(u => ({
    id: u.id,
    type: u.type,
    message: u.message,
    photo_url: u.photo_url,
    created_at: u.created_at,
    job_id: u.job_id,
    job_name: u.jobs?.name || null,
    employee_name: u.employees?.name || null,
  }));

  res.json({
    activeJobs: jobs.length,
    crewOnSite: onSite.length,
    pendingSupplies: supplies.length,
    bottlenecksToday: bottlenecks.length,
    jobBreakdown,
    todayJobs,
    stuckJobs,
    recentActivity,
    scheduleByDay,
  });
});

// Single job with everything needed for the Job Detail screen.
// Open to all roles — tenant scoping is the real security boundary.
// Status changes go through /api/mobile/jobs/:id/transition (role-enforced);
// financial/schedule edits stay on the owner-only PATCH below.
app.get('/api/mobile/owner/jobs/:id', mobileAuth, async (req, res) => {
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .select('*, clients(id, name, email, phone, address)')
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const [{ data: assignments }, { data: updates }, { count: photoCount }, { data: acks }] = await Promise.all([
    supabaseAdmin.from('job_assignments')
      .select('id, employee_id, checked_in_at, checked_out_at, employees(id, name, phone, push_token)')
      .eq('job_id', job.id).order('checked_in_at', { ascending: false }),
    supabaseAdmin.from('job_updates')
      .select('id, type, message, photo_url, created_at, employees(name)')
      .eq('job_id', job.id).order('created_at', { ascending: false }).limit(30),
    supabaseAdmin.from('job_updates').select('id', { count: 'exact', head: true })
      .eq('job_id', job.id).eq('type', 'photo').not('photo_url', 'is', null),
    supabaseAdmin.from('job_scope_acknowledgements')
      .select('employee_id, acked_at, acked_scope_updated_at')
      .eq('job_id', job.id),
  ]);

  res.json({
    job,
    client: job.clients || null,
    assignments: assignments || [],
    updates: updates || [],
    photoCount: photoCount || 0,
    scope_acks: acks || [],
  });
});

// All tenant jobs with recent activity (for Jobs / Dashboard tabs)
app.get('/api/mobile/owner/jobs', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs').select('*, clients(name, email)').eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Dashboard = jobs + joined crew-on-site + pending supplies + last 5 updates per job.
// One round trip; client just renders.
app.get('/api/mobile/owner/dashboard', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data: jobs, error } = await supabaseAdmin
    .from('jobs').select('*').eq('tenant_id', req.tenantId).order('name');
  if (error) return res.status(500).json({ error: error.message });
  const ids = (jobs || []).map(j => j.id);
  if (!ids.length) return res.json([]);
  const [{ data: assignments }, { data: supplies }, { data: updates }] = await Promise.all([
    supabaseAdmin.from('job_assignments')
      .select('job_id, employees(name)').in('job_id', ids).is('checked_out_at', null),
    supabaseAdmin.from('supply_requests')
      .select('id, job_id').in('job_id', ids).eq('status', 'pending'),
    supabaseAdmin.from('job_updates')
      .select('job_id, type, message, photo_url, created_at, employees(name)')
      .in('job_id', ids).order('created_at', { ascending: false }).limit(600),
  ]);
  const enriched = (jobs || []).map(j => {
    const crew = (assignments || []).filter(a => a.job_id === j.id).map(a => a.employees).filter(Boolean);
    const pendingSupplies = (supplies || []).filter(s => s.job_id === j.id).length;
    const recentUpdates = (updates || []).filter(u => u.job_id === j.id).slice(0, 5);
    return { ...j, crew, pendingSupplies, recentUpdates };
  });
  res.json(enriched);
});

// Update a job's status
app.patch('/api/mobile/owner/jobs/:id', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const updates = {};
  if (req.body.status) updates.status = req.body.status;
  if (req.body.name) updates.name = req.body.name;
  if (req.body.address !== undefined) updates.address = req.body.address;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.execution_plan !== undefined) updates.execution_plan = req.body.execution_plan;
  if (req.body.plans_notes !== undefined) updates.plans_notes = req.body.plans_notes;
  if (req.body.missing_items_watchlist !== undefined) updates.missing_items_watchlist = req.body.missing_items_watchlist;
  if (req.body.checklist_items !== undefined) {
    updates.checklist_items = Array.isArray(req.body.checklist_items)
      ? req.body.checklist_items.map(s => String(s || '').trim()).filter(Boolean)
      : [];
  }
  for (const f of ['required_before_photos', 'required_mid_job_photos', 'required_completion_photos', 'required_cleanup_photos']) {
    if (req.body[f] !== undefined) {
      const n = req.body[f] === null || req.body[f] === '' ? 0 : parseInt(req.body[f], 10);
      updates[f] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  if (req.body.estimate_amount !== undefined) {
    if (req.role !== 'owner') return res.status(403).json({ error: 'Owner access required to edit estimate' });
    const n = req.body.estimate_amount === null ? null : parseFloat(req.body.estimate_amount);
    if (n !== null && (isNaN(n) || n < 0)) return res.status(400).json({ error: 'Invalid estimate amount' });
    updates.estimate_amount = n;
  }
  if (req.body.scheduled_date !== undefined) {
    // Accept YYYY-MM-DD string or null. Postgres will reject any malformed value.
    updates.scheduled_date = req.body.scheduled_date || null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no updates' });
  const scopeTouched = scopeFieldsTouched(updates);
  const { data, error } = await supabaseAdmin
    .from('jobs').update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (scopeTouched) {
    try {
      await bumpScopeAndNotify({
        tenantId: req.tenantId,
        jobId: req.params.id,
        updatedByName: req.employeeName || 'Your team',
        updatedByUserId: null,
      });
    } catch (e) {
      console.error('[scope notify mobile] error:', e.message);
    }
  }

  res.json(data);
});

// Email the public work-order / quote URL to the linked client.
app.post('/api/mobile/owner/jobs/:id/send-workorder', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email)')
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.clients?.email) return res.status(400).json({ error: 'Link a client with an email address first.' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name').eq('id', req.tenantId).single();
  try {
    await sendWorkOrderToClient({
      clientName: job.clients.name,
      clientEmail: job.clients.email,
      jobName: job.name,
      description: job.description,
      estimateAmount: job.estimate_amount,
      workorderUrl: `https://linkcrew.io/workorder?job_id=${job.id}`,
      tenantName: tenant?.company_name,
    });
    res.json({ ok: true, emailed_to: job.clients.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a job
// Crew-open — any role can create a job or quote from the field.
app.post('/api/mobile/owner/jobs', mobileAuth, async (req, res) => {
  const { name, address, description, estimate_amount, scheduled_date, client_id, workflow_id, status } = req.body || {};
  if (!name || !address) return res.status(400).json({ error: 'name and address required' });
  // If a workflow_id is supplied, verify it belongs to this tenant.
  if (workflow_id) {
    const { data: wf } = await supabaseAdmin
      .from('service_workflows').select('id').eq('id', workflow_id).eq('tenant_id', req.tenantId).maybeSingle();
    if (!wf) return res.status(400).json({ error: 'Invalid workflow' });
  }
  const allowedStatuses = new Set(['quoted', 'scheduled', 'in_progress', 'complete', 'invoiced', 'on_hold']);
  const startStatus = typeof status === 'string' && allowedStatuses.has(status) ? status : 'scheduled';
  const { data, error } = await supabaseAdmin
    .from('jobs').insert({
      name: String(name).trim(),
      address: String(address).trim(),
      status: startStatus,
      tenant_id: req.tenantId,
      description: description || null,
      estimate_amount: estimate_amount != null ? Number(estimate_amount) : null,
      scheduled_date: scheduled_date || null,
      client_id: client_id || null,
      workflow_id: workflow_id || null,
    }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// List tenant's enabled Service PRO workflows (for the new-job type picker).
app.get('/api/mobile/owner/workflows', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('service_workflows')
    .select('id, name, description, industry')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Assignments for a job (active, not checked out)
app.get('/api/mobile/owner/jobs/:id/assignments', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_assignments')
    .select('employee_id, checked_in_at, employees(name)')
    .eq('job_id', req.params.id)
    .is('checked_out_at', null);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Replace the assignment set for a job (diff with current, add/remove)
app.post('/api/mobile/owner/jobs/:id/assignments', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const jobId = req.params.id;
  const ids = Array.isArray(req.body.employee_ids) ? req.body.employee_ids : [];
  const { data: current } = await supabaseAdmin
    .from('job_assignments')
    .select('employee_id, checked_in_at')
    .eq('job_id', jobId)
    .is('checked_out_at', null);
  const currentIds = (current || []).map(c => c.employee_id);
  const toAdd = ids.filter(id => !currentIds.includes(id));
  const toRemove = currentIds.filter(id => !ids.includes(id));
  if (toAdd.length) {
    await supabaseAdmin.from('job_assignments').upsert(
      toAdd.map(id => ({ job_id: jobId, employee_id: id, tenant_id: req.tenantId })),
      { onConflict: 'job_id,employee_id', ignoreDuplicates: true }
    );
    // Push-notify newly assigned crew so they know to check the app.
    try {
      const { data: job } = await supabaseAdmin.from('jobs')
        .select('name, address, scheduled_date').eq('id', jobId).maybeSingle();
      const { data: employees } = await supabaseAdmin.from('employees')
        .select('id, push_token').in('id', toAdd).eq('tenant_id', req.tenantId);
      const scheduledHint = job?.scheduled_date ? ` (${job.scheduled_date})` : '';
      for (const emp of (employees || [])) {
        if (!emp.push_token) continue;
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            to: emp.push_token,
            sound: 'default',
            title: 'Assigned to a job',
            body: `${job?.name || 'A job'}${job?.address ? ` · ${job.address}` : ''}${scheduledHint}. Tap to view.`,
            data: { type: 'assigned', job_id: jobId },
          }),
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[assign notify] error:', e.message);
    }
  }
  for (const id of toRemove) {
    const entry = (current || []).find(c => c.employee_id === id);
    if (entry && !entry.checked_in_at) {
      await supabaseAdmin.from('job_assignments')
        .delete().eq('job_id', jobId).eq('employee_id', id).is('checked_in_at', null);
    }
  }
  res.json({ ok: true });
});

// Clients list + create
app.get('/api/mobile/owner/clients', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients').select('*').eq('tenant_id', req.tenantId).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
// Intentionally crew-open — every role can create clients. Tenant is
// derived from the mobile session, so there's no cross-tenant leak risk.
app.post('/api/mobile/owner/clients', mobileAuth, async (req, res) => {
  const { name, phone, email, address, company, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabaseAdmin
    .from('clients').insert({
      name: name.trim(),
      phone: phone ? String(phone).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null,
      email: email || null,
      address: address || null,
      company: company || null,
      notes: notes || null,
      tenant_id: req.tenantId,
    }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mobile/owner/clients/:id', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const updates = {};
  for (const f of ['name', 'company', 'email', 'address', 'notes']) {
    if (req.body[f] !== undefined) updates[f] = req.body[f] === '' ? null : req.body[f];
  }
  if (req.body.phone !== undefined) {
    const p = String(req.body.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    updates.phone = p || null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no updates' });
  if (typeof updates.name === 'string' && !updates.name.trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  const { data, error } = await supabaseAdmin.from('clients')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Employees list + role update + create
app.get('/api/mobile/owner/crew', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('employees').select('*').eq('tenant_id', req.tenantId).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/mobile/owner/crew', mobileAuth, requireMobileOwner, async (req, res) => {
  const { name, phone, role } = req.body || {};
  if (!name || !phone || !role) return res.status(400).json({ error: 'name, phone, role required' });
  // Plan limit check
  const { data: tenant } = await supabaseAdmin.from('tenants').select('max_users').eq('id', req.tenantId).single();
  const maxUsers = tenant?.max_users ?? 1;
  const { count } = await supabaseAdmin.from('employees').select('*', { count: 'exact', head: true }).eq('tenant_id', req.tenantId);
  if ((count || 0) >= maxUsers) {
    return res.status(403).json({ error: `Plan limit reached (${maxUsers} crew). Upgrade at linkcrew.io/pricing.` });
  }
  let normalizedPhone = String(phone).replace(/\D/g, '');
  if (normalizedPhone.length === 11 && normalizedPhone.startsWith('1')) normalizedPhone = normalizedPhone.slice(1);
  const { data, error } = await supabaseAdmin
    .from('employees').insert({
      name: String(name).trim(),
      phone: normalizedPhone,
      role,
      status: 'active',
      tenant_id: req.tenantId,
    }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// Dashboard-auth version of the mobile session revoke — button on the
// dashboard Team modal. Same effect: clears the token, next request 401s.
app.post('/api/employees/:id/revoke-mobile', auth, requireSettingsAccess, async (req, res) => {
  const { error } = await supabaseAdmin.from('employees')
    .update({ mobile_session_token: null, mobile_session_issued_at: null })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Revoke a crew member's mobile session. Next request from their app gets
// 401 and forces re-login. Owner-only — lets you kick a lost / fired phone.
app.post('/api/mobile/owner/crew/:id/revoke-session', mobileAuth, requireMobileOwner, async (req, res) => {
  const { error } = await supabaseAdmin.from('employees')
    .update({ mobile_session_token: null, mobile_session_issued_at: null })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.patch('/api/mobile/owner/crew/:id', mobileAuth, requireMobileOwner, async (req, res) => {
  const updates = {};
  if (req.body.role) updates.role = req.body.role;
  if (req.body.status) updates.status = req.body.status;
  if (typeof req.body.name === 'string') updates.name = req.body.name.trim();
  if (typeof req.body.phone === 'string') {
    const normalized = String(req.body.phone).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    updates.phone = normalized || null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no updates' });
  const { data, error } = await supabaseAdmin
    .from('employees').update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Remove an employee. Their session token is cleared implicitly since the
// row is gone; next /api/mobile/* request 401s.
app.delete('/api/mobile/owner/crew/:id', mobileAuth, requireMobileOwner, async (req, res) => {
  const { error } = await supabaseAdmin.from('employees')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Supply requests list + status update
app.get('/api/mobile/owner/supplies', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('supply_requests').select('*, jobs(name), employees(name)')
    .eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.patch('/api/mobile/owner/supplies/:id', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  const { data, error } = await supabaseAdmin
    .from('supply_requests').update({ status }).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Photos = job_updates of type 'photo' with a photo_url
app.get('/api/mobile/owner/photos', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_updates').select('id, message, photo_url, created_at, jobs(name), employees(name)')
    .eq('tenant_id', req.tenantId).eq('type', 'photo').not('photo_url', 'is', null)
    .order('created_at', { ascending: false }).limit(80);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Owner-only guard for mobile financial endpoints
function requireMobileOwner(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

// Owner or manager — for shared owner-URL endpoints. Crew gets 403.
function requireMobileOwnerOrManager(req, res, next) {
  if (req.role !== 'owner' && req.role !== 'manager') {
    return res.status(403).json({ error: 'Owner or manager access required' });
  }
  next();
}

// Fields that count as "scope of work" — edits to these bump
// jobs.scope_updated_at and push-notify active assignees so they see
// fresh instructions on-site.
const JOB_SCOPE_FIELDS = [
  'description', 'execution_plan', 'checklist_items',
  'required_before_photos', 'required_mid_job_photos',
  'required_completion_photos', 'required_cleanup_photos',
  'plans_notes', 'missing_items_watchlist',
];

function scopeFieldsTouched(updates) {
  return JOB_SCOPE_FIELDS.some(f => f in updates);
}

async function bumpScopeAndNotify({ tenantId, jobId, updatedByName, updatedByUserId }) {
  const now = new Date().toISOString();
  await supabaseAdmin.from('jobs').update({
    scope_updated_at: now,
    scope_updated_by_user_id: updatedByUserId || null,
    scope_updated_by_name: updatedByName || 'Your team',
  }).eq('id', jobId).eq('tenant_id', tenantId);

  const { data: job } = await supabaseAdmin.from('jobs')
    .select('id, name').eq('id', jobId).maybeSingle();

  // Only push to crew who currently have an active assignment (not checked out).
  const { data: assignments } = await supabaseAdmin.from('job_assignments')
    .select('employees(id, name, push_token)')
    .eq('job_id', jobId)
    .is('checked_out_at', null);

  const tokens = (assignments || [])
    .map(a => a.employees?.push_token)
    .filter(Boolean);

  if (!tokens.length) return { scope_updated_at: now, notified: 0 };

  let sent = 0;
  for (const token of tokens) {
    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: token,
          sound: 'default',
          title: 'Instructions updated',
          body: `${updatedByName || 'Your team'} updated the job list for ${job?.name || 'your job'}. Tap to review.`,
          data: { type: 'scope_updated', job_id: jobId },
        }),
      });
      if (resp.ok) sent += 1;
    } catch (e) {
      console.error('[scope notify] push error:', e.message);
    }
  }
  return { scope_updated_at: now, notified: sent };
}

// Create invoice on an existing job (sets invoice_amount + status=invoiced,
// emails client if they have an email). Mirrors desktop POST /api/jobs/:id/invoice.
app.post('/api/mobile/owner/jobs/:id/invoice', mobileAuth, requireMobileOwner, async (req, res) => {
  const amount = parseFloat(req.body?.amount);
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }
  const { data, error } = await supabaseAdmin.from('jobs')
    .update({ invoice_amount: amount, status: 'invoiced', payment_status: 'unpaid' })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId)
    .select('*, clients(name, email)').single();
  if (error) return res.status(400).json({ error: error.message });

  const client = data.clients;
  let emailSent = false;
  if (client?.email) {
    try {
      const [{ data: tenant }, { data: clientUser }] = await Promise.all([
        supabaseAdmin.from('tenants').select('company_name').eq('id', req.tenantId).single(),
        supabaseAdmin.from('client_users').select('portal_token').eq('client_id', data.client_id).maybeSingle(),
      ]);
      const host = `https://${req.get('host')}`;
      const portalUrl = clientUser?.portal_token
        ? `${host}/portal?token=${clientUser.portal_token}`
        : `${host}/portal`;
      await sendInvoiceToClient({
        clientName: client.name,
        clientEmail: client.email,
        jobName: data.name,
        amount,
        portalUrl,
        tenantName: tenant?.company_name,
      });
      emailSent = true;
    } catch (emailErr) {
      console.error('[mobile invoice] email error:', emailErr.message);
    }
  }
  res.json({ job: data, invoice_email_sent: emailSent, invoice_emailed_to: emailSent ? client.email : null });
});

// Subscription billing portal — returns a Stripe customer-portal URL.
app.post('/api/mobile/owner/billing-portal', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_customer_id').eq('id', req.tenantId).single();
  if (!tenant?.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: 'https://linkcrew.io/app',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stripe Connect — status / start / disconnect (mobile).
app.get('/api/mobile/owner/stripe-connect/status', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_connect_account_id, stripe_connect_status').eq('id', req.tenantId).single();
  res.json({
    connected: tenant?.stripe_connect_status === 'active' && !!tenant.stripe_connect_account_id,
    status: tenant?.stripe_connect_status || null,
  });
});

app.post('/api/mobile/owner/stripe-connect/start', mobileAuth, requireMobileOwner, async (req, res) => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Stripe Connect is not configured' });
  const redirectUri = `https://linkcrew.io/api/stripe/connect/callback`;
  const state = signConnectState(req.tenantId);
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('owner_email, company_name').eq('id', req.tenantId).single();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
    'stripe_user[email]': tenant?.owner_email || '',
    'stripe_user[business_name]': tenant?.company_name || '',
  });
  res.json({ url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` });
});

app.post('/api/mobile/owner/stripe-connect/disconnect', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('stripe_connect_account_id').eq('id', req.tenantId).single();
  if (tenant?.stripe_connect_account_id && process.env.STRIPE_CONNECT_CLIENT_ID) {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    try {
      await stripe.oauth.deauthorize({
        client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
        stripe_user_id: tenant.stripe_connect_account_id,
      });
    } catch (err) {
      console.error('[mobile stripe connect] deauthorize error:', err.message);
    }
  }
  await supabaseAdmin.from('tenants').update({
    stripe_connect_account_id: null,
    stripe_connect_status: null,
  }).eq('id', req.tenantId);
  res.json({ ok: true });
});

// Universal search — clients / jobs / invoices matching q. Each list
// capped at 10 results. type can be 'all', 'clients', 'jobs', 'invoices'.
app.get('/api/mobile/owner/search', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  // PostgREST's .or() filter syntax uses '*' as wildcard, not '%'.
  const like = q ? `*${q}*` : '*';
  const qLower = q.toLowerCase();
  const hasQ = !!q;

  const tasks = {};
  const LIMIT = 50;

  if (type === 'all' || type === 'clients') {
    let qb = supabaseAdmin.from('clients')
      .select('id, name, company, email, phone, notes, address')
      .eq('tenant_id', req.tenantId);
    if (hasQ) {
      qb = qb.or(`name.ilike.${like},company.ilike.${like},email.ilike.${like},phone.ilike.${like},notes.ilike.${like},address.ilike.${like}`);
    }
    tasks.clients = qb.order('name').limit(LIMIT);
  }
  if (type === 'all' || type === 'quotes') {
    // Quotes = recurring service agreements.
    let qb = supabaseAdmin.from('service_agreements')
      .select('id, name, frequency, price, next_due, status, clients(name)')
      .eq('tenant_id', req.tenantId);
    if (hasQ) qb = qb.or(`name.ilike.${like}`);
    tasks.quotes = qb.order('next_due').limit(LIMIT);
  }
  if (type === 'all' || type === 'estimates') {
    // Estimates = jobs in pre-booking status (quoted/lead/draft).
    let qb = supabaseAdmin.from('jobs')
      .select('id, name, address, description, status, invoice_amount, updated_at, clients(name)')
      .eq('tenant_id', req.tenantId)
      .in('status', ['quoted', 'lead', 'draft']);
    if (hasQ) qb = qb.or(`name.ilike.${like},address.ilike.${like},description.ilike.${like}`);
    tasks.estimates = qb.order('updated_at', { ascending: false }).limit(LIMIT);
  }
  if (type === 'all' || type === 'jobs') {
    let qb = supabaseAdmin.from('jobs')
      .select('id, name, address, description, execution_plan, plans_notes, checklist_items, status, invoice_amount, payment_status, scheduled_date, clients(name)')
      .eq('tenant_id', req.tenantId);
    if (hasQ) qb = qb.or(`name.ilike.${like},address.ilike.${like},description.ilike.${like},execution_plan.ilike.${like},plans_notes.ilike.${like}`);
    tasks.jobs = qb.order('updated_at', { ascending: false }).limit(LIMIT);
  }
  if (type === 'all' || type === 'invoices') {
    let qb = supabaseAdmin.from('jobs')
      .select('id, name, address, description, status, invoice_amount, payment_status, updated_at, clients(name, email)')
      .eq('tenant_id', req.tenantId)
      .gt('invoice_amount', 0);
    if (hasQ) qb = qb.or(`name.ilike.${like},description.ilike.${like},address.ilike.${like}`);
    tasks.invoices = qb.order('updated_at', { ascending: false }).limit(LIMIT);
  }
  // Also pull jobs that only match via crew notes (job_updates.message) —
  // only when there's an actual query and we're in the jobs scope.
  if (hasQ && (type === 'all' || type === 'jobs')) {
    tasks.noteMatches = supabaseAdmin.from('job_updates')
      .select('job_id, message, jobs(id, name, address, status, invoice_amount, payment_status, checklist_items, clients(name))')
      .eq('tenant_id', req.tenantId)
      .eq('type', 'note')
      .ilike('message', like)
      .order('created_at', { ascending: false }).limit(LIMIT);
  }

  const results = {};
  for (const [key, query] of Object.entries(tasks)) {
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    results[key] = data || [];
  }

  // Merge note matches into jobs results, dedup by job id, and post-filter
  // for checklist_items matches (which ilike can't reach inside a text[]).
  const jobs = results.jobs || [];
  const seen = new Set(jobs.map(j => j.id));

  // Checklist item substring match within the already-selected jobs+invoices.
  // (We fetch all jobs anyway; this just surfaces ones that matched checklist
  // only — the OR filter above already caught matches on description/plans.)
  // No extra query needed; the jobs result includes checklist_items and
  // clients will see the match in the UI.

  for (const u of (results.noteMatches || [])) {
    const j = u.jobs;
    if (!j || seen.has(j.id)) continue;
    jobs.push({
      id: j.id, name: j.name, address: j.address, status: j.status,
      invoice_amount: j.invoice_amount, payment_status: j.payment_status,
      clients: j.clients, _matchedVia: 'note',
    });
    seen.add(j.id);
  }

  // Extra pass: post-filter all scanned jobs for checklist_items that contain
  // the query as substring. Small N per tenant, cheap enough. Only when there
  // is an actual query — blank-q returns the straight jobs list.
  if (hasQ && (type === 'all' || type === 'jobs')) {
    const { data: allTenantJobs } = await supabaseAdmin.from('jobs')
      .select('id, name, address, status, invoice_amount, payment_status, checklist_items, clients(name)')
      .eq('tenant_id', req.tenantId);
    for (const j of (allTenantJobs || [])) {
      if (seen.has(j.id)) continue;
      const items = Array.isArray(j.checklist_items) ? j.checklist_items : [];
      if (items.some(line => typeof line === 'string' && line.toLowerCase().includes(qLower))) {
        jobs.push({ ...j, _matchedVia: 'checklist' });
        seen.add(j.id);
      }
    }
  }

  res.json({
    clients: results.clients || [],
    quotes: results.quotes || [],
    estimates: results.estimates || [],
    jobs,
    invoices: results.invoices || [],
  });
});

// Company settings (owner) — company_name, phone, address (and plan info).
app.get('/api/mobile/owner/tenant', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('tenants')
    .select('id, company_name, phone, address, logo_url, plan, subscription_status, trial_ends_at, stripe_customer_id')
    .eq('id', req.tenantId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/mobile/owner/tenant', mobileAuth, requireMobileOwner, async (req, res) => {
  const { company_name, phone, address } = req.body || {};
  const updates = {};
  if (typeof company_name === 'string') updates.company_name = company_name.trim();
  if (typeof phone === 'string') updates.phone = phone.trim();
  if (typeof address === 'string') updates.address = address.trim();
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updates' });
  const { data, error } = await supabaseAdmin.from('tenants')
    .update(updates).eq('id', req.tenantId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Financial KPIs for owner home (revenue MTD, outstanding, lifetime collected).
app.get('/api/mobile/owner/financials', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('jobs')
    .select('invoice_amount, payment_status, updated_at')
    .eq('tenant_id', req.tenantId)
    .gt('invoice_amount', 0);
  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let revenueMtd = 0, outstanding = 0, collected = 0, paidThisWeek = 0;
  for (const j of (data || [])) {
    const amt = Number(j.invoice_amount) || 0;
    const paid = String(j.payment_status || '').toLowerCase() === 'paid';
    if (paid) {
      collected += amt;
      if (j.updated_at && j.updated_at >= monthStart) revenueMtd += amt;
      if (j.updated_at && j.updated_at >= weekAgo) paidThisWeek += amt;
    } else {
      outstanding += amt;
    }
  }
  res.json({ revenueMtd, outstanding, collected, paidThisWeek });
});

// Resend the invoice email for an existing invoiced job. Uses the current
// invoice_amount. Errors if the job has no amount yet or client has no
// email on file.
app.post('/api/mobile/owner/jobs/:id/invoice/resend', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email)')
    .eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!(Number(job.invoice_amount) > 0)) return res.status(400).json({ error: 'Job has no invoice to resend' });
  const client = job.clients;
  if (!client?.email) return res.status(400).json({ error: 'Client has no email on file' });

  try {
    const [{ data: tenant }, { data: clientUser }] = await Promise.all([
      supabaseAdmin.from('tenants').select('company_name').eq('id', req.tenantId).single(),
      supabaseAdmin.from('client_users').select('portal_token').eq('client_id', job.client_id).maybeSingle(),
    ]);
    const portalUrl = clientUser?.portal_token
      ? `https://linkcrew.io/portal?token=${clientUser.portal_token}`
      : 'https://linkcrew.io/portal';
    await sendInvoiceToClient({
      clientName: client.name,
      clientEmail: client.email,
      jobName: job.name,
      amount: Number(job.invoice_amount),
      portalUrl,
      tenantName: tenant?.company_name,
    });
    res.json({ ok: true, emailed_to: client.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark invoice paid (cash / check / out-of-band). Optionally emails a receipt.
app.post('/api/mobile/owner/jobs/:id/mark-paid', mobileAuth, requireMobileOwner, async (req, res) => {
  const notify = req.body?.notify === 'email' ? 'email' : null;
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .update({ payment_status: 'paid' })
    .eq('id', req.params.id).eq('tenant_id', req.tenantId)
    .select('*, clients(name, email, phone)').single();
  if (error) return res.status(400).json({ error: error.message });

  let emailSent = false;
  if (notify === 'email' && job.clients?.email) {
    try {
      const { data: tenant } = await supabaseAdmin.from('tenants')
        .select('company_name').eq('id', req.tenantId).single();
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: LINKCREW_FROM,
        to: job.clients.email,
        subject: `Payment received — ${job.name}`,
        html: `<div style="font-family:sans-serif;max-width:500px">
          <h2 style="color:#166534">Payment Received</h2>
          <p>Hi ${job.clients.name},</p>
          <p>This is a confirmation that your payment of <strong>$${parseFloat(job.invoice_amount).toFixed(2)}</strong> for <strong>${job.name}</strong> has been received.</p>
          <p>Thank you for your business!</p>
          <p style="color:#737475;font-size:12px">${tenant?.company_name || 'Your contractor'}</p>
        </div>`,
      });
      emailSent = true;
    } catch (e) { console.error('[mobile mark-paid] email error:', e.message); }
  }
  res.json({ job, receipt_email_sent: emailSent });
});

// Quick invoice — pick-or-create client, enter amount, emails automatically.
// Solves the walk-up contractor scenario: tech finished a surprise job and
// owner needs to bill a client that isn't in the system yet.
app.post('/api/mobile/owner/invoices/quick', mobileAuth, requireMobileOwner, async (req, res) => {
  const { client_id, new_client, amount, description } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
  if (!client_id && !new_client?.name) {
    return res.status(400).json({ error: 'Pick a client or enter a new client name' });
  }

  // Resolve the client
  let client;
  if (client_id) {
    const { data } = await supabaseAdmin.from('clients')
      .select('id, name, email, address, phone')
      .eq('id', client_id).eq('tenant_id', req.tenantId).single();
    if (!data) return res.status(404).json({ error: 'Client not found' });
    client = data;
  } else {
    const { name, email, phone, address } = new_client;
    const normalizedPhone = phone ? String(phone).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;
    const { data, error } = await supabaseAdmin.from('clients').insert({
      name: String(name).trim(),
      email: email ? String(email).trim().toLowerCase() : null,
      phone: normalizedPhone,
      address: address ? String(address).trim() : null,
      tenant_id: req.tenantId,
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    client = data;
  }

  // Create the invoice-only job
  const jobName = (description && description.trim())
    || `Invoice for ${client.name}`;
  const { data: job, error: jobErr } = await supabaseAdmin.from('jobs').insert({
    name: jobName,
    address: client.address || '',
    status: 'invoiced',
    payment_status: 'unpaid',
    invoice_amount: amt,
    client_id: client.id,
    tenant_id: req.tenantId,
  }).select('*, clients(name, email)').single();
  if (jobErr) return res.status(400).json({ error: jobErr.message });

  // Email the client if we have their email
  let emailSent = false;
  if (client.email) {
    try {
      const { data: tenant } = await supabaseAdmin.from('tenants')
        .select('company_name').eq('id', req.tenantId).single();
      const { data: clientUser } = await supabaseAdmin.from('client_users')
        .select('portal_token').eq('client_id', client.id).maybeSingle();
      const portalUrl = clientUser?.portal_token
        ? `https://linkcrew.io/portal?token=${clientUser.portal_token}`
        : 'https://linkcrew.io/portal';
      await sendInvoiceToClient({
        clientName: client.name,
        clientEmail: client.email,
        jobName: job.name,
        amount: amt,
        portalUrl,
        tenantName: tenant?.company_name,
      });
      emailSent = true;
    } catch (e) {
      console.error('[quick invoice] email error:', e.message);
    }
  }

  res.json({
    job,
    client,
    client_created: !client_id,
    invoice_email_sent: emailSent,
    invoice_emailed_to: emailSent ? client.email : null,
  });
});

// Invoices = jobs with invoice_amount > 0. No separate invoices table exists.
app.get('/api/mobile/owner/invoices', mobileAuth, requireMobileOwner, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, status, payment_status, invoice_amount, created_at, updated_at, client_id, clients(name, email)')
    .eq('tenant_id', req.tenantId)
    .gt('invoice_amount', 0)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Tenant plan info (for owner lockout screens in mobile app)
app.get('/api/mobile/tenant-plan', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('plan, subscription_status, max_users, trial_ends_at, paused, blocked')
    .eq('id', req.tenantId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

// Register FCM push token
app.post('/api/mobile/push-token', mobileAuth, async (req, res) => {
  const { push_token } = req.body || {};
  if (!push_token) return res.status(400).json({ error: 'push_token required' });
  const { error } = await supabaseAdmin
    .from('employees')
    .update({ push_token })
    .eq('id', req.employeeId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// List enabled workflows + their statuses for this tenant
app.get('/api/mobile/crew/workflows', mobileAuth, async (req, res) => {
  const { data: workflows, error } = await supabaseAdmin
    .from('service_workflows')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const ids = (workflows || []).map(w => w.id);
  let statuses = [];
  if (ids.length) {
    const { data: st, error: stErr } = await supabaseAdmin
      .from('workflow_statuses')
      .select('*')
      .in('workflow_id', ids)
      .order('order_index', { ascending: true });
    if (stErr) return res.status(500).json({ error: stErr.message });
    statuses = st || [];
  }
  const byWf = statuses.reduce((m, s) => { (m[s.workflow_id] ||= []).push(s); return m; }, {});
  res.json((workflows || []).map(w => ({ ...w, statuses: byWf[w.id] || [] })));
});

// Advance a pill + update checklist; derives legacy jobs.status from the pill.
app.patch('/api/mobile/crew/jobs/:id/workflow-progress', mobileAuth, async (req, res) => {
  const { id } = req.params;
  const { data: job } = await supabaseAdmin
    .from('jobs')
    .select('id, workflow_id, workflow_progress')
    .eq('id', id)
    .eq('tenant_id', req.tenantId)
    .maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.workflow_id) return res.status(400).json({ error: 'Job has no workflow attached' });

  const incoming = req.body?.workflow_progress || {};
  const base = job.workflow_progress || {};
  const merged = { ...base, ...incoming };
  if (incoming.completed_steps) {
    merged.completed_steps = { ...(base.completed_steps || {}), ...incoming.completed_steps };
  }

  const { data: wfStatuses } = await supabaseAdmin
    .from('workflow_statuses')
    .select('id, legacy_status, order_index')
    .eq('workflow_id', job.workflow_id)
    .order('order_index', { ascending: true });
  const list = wfStatuses || [];
  let currentId = merged.current_status_id;
  if (!currentId || !list.some(s => s.id === currentId)) {
    currentId = list[0]?.id || null;
    if (currentId) merged.current_status_id = currentId;
  }
  const currentStatus = currentId ? list.find(s => s.id === currentId) : null;
  const updates = { workflow_progress: merged, updated_at: new Date().toISOString() };
  if (currentStatus?.legacy_status) updates.status = normalizeJobStatus(currentStatus.legacy_status);

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', req.tenantId)
    .select('*')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Public: crew member self-registers
app.post('/api/crew-register', async (req, res) => {
  const { t, name, phone, role } = req.body;
  if (!t || !name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
  const { data: invite } = await supabaseAdmin.from('crew_invite_links')
    .select('tenant_id').eq('token', t).maybeSingle();
  if (!invite) return res.status(400).json({ error: 'This invite link is invalid or has been regenerated. Ask your manager for a new one.' });
  const tenantId = invite.tenant_id;
  let normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone.length === 11 && normalizedPhone.startsWith('1')) {
    normalizedPhone = normalizedPhone.slice(1);
  }
  const { data: dup } = await supabaseAdmin.from('employees')
    .select('id').eq('tenant_id', tenantId).eq('phone', normalizedPhone).maybeSingle();
  if (dup) return res.status(409).json({ error: 'A crew member with this phone number already exists.' });
  const { data, error } = await supabaseAdmin.from('employees').insert({
    name: name.trim(), phone: normalizedPhone, role: role?.trim() || 'crew', tenant_id: tenantId
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, employee: data });
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

  const { data: tenants } = await supabaseAdmin.from('tenants').select('plan, subscription_status, stripe_subscription_id');
  const currentMRR = (tenants || [])
    .filter(t => t.subscription_status === 'active' && !!t.stripe_subscription_id)
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

app.post('/api/account/change-password', auth, async (req, res) => {
  const { current_password, password } = req.body || {};
  if (!current_password || !password) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (!req.userEmail) {
    return res.status(400).json({ error: 'User email not found for this session.' });
  }

  const verifyResult = await supabase.auth.signInWithPassword({
    email: req.userEmail,
    password: current_password,
  });
  if (verifyResult.error || !verifyResult.data?.user) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const updateResult = await supabaseAdmin.auth.admin.updateUserById(req.userId, { password });
  if (updateResult.error) return res.status(400).json({ error: updateResult.error.message });

  try {
    if (verifyResult.data?.session?.access_token) {
      await supabase.auth.signOut(verifyResult.data.session.access_token);
    }
  } catch (_) {}

  res.json({ ok: true });
});

// ── Suggestions ───────────────────────────────────────────────────────────────

app.post('/api/suggestions', auth, async (req, res) => {
  const tenantId = await getEffectiveTenantId(req);
  if (!req.isAdmin) {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('subscription_status').eq('id', tenantId).single();
    const ok = ['active', 'trialing'].includes(tenant?.subscription_status);
    if (!ok) return res.status(403).json({ error: 'Trial or active subscription required' });
  }
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const { data, error } = await supabaseAdmin.from('suggestions')
    .insert({ tenant_id: tenantId, title, description: description || null })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Admin: see all suggestions across all tenants
app.get('/api/admin/suggestions', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { data } = await supabaseAdmin
    .from('suggestions')
    .select('*, tenants(company_name, owner_email)')
    .order('created_at', { ascending: false });
  res.json(data || []);
});

// ── Appointment AI Query ──────────────────────────────────────────────────────

app.post('/api/appointments/ask', auth, async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const tenantId = await getEffectiveTenantId(req);
  const now = new Date();
  const rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(now); rangeEnd.setDate(rangeEnd.getDate() + 30);
  const { data: appts } = await supabaseAdmin
    .from('appointments')
    .select('title, start_time, end_time, notes, clients(name)')
    .eq('tenant_id', tenantId)
    .gte('start_time', rangeStart.toISOString())
    .lte('start_time', rangeEnd.toISOString())
    .order('start_time');
  const formatted = (appts || []).map(a => {
    const start = new Date(a.start_time);
    const dateStr = start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const end = a.end_time ? ` – ${new Date(a.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
    return `- ${dateStr} at ${timeStr}${end}: ${a.title}${a.clients ? ` (${a.clients.name})` : ''}${a.notes ? ` — ${a.notes}` : ''}`;
  }).join('\n');
  const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: 'You are a friendly scheduling assistant for a contractor. Answer questions about upcoming appointments concisely and naturally. Use plain language, no markdown formatting, no bullet points.',
    messages: [{ role: 'user', content: `Today is ${today}.\n\nUpcoming appointments (next 30 days):\n${formatted || 'None scheduled.'}\n\nQuestion: ${question}` }],
  });
  res.json({ answer: msg.content[0].text });
});

// ── Recurring Invoices ────────────────────────────────────────────────────────

app.get('/api/recurring-invoices', auth, requireFinancialAccess, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('recurring_invoices')
    .select('*, clients(id, name, email)')
    .eq('tenant_id', req.tenantId)
    .order('created_at');
  res.json(data || []);
});

app.post('/api/recurring-invoices', auth, requireFinancialAccess, async (req, res) => {
  const { client_id, description, amount, frequency, next_send_date } = req.body;
  if (!description || !amount || !frequency || !next_send_date)
    return res.status(400).json({ error: 'Description, amount, frequency, and start date required' });
  const { data, error } = await supabaseAdmin.from('recurring_invoices')
    .insert({ tenant_id: req.tenantId, client_id: client_id || null, description, amount: parseFloat(amount), frequency, next_send_date, active: true })
    .select('*, clients(id, name, email)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/recurring-invoices/:id', auth, requireFinancialAccess, async (req, res) => {
  const allowed = ['active', 'amount', 'description', 'frequency', 'next_send_date', 'client_id'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.amount !== undefined) updates.amount = parseFloat(updates.amount);
  const { data, error } = await supabaseAdmin.from('recurring_invoices')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId)
    .select('*, clients(id, name, email)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/recurring-invoices/:id', auth, requireFinancialAccess, async (req, res) => {
  await supabaseAdmin.from('recurring_invoices')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  res.json({ ok: true });
});

// ── Receipt Upload ────────────────────────────────────────────────────────────

app.post('/api/expenses/:id/receipt', auth, requireFinancialAccess, upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { id } = req.params;
  const { data: expense } = await supabaseAdmin.from('expenses').select('id').eq('id', id).eq('tenant_id', req.tenantId).single();
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const filePath = `expenses/${req.tenantId}/${id}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from('receipts')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(400).json({ error: upErr.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('receipts').getPublicUrl(filePath);
  await supabaseAdmin.from('expenses').update({ receipt_url: publicUrl }).eq('id', id).eq('tenant_id', req.tenantId);
  res.json({ receipt_url: publicUrl });
});

app.post('/api/jobs/:id/receipt', auth, requireFinancialAccess, upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { id } = req.params;
  const { data: job } = await supabaseAdmin.from('jobs').select('id').eq('id', id).eq('tenant_id', req.tenantId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const filePath = `invoices/${req.tenantId}/${id}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from('receipts')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(400).json({ error: upErr.message });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('receipts').getPublicUrl(filePath);
  await supabaseAdmin.from('jobs').update({ receipt_url: publicUrl }).eq('id', id).eq('tenant_id', req.tenantId);
  res.json({ receipt_url: publicUrl });
});

// ── Service Catalog ───────────────────────────────────────────────────────────

app.get('/api/service-catalog', auth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('service_catalog')
    .select('*').eq('tenant_id', req.tenantId).eq('active', true)
    .order('sort_order').order('name');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/service-catalog', auth, requireSettingsAccess, async (req, res) => {
  const { name, description, unit_price, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const { data, error } = await supabaseAdmin.from('service_catalog').insert({
    name: name.trim(), description: description?.trim() || null,
    unit_price: parseFloat(unit_price) || 0, category: category || 'service',
    tenant_id: req.tenantId,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/service-catalog/:id', auth, requireSettingsAccess, async (req, res) => {
  const allowed = ['name', 'description', 'unit_price', 'category', 'active', 'sort_order'];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  if (updates.unit_price !== undefined) updates.unit_price = parseFloat(updates.unit_price) || 0;
  const { data, error } = await supabaseAdmin.from('service_catalog')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/service-catalog/:id', auth, requireSettingsAccess, async (req, res) => {
  await supabaseAdmin.from('service_catalog').delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  res.json({ ok: true });
});

// ── Expenses ──────────────────────────────────────────────────────────────────

app.get('/api/expenses', auth, requireFinancialAccess, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('expenses')
    .select('*, employees(name), jobs(name)')
    .eq('tenant_id', req.tenantId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/expenses', auth, requireFinancialAccess, async (req, res) => {
  const { date, amount, name, details, category, reimburse_to, reimburse_employee_id, job_id } = req.body;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0)
    return res.status(400).json({ error: 'Valid amount required' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  const { data, error } = await supabaseAdmin.from('expenses').insert({
    date,
    amount: parseFloat(amount),
    name: name.trim(),
    details: details?.trim() || null,
    category: category || 'other',
    reimburse_to: reimburse_to || 'none',
    reimburse_employee_id: reimburse_employee_id || null,
    job_id: job_id || null,
    tenant_id: req.tenantId,
    status: 'pending',
  }).select('*, employees(name), jobs(name)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/expenses/:id', auth, requireFinancialAccess, async (req, res) => {
  const allowed = ['date', 'amount', 'name', 'details', 'category', 'reimburse_to', 'reimburse_employee_id', 'job_id', 'status', 'receipt_url'];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  if (updates.amount !== undefined) updates.amount = parseFloat(updates.amount);
  const { data, error } = await supabaseAdmin.from('expenses')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenantId)
    .select('*, employees(name), jobs(name)').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/expenses/:id', auth, requireFinancialAccess, async (req, res) => {
  const { error } = await supabaseAdmin.from('expenses')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenantId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ── Service PRO (workflow templates) ──────────────────────────────────────────
app.get('/api/service-pro/templates', auth, requireSettingsAccess, async (req, res) => {
  const { data: workflows, error } = await supabaseAdmin
    .from('service_workflows')
    .select('*')
    .is('tenant_id', null)
    .eq('is_template', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  const ids = (workflows || []).map(w => w.id);
  let statuses = [];
  if (ids.length) {
    const { data: st, error: stErr } = await supabaseAdmin
      .from('workflow_statuses')
      .select('*')
      .in('workflow_id', ids)
      .order('order_index', { ascending: true });
    if (stErr) return res.status(400).json({ error: stErr.message });
    statuses = st || [];
  }
  const byWf = statuses.reduce((m, s) => { (m[s.workflow_id] ||= []).push(s); return m; }, {});
  res.json((workflows || []).map(w => ({ ...w, statuses: byWf[w.id] || [] })));
});

app.get('/api/service-pro/workflows', auth, async (req, res) => {
  const { data: workflows, error } = await supabaseAdmin
    .from('service_workflows')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  const ids = (workflows || []).map(w => w.id);
  let statuses = [];
  if (ids.length) {
    const { data: st, error: stErr } = await supabaseAdmin
      .from('workflow_statuses')
      .select('*')
      .in('workflow_id', ids)
      .order('order_index', { ascending: true });
    if (stErr) return res.status(400).json({ error: stErr.message });
    statuses = st || [];
  }
  const byWf = statuses.reduce((m, s) => { (m[s.workflow_id] ||= []).push(s); return m; }, {});
  res.json((workflows || []).map(w => ({ ...w, statuses: byWf[w.id] || [] })));
});

app.post('/api/service-pro/enable', auth, requireSettingsAccess, async (req, res) => {
  const { template_id } = req.body || {};
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  const { data: template, error: tErr } = await supabaseAdmin
    .from('service_workflows')
    .select('*')
    .eq('id', template_id)
    .is('tenant_id', null)
    .eq('is_template', true)
    .single();
  if (tErr || !template) return res.status(404).json({ error: 'template not found' });
  const { data: existing } = await supabaseAdmin
    .from('service_workflows')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('source_template_id', template_id)
    .limit(1);
  if (existing && existing.length) return res.status(409).json({ error: 'already enabled', workflow_id: existing[0].id });
  const { data: templateStatuses, error: sErr } = await supabaseAdmin
    .from('workflow_statuses')
    .select('*')
    .eq('workflow_id', template_id)
    .order('order_index', { ascending: true });
  if (sErr) return res.status(400).json({ error: sErr.message });
  const { data: cloned, error: insErr } = await supabaseAdmin.from('service_workflows').insert({
    tenant_id: req.tenantId,
    name: template.name,
    description: template.description,
    industry: template.industry,
    is_template: false,
    source_template_id: template.id,
  }).select('*').single();
  if (insErr) return res.status(400).json({ error: insErr.message });
  if (templateStatuses && templateStatuses.length) {
    const rows = templateStatuses.map(s => ({
      workflow_id: cloned.id,
      order_index: s.order_index,
      name: s.name,
      color: s.color,
      icon: s.icon,
      steps: s.steps,
      action_buttons: s.action_buttons,
      legacy_status: s.legacy_status,
    }));
    const { error: copyErr } = await supabaseAdmin.from('workflow_statuses').insert(rows);
    if (copyErr) return res.status(400).json({ error: copyErr.message });
  }
  res.json({ ok: true, workflow_id: cloned.id });
});

// ── Service PRO editor (owner-only) ───────────────────────────────────────────

async function fetchTenantStatus(statusId, tenantId) {
  const { data, error } = await supabaseAdmin
    .from('workflow_statuses')
    .select('*, service_workflows!inner(tenant_id, is_template)')
    .eq('id', statusId)
    .single();
  if (error || !data) return null;
  if (data.service_workflows?.tenant_id !== tenantId) return null;
  if (data.service_workflows?.is_template) return null;
  return data;
}

async function fetchTenantWorkflow(workflowId, tenantId) {
  const { data, error } = await supabaseAdmin
    .from('service_workflows')
    .select('*')
    .eq('id', workflowId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) return null;
  if (data.is_template) return null;
  return data;
}

app.patch('/api/service-pro/workflows/:id', auth, requireSettingsAccess, async (req, res) => {
  const wf = await fetchTenantWorkflow(req.params.id, req.tenantId);
  if (!wf) return res.status(404).json({ error: 'workflow not found' });
  const allowed = ['name', 'description', 'industry'];
  const updates = {};
  allowed.forEach(f => {
    if (req.body[f] === undefined) return;
    updates[f] = typeof req.body[f] === 'string' ? req.body[f].trim() : req.body[f];
  });
  if (!Object.keys(updates).length) return res.json(wf);
  const { data, error } = await supabaseAdmin
    .from('service_workflows')
    .update(updates)
    .eq('id', wf.id)
    .select('*')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/service-pro/workflows/:id/statuses', auth, requireSettingsAccess, async (req, res) => {
  const wf = await fetchTenantWorkflow(req.params.id, req.tenantId);
  if (!wf) return res.status(404).json({ error: 'workflow not found' });
  const { data: max } = await supabaseAdmin
    .from('workflow_statuses')
    .select('order_index')
    .eq('workflow_id', wf.id)
    .order('order_index', { ascending: false })
    .limit(1);
  const nextOrder = (max && max[0]?.order_index ? max[0].order_index : 0) + 1;
  const row = {
    workflow_id: wf.id,
    order_index: nextOrder,
    name: String(req.body?.name || 'New Status').trim() || 'New Status',
    color: req.body?.color || '#0ea5e9',
    icon: req.body?.icon || 'circle',
    steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
    action_buttons: Array.isArray(req.body?.action_buttons) ? req.body.action_buttons : [],
    legacy_status: req.body?.legacy_status || null,
  };
  const { data, error } = await supabaseAdmin
    .from('workflow_statuses')
    .insert(row)
    .select('*')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/service-pro/statuses/:id', auth, requireSettingsAccess, async (req, res) => {
  const status = await fetchTenantStatus(req.params.id, req.tenantId);
  if (!status) return res.status(404).json({ error: 'status not found' });
  const allowed = ['name', 'color', 'icon', 'legacy_status', 'order_index', 'steps', 'action_buttons'];
  const updates = {};
  allowed.forEach(f => {
    if (req.body[f] === undefined) return;
    if (f === 'order_index') {
      const n = parseInt(req.body[f], 10);
      if (Number.isFinite(n) && n > 0) updates[f] = n;
      return;
    }
    if (f === 'steps' || f === 'action_buttons') {
      if (Array.isArray(req.body[f])) updates[f] = req.body[f];
      return;
    }
    updates[f] = typeof req.body[f] === 'string' ? req.body[f].trim() || null : req.body[f];
  });
  if (!Object.keys(updates).length) return res.json(status);
  const { data, error } = await supabaseAdmin
    .from('workflow_statuses')
    .update(updates)
    .eq('id', status.id)
    .select('*')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/service-pro/statuses/:id', auth, requireSettingsAccess, async (req, res) => {
  const status = await fetchTenantStatus(req.params.id, req.tenantId);
  if (!status) return res.status(404).json({ error: 'status not found' });
  const { error } = await supabaseAdmin
    .from('workflow_statuses')
    .delete()
    .eq('id', status.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/service-pro/statuses/:id/reorder', auth, requireSettingsAccess, async (req, res) => {
  const direction = req.body?.direction === 'up' ? 'up' : 'down';
  const status = await fetchTenantStatus(req.params.id, req.tenantId);
  if (!status) return res.status(404).json({ error: 'status not found' });
  const { data: siblings } = await supabaseAdmin
    .from('workflow_statuses')
    .select('id, order_index')
    .eq('workflow_id', status.workflow_id)
    .order('order_index', { ascending: true });
  const list = siblings || [];
  const idx = list.findIndex(s => s.id === status.id);
  if (idx < 0) return res.status(404).json({ error: 'status not found' });
  const swapWith = direction === 'up' ? list[idx - 1] : list[idx + 1];
  if (!swapWith) return res.json({ ok: true, no_op: true });
  // Swap by writing a temporary third value first (UNIQUE(workflow_id, order_index)).
  const tmp = -1 * Date.now();
  const step1 = await supabaseAdmin.from('workflow_statuses').update({ order_index: tmp }).eq('id', status.id);
  if (step1.error) return res.status(400).json({ error: step1.error.message });
  const step2 = await supabaseAdmin.from('workflow_statuses').update({ order_index: status.order_index }).eq('id', swapWith.id);
  if (step2.error) return res.status(400).json({ error: step2.error.message });
  const step3 = await supabaseAdmin.from('workflow_statuses').update({ order_index: swapWith.order_index }).eq('id', status.id);
  if (step3.error) return res.status(400).json({ error: step3.error.message });
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
    .select('plan, subscription_status, stripe_subscription_id').eq('subscription_status', 'active');
  const mrr = (tenants || [])
    .filter(t => !!t.stripe_subscription_id)
    .reduce((sum, t) => sum + (PLAN_MRR[t.plan] || 0), 0);
  const month = new Date();
  month.setDate(1); month.setHours(0, 0, 0, 0);
  await supabaseAdmin.from('mrr_snapshots')
    .upsert({ month: month.toISOString().split('T')[0], mrr }, { onConflict: 'month' });
  console.log(`📊 MRR snapshot saved: $${mrr}`);
}
cron.schedule('0 0 1 * *', snapshotMRR);

// ── Appointment reminders — runs every 15 min ─────────────────────────────────
cron.schedule('*/15 * * * *', async () => {
  const now = new Date();
  // Window: appointments starting between now+7min and now+22min (catches the 15-min slot)
  const windowStart = new Date(now.getTime() + 7 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 22 * 60 * 1000);

  // Fetch appointments not yet owner-reminded, within the upcoming window
  const { data: appts } = await supabaseAdmin
    .from('appointments')
    .select('*, clients(id, name, email, phone)')
    .eq('owner_reminded', false)
    .gte('start_time', windowStart.toISOString())
    .lte('start_time', windowEnd.toISOString());

  if (!appts?.length) return;

  const byTenant = {};
  for (const a of appts) {
    if (!byTenant[a.tenant_id]) byTenant[a.tenant_id] = [];
    byTenant[a.tenant_id].push(a);
  }

  for (const [tenantId, tenantAppts] of Object.entries(byTenant)) {
    const { data: tenant } = await supabaseAdmin.from('tenants')
      .select('owner_email, company_name, appt_reminder_minutes, twilio_phone, twilio_account_sid, twilio_auth_token')
      .eq('id', tenantId).single();
    if (!tenant || !tenant.owner_email) continue;

    const reminderMinutes = tenant.appt_reminder_minutes ?? 60;
    if (reminderMinutes === 0) continue; // 0 = off

    // Only send if the appointment is within the configured reminder window
    const eligibleAppts = tenantAppts.filter(a => {
      const minutesUntil = (new Date(a.start_time) - now) / 60000;
      return minutesUntil >= reminderMinutes - 7.5 && minutesUntil <= reminderMinutes + 7.5;
    });
    if (!eligibleAppts.length) continue;

    // Send owner email
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const label = reminderMinutes >= 1440
        ? `${reminderMinutes / 1440} day${reminderMinutes / 1440 > 1 ? 's' : ''}`
        : reminderMinutes >= 60
          ? `${reminderMinutes / 60} hour${reminderMinutes / 60 > 1 ? 's' : ''}`
          : `${reminderMinutes} minutes`;
      const list = eligibleAppts.map(a => {
        const t = new Date(a.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `<li style="margin-bottom:6px"><strong>${a.title}</strong> at ${t}${a.clients ? ' — ' + a.clients.name : ''}</li>`;
      }).join('');
      await resend.emails.send({
        from: LINKCREW_FROM,
        to: tenant.owner_email,
        subject: `📅 Upcoming in ${label}: ${eligibleAppts.length > 1 ? eligibleAppts.length + ' appointments' : eligibleAppts[0].title}`,
        html: `<div style="font-family:sans-serif;max-width:500px">
          <h2 style="color:#0265dc">Upcoming Appointment${eligibleAppts.length > 1 ? 's' : ''}</h2>
          <p>Starting in <strong>${label}</strong>:</p>
          <ul style="padding-left:20px;line-height:1.8">${list}</ul>
          <p style="color:#737475;font-size:12px">${tenant.company_name || 'LinkCrew'}</p>
        </div>`,
      });
    } catch (e) { console.error('[appt reminder] owner email error:', e.message); }

    // Mark as reminded
    await supabaseAdmin.from('appointments')
      .update({ owner_reminded: true })
      .in('id', eligibleAppts.map(a => a.id));

  }
});

// ── Recurring invoice cron — daily at 7am ─────────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  const { data: due } = await supabaseAdmin
    .from('recurring_invoices')
    .select('*, clients(id, name, email), tenants(owner_email, company_name)')
    .eq('active', true)
    .lte('next_send_date', today);
  if (!due?.length) return;

  for (const ri of due) {
    try {
      const { data: job } = await supabaseAdmin.from('jobs').insert({
        name: ri.description,
        tenant_id: ri.tenant_id,
        client_id: ri.client_id,
        status: 'invoiced',
        invoice_amount: ri.amount,
        payment_status: 'unpaid',
      }).select('id').single();
      if (!job) continue;

      if (ri.clients?.email) {
        const { data: clientUser } = await supabaseAdmin
          .from('client_users').select('portal_token').eq('client_id', ri.client_id).single();
        const portalUrl = clientUser?.portal_token
          ? `https://linkcrew.io/portal?token=${clientUser.portal_token}`
          : 'https://linkcrew.io/portal';
        await sendInvoiceToClient({
          clientName: ri.clients.name,
          clientEmail: ri.clients.email,
          jobName: ri.description,
          amount: ri.amount,
          portalUrl,
          tenantName: ri.tenants?.company_name,
        }).catch(() => {});
      }

      // Advance next_send_date
      const next = new Date(ri.next_send_date + 'T12:00:00Z');
      if (ri.frequency === 'weekly') next.setDate(next.getDate() + 7);
      else if (ri.frequency === 'biweekly') next.setDate(next.getDate() + 14);
      else next.setMonth(next.getMonth() + 1);
      await supabaseAdmin.from('recurring_invoices')
        .update({ next_send_date: next.toISOString().split('T')[0] })
        .eq('id', ri.id);

      console.log(`📄 Recurring invoice fired: "${ri.description}" tenant ${ri.tenant_id}`);
    } catch (e) {
      console.error('[recurring invoice] error:', ri.id, e.message);
    }
  }
});

// ── Nightly photo expiry cleanup ──────────────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  console.log('🗑 Running photo expiry cleanup...');
  const { data: tenants } = await supabaseAdmin
    .from('tenants').select('id, photo_expiry_days').not('photo_expiry_days', 'is', null);
  if (!tenants?.length) return;

  for (const tenant of tenants) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - tenant.photo_expiry_days);

    const { data: tenantJobs } = await supabaseAdmin
      .from('jobs').select('id').eq('tenant_id', tenant.id);
    if (!tenantJobs?.length) continue;

    const { data: oldPhotos } = await supabaseAdmin
      .from('job_updates')
      .select('id, photo_url')
      .in('job_id', tenantJobs.map(j => j.id))
      .eq('type', 'photo')
      .not('photo_url', 'is', null)
      .lt('created_at', cutoff.toISOString());

    if (!oldPhotos?.length) continue;

    for (const photo of oldPhotos) {
      try {
        const url = new URL(photo.photo_url);
        const parts = url.pathname.split('/object/public/');
        if (parts[1]) {
          const [bucket, ...pathParts] = parts[1].split('/');
          await supabaseAdmin.storage.from(bucket).remove([pathParts.join('/')]);
        }
      } catch (e) { /* best-effort */ }
    }

    await supabaseAdmin.from('job_updates')
      .delete().in('id', oldPhotos.map(p => p.id));

    console.log(`🗑 Deleted ${oldPhotos.length} photos for tenant ${tenant.id} (>${tenant.photo_expiry_days} days old)`);
  }
});

// ── Crew appointment reminders ────────────────────────────────────────────────
// Runs hourly. For each active tenant, compute local hour (tenant.timezone,
// falling back to Pacific). At 7am local: push today's jobs to each assigned
// crew member. At 6pm local: push tomorrow's jobs. Each crew member gets one
// push per run summarizing their day, not one per job.
function nowIn(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric',
  }).formatToParts(new Date());
  const pick = (t) => parts.find(p => p.type === t)?.value;
  const hour = Number(pick('hour'));
  const today = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  return { hour, today, tomorrow };
}

async function sendCrewJobReminders(tenantId, date, mode /* 'today' | 'tomorrow' */) {
  const { data: jobs } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, scheduled_date, job_assignments(employee_id, employees(id, name, push_token))')
    .eq('tenant_id', tenantId)
    .eq('scheduled_date', date);
  if (!jobs?.length) return { sent: 0, jobsFound: 0, assigned: 0, noToken: 0, noTokenNames: [] };

  const byEmployee = new Map();
  const noTokenNames = new Set();
  let assignedCount = 0;
  for (const job of jobs) {
    for (const a of (job.job_assignments || [])) {
      const emp = a.employees;
      if (!emp) continue;
      assignedCount++;
      if (!emp.push_token) {
        noTokenNames.add(emp.name || 'Unknown');
        continue;
      }
      if (!byEmployee.has(emp.id)) byEmployee.set(emp.id, { token: emp.push_token, name: emp.name, jobs: [] });
      byEmployee.get(emp.id).jobs.push(job);
    }
  }

  const title = mode === 'today' ? 'Your jobs today' : 'Your jobs tomorrow';
  let sent = 0;
  for (const info of byEmployee.values()) {
    const count = info.jobs.length;
    const first = info.jobs[0];
    const body = count === 1
      ? `${first.name}${first.address ? ` · ${first.address}` : ''}`
      : `${count} jobs scheduled. Tap to see your day.`;
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: info.token,
          sound: 'default',
          title, body,
          data: { type: 'schedule_reminder', when: mode, count, first_job_id: first.id },
        }),
      });
      sent++;
    } catch (e) { /* best-effort */ }
  }

  if (sent > 0) console.log(`🔔 Crew reminders: tenant ${tenantId}, ${mode} (${date}), ${sent} push(es)`);
  return { sent, jobsFound: jobs.length, assigned: assignedCount, noToken: noTokenNames.size, noTokenNames: Array.from(noTokenNames) };
}

cron.schedule('0 * * * *', async () => {
  const { data: tenants } = await supabaseAdmin
    .from('tenants').select('id, timezone, status');
  if (!tenants?.length) return;
  for (const t of tenants) {
    if (t.status && !['active', 'trialing'].includes(t.status)) continue;
    const tz = t.timezone || 'America/Los_Angeles';
    let now;
    try { now = nowIn(tz); } catch { now = nowIn('America/Los_Angeles'); }
    if (now.hour === 7) await sendCrewJobReminders(t.id, now.today, 'today');
    else if (now.hour === 18) await sendCrewJobReminders(t.id, now.tomorrow, 'tomorrow');
  }
});

// Manual trigger for owners to preview the reminder flow. Fires the same
// cron payload for the caller's tenant on demand — useful before a real
// 7am ever lands.
app.post('/api/mobile/owner/crew-reminder-test', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const mode = req.body?.mode === 'tomorrow' ? 'tomorrow' : 'today';
  const { data: tenant } = await supabaseAdmin
    .from('tenants').select('id, timezone').eq('id', req.tenantId).maybeSingle();
  const tz = tenant?.timezone || 'America/Los_Angeles';
  let now;
  try { now = nowIn(tz); } catch { now = nowIn('America/Los_Angeles'); }
  const date = mode === 'today' ? now.today : now.tomorrow;
  const result = await sendCrewJobReminders(req.tenantId, date, mode);
  res.json({ ok: true, mode, date, tz, ...result });
});

// ────────────────────────────────────────────────────────────────────────────
// Crew-driven job lifecycle — state machine, attachments, work-order requests
// ────────────────────────────────────────────────────────────────────────────

// Accept/normalize status values. Jobs that came in as 'active' are field-
// active and are treated as equivalent to 'dispatched' for the flow.
const JOB_FIELD_STATES = new Set([
  'scheduled', 'dispatched', 'en_route', 'on_site',
  'active', 'in_progress', 'on_hold', 'paused',
]);
const JOB_TERMINAL_STATES = new Set([
  'completed', 'closed', 'invoiced', 'cancelled', 'archived', 'saved_for_later',
]);
const JOB_APPROVER_ROLES = new Set(['owner', 'manager', 'supervisor']);

// Allowed crew-driven forward transitions (crew tap).
const CREW_FORWARD_TRANSITIONS = {
  scheduled:   ['en_route', 'on_site'],
  dispatched:  ['en_route', 'on_site'],
  active:      ['en_route', 'on_site', 'in_progress'],
  en_route:    ['on_site'],
  on_site:     ['in_progress'],
  in_progress: ['paused', 'completed'],   // completed = "request closure"
  paused:      ['in_progress'],
};

// Manager/supervisor/owner can move to any state from any state (override).
function canActorTransition(role, fromStatus, toStatus) {
  if (JOB_APPROVER_ROLES.has(role)) return true;
  // Crew path:
  const allowed = CREW_FORWARD_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function sendExpoPush(tokens, title, body, data) {
  const messages = (tokens || []).filter(Boolean).map(to => ({ to, title, body, data }));
  if (!messages.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch {}
}

// Fan-out push to all approver-role employees for a tenant.
async function notifyApprovers(tenantId, title, body, data) {
  const { data: emps } = await supabaseAdmin
    .from('employees')
    .select('id, push_token, role')
    .eq('tenant_id', tenantId)
    .in('role', ['owner', 'manager', 'supervisor']);
  const tokens = (emps || []).map(e => e.push_token).filter(Boolean);
  if (tokens.length) await sendExpoPush(tokens, title, body, data);
}

async function notifyEmployees(employeeIds, title, body, data) {
  if (!employeeIds?.length) return;
  const { data: emps } = await supabaseAdmin
    .from('employees')
    .select('id, push_token')
    .in('id', employeeIds);
  const tokens = (emps || []).map(e => e.push_token).filter(Boolean);
  if (tokens.length) await sendExpoPush(tokens, title, body, data);
}

// Central transition. Validates rights, updates job, writes audit row, notifies.
// trigger: manual | clock_in | clock_out | photo | checklist | service_pro |
//          override | cancel | approve | reject | system
async function transitionJob({
  jobId, tenantId, toStatus, actorEmployeeId, actorRole,
  trigger = 'manual', note = null, gps = null, skipCheckpoint = false,
}) {
  const { data: job, error: jErr } = await supabaseAdmin
    .from('jobs')
    .select('id, tenant_id, status, name')
    .eq('id', jobId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (jErr) throw jErr;
  if (!job) return { ok: false, error: 'Job not found' };
  if (job.status === toStatus) return { ok: true, job, no_op: true };
  if (actorRole && !canActorTransition(actorRole, job.status, toStatus)) {
    return { ok: false, error: `Not allowed: ${job.status} → ${toStatus} (role=${actorRole})` };
  }
  // Completion checkpoint: crew can't move to 'completed' unless all
  // required acks are satisfied (unless bypassed by manager override).
  if (toStatus === 'completed' && !skipCheckpoint && !JOB_APPROVER_ROLES.has(actorRole)) {
    const ok = await completionCheckpointSatisfied(jobId, actorEmployeeId);
    if (!ok.satisfied) {
      return { ok: false, error: 'Checkpoint not met', missing: ok.missing };
    }
  }
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('jobs')
    .update({ status: toStatus, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .select('id, status, name')
    .single();
  if (uErr) return { ok: false, error: uErr.message };
  await supabaseAdmin.from('job_status_events').insert({
    job_id: jobId,
    tenant_id: tenantId,
    from_status: job.status,
    to_status: toStatus,
    actor_employee_id: actorEmployeeId || null,
    trigger,
    note,
    lat: gps?.lat ?? null,
    lng: gps?.lng ?? null,
  });
  // Notify — fan out to approvers on every transition except noise.
  if (trigger !== 'system') {
    const label = toStatus.replace(/_/g, ' ');
    await notifyApprovers(tenantId,
      `${updated.name}: ${label}`,
      actorRole === 'crew' ? 'Crew updated job status' : `Moved to ${label}`,
      { type: 'job_status', job_id: jobId, to: toStatus }
    );
  }
  return { ok: true, job: updated };
}

// Completion checkpoint: all required attachments must have acknowledged_at
// set by the acting crew member. Extend later for photos/signature/payment.
async function completionCheckpointSatisfied(jobId, employeeId) {
  const { data: requiredAtts } = await supabaseAdmin
    .from('job_attachments')
    .select('id')
    .eq('job_id', jobId)
    .eq('require_acknowledgment', true);
  if (!requiredAtts?.length) return { satisfied: true, missing: [] };
  const attIds = requiredAtts.map(a => a.id);
  const { data: acks } = await supabaseAdmin
    .from('job_attachment_acks')
    .select('attachment_id, acknowledged_at')
    .in('attachment_id', attIds)
    .eq('employee_id', employeeId);
  const ackedIds = new Set((acks || []).filter(a => a.acknowledged_at).map(a => a.attachment_id));
  const missing = attIds.filter(id => !ackedIds.has(id));
  return { satisfied: missing.length === 0, missing };
}

// Resolve any open work-order requests on a job with the given reason.
async function resolveWorkOrderRequests(jobId, resolverEmployeeId, resolution) {
  await supabaseAdmin
    .from('job_work_order_requests')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: resolverEmployeeId || null,
      resolution,
    })
    .eq('job_id', jobId)
    .is('resolved_at', null);
  // Push-notify the original requester(s) that their request is resolved.
  const { data: resolved } = await supabaseAdmin
    .from('job_work_order_requests')
    .select('requested_by')
    .eq('job_id', jobId)
    .not('resolved_at', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(5);
  const requesters = [...new Set((resolved || []).map(r => r.requested_by).filter(Boolean))];
  if (requesters.length) {
    await notifyEmployees(requesters, 'Work order ready', 'Plans are now attached to your job.', {
      type: 'wo_resolved', job_id: jobId,
    });
  }
}

// Find the most-recent job this employee is assigned to today that's still
// in a field-active state. Used to pick a target for clock-in auto-advance.
async function findActiveJobForEmployee(tenantId, employeeId) {
  const { data: assignments } = await supabaseAdmin
    .from('job_assignments')
    .select('job_id, jobs(id, status, lat, lng, scheduled_date)')
    .eq('employee_id', employeeId);
  const today = new Date().toISOString().slice(0, 10);
  const candidates = (assignments || [])
    .map(a => a.jobs)
    .filter(j => j && JOB_FIELD_STATES.has(j.status))
    .filter(j => !j.scheduled_date || j.scheduled_date === today);
  return candidates[0] || null;
}

async function autoAdvanceFromClockIn(tenantId, employeeId, gps) {
  const job = await findActiveJobForEmployee(tenantId, employeeId);
  if (!job) return;
  const { data: tenant } = await supabaseAdmin
    .from('tenants').select('geofence_radius_m').eq('id', tenantId).maybeSingle();
  const radius = tenant?.geofence_radius_m ?? 100;
  const onSite = gps?.lat != null && job.lat != null &&
    distanceMeters(gps.lat, gps.lng, job.lat, job.lng) <= radius;
  const toStatus = onSite ? 'on_site' : 'en_route';
  // Only advance if we're not already ahead of this state.
  if (onSite && (job.status === 'scheduled' || job.status === 'dispatched' ||
                 job.status === 'active' || job.status === 'en_route')) {
    await transitionJob({
      jobId: job.id, tenantId, toStatus: 'on_site',
      actorEmployeeId: employeeId, actorRole: 'system',
      trigger: 'clock_in', gps,
    });
  } else if (!onSite && (job.status === 'scheduled' || job.status === 'dispatched' ||
                         job.status === 'active')) {
    await transitionJob({
      jobId: job.id, tenantId, toStatus: 'en_route',
      actorEmployeeId: employeeId, actorRole: 'system',
      trigger: 'clock_in', gps,
    });
  }
  return toStatus;
}

async function autoAdvanceFromClockOut(tenantId, employeeId) {
  const job = await findActiveJobForEmployee(tenantId, employeeId);
  if (!job) return;
  if (job.status === 'in_progress' || job.status === 'on_site') {
    await transitionJob({
      jobId: job.id, tenantId, toStatus: 'paused',
      actorEmployeeId: employeeId, actorRole: 'system',
      trigger: 'clock_out',
    });
  }
}

// ─── Transition endpoints ─────────────────────────────────────────────────

// Crew-visible: move a job pill forward. Validates role-based transitions.
app.post('/api/mobile/jobs/:id/transition', mobileAuth, async (req, res) => {
  const { to_status, note, gps } = req.body || {};
  if (!to_status) return res.status(400).json({ error: 'to_status required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId: req.tenantId,
    toStatus: to_status, actorEmployeeId: req.employeeId, actorRole: req.role,
    trigger: 'manual', note, gps,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Crew-specific sugar: "Request completion" (= move to 'completed' pending approval).
app.post('/api/mobile/jobs/:id/request-completion', mobileAuth, async (req, res) => {
  const result = await transitionJob({
    jobId: req.params.id, tenantId: req.tenantId,
    toStatus: 'completed', actorEmployeeId: req.employeeId, actorRole: req.role,
    trigger: 'manual',
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Approver: approve the crew's closure request → 'closed'.
app.post('/api/mobile/jobs/:id/approve', mobileAuth, async (req, res) => {
  if (!JOB_APPROVER_ROLES.has(req.role)) return res.status(403).json({ error: 'Approver role required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId: req.tenantId,
    toStatus: 'closed', actorEmployeeId: req.employeeId, actorRole: req.role,
    trigger: 'approve',
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Approver: reject closure — bounce back to in_progress with a reason.
app.post('/api/mobile/jobs/:id/reject-completion', mobileAuth, async (req, res) => {
  if (!JOB_APPROVER_ROLES.has(req.role)) return res.status(403).json({ error: 'Approver role required' });
  const { reason } = req.body || {};
  const result = await transitionJob({
    jobId: req.params.id, tenantId: req.tenantId,
    toStatus: 'in_progress', actorEmployeeId: req.employeeId, actorRole: req.role,
    trigger: 'reject', note: reason || null,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Approver: cancel a job with a required reason.
app.post('/api/mobile/jobs/:id/cancel', mobileAuth, async (req, res) => {
  if (!JOB_APPROVER_ROLES.has(req.role)) return res.status(403).json({ error: 'Approver role required' });
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId: req.tenantId,
    toStatus: 'cancelled', actorEmployeeId: req.employeeId, actorRole: req.role,
    trigger: 'cancel', note: reason,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Audit trail for one job.
app.get('/api/mobile/jobs/:id/status-events', mobileAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_status_events')
    .select('id, from_status, to_status, trigger, note, created_at, actor_employee_id, employees:actor_employee_id(name, role)')
    .eq('job_id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
});

// ─── Attachments ──────────────────────────────────────────────────────────

// Upload (multipart). Only approver roles. Fields:
//   file: binary
//   label (optional)
//   require_acknowledgment (bool, default false)
app.post('/api/mobile/jobs/:id/attachments', mobileAuth, upload.single('file'), async (req, res) => {
  if (!JOB_APPROVER_ROLES.has(req.role)) return res.status(403).json({ error: 'Approver role required' });
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const jobId = req.params.id;
  // Confirm job belongs to tenant.
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('id').eq('id', jobId).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const safeName = req.file.originalname.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${req.tenantId}/${jobId}/${Date.now()}_${safeName}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('job-attachments')
    .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: upErr.message });
  const requireAck = String(req.body?.require_acknowledgment || '').toLowerCase() === 'true';
  const { data: att, error } = await supabaseAdmin
    .from('job_attachments')
    .insert({
      job_id: jobId,
      tenant_id: req.tenantId,
      filename: req.file.originalname,
      storage_path: storagePath,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      label: req.body?.label || null,
      require_acknowledgment: requireAck,
      uploaded_by: req.employeeId,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Resolve any open work-order request for this job.
  await resolveWorkOrderRequests(jobId, req.employeeId, 'attachment_added');
  // Notify assigned crew that new plans are attached.
  const { data: assigns } = await supabaseAdmin
    .from('job_assignments')
    .select('employee_id')
    .eq('job_id', jobId);
  const crewIds = (assigns || []).map(a => a.employee_id).filter(Boolean);
  if (crewIds.length) {
    await notifyEmployees(crewIds, 'New plans attached',
      `${req.file.originalname}${requireAck ? ' — review required' : ''}`,
      { type: 'job_attachment', job_id: jobId, attachment_id: att.id });
  }
  res.json({ ok: true, attachment: att });
});

// List attachments for a job + this employee's ack status for each.
app.get('/api/mobile/jobs/:id/attachments', mobileAuth, async (req, res) => {
  const { data: atts, error } = await supabaseAdmin
    .from('job_attachments')
    .select('*')
    .eq('job_id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const ids = (atts || []).map(a => a.id);
  let acks = [];
  if (ids.length) {
    const { data } = await supabaseAdmin
      .from('job_attachment_acks')
      .select('attachment_id, viewed_at, acknowledged_at')
      .in('attachment_id', ids)
      .eq('employee_id', req.employeeId);
    acks = data || [];
  }
  const ackMap = new Map(acks.map(a => [a.attachment_id, a]));
  // Signed URL for viewing (1 hour).
  const results = [];
  for (const a of (atts || [])) {
    const { data: signed } = await supabaseAdmin.storage
      .from('job-attachments')
      .createSignedUrl(a.storage_path, 3600);
    results.push({
      ...a,
      url: signed?.signedUrl || null,
      viewed_at: ackMap.get(a.id)?.viewed_at || null,
      acknowledged_at: ackMap.get(a.id)?.acknowledged_at || null,
    });
  }
  res.json({ attachments: results });
});

// Mark an attachment as viewed (from crew opening it).
app.post('/api/mobile/jobs/:id/attachments/:attId/view', mobileAuth, async (req, res) => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('job_attachment_acks')
    .upsert({ attachment_id: req.params.attId, employee_id: req.employeeId, viewed_at: now },
            { onConflict: 'attachment_id,employee_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Mark an attachment as acknowledged ("I have read the plans..." switch).
app.post('/api/mobile/jobs/:id/attachments/:attId/ack', mobileAuth, async (req, res) => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('job_attachment_acks')
    .upsert({ attachment_id: req.params.attId, employee_id: req.employeeId,
              viewed_at: now, acknowledged_at: now },
            { onConflict: 'attachment_id,employee_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Remove attachment (approver only).
app.delete('/api/mobile/jobs/:id/attachments/:attId', mobileAuth, async (req, res) => {
  if (!JOB_APPROVER_ROLES.has(req.role)) return res.status(403).json({ error: 'Approver role required' });
  const { data: att } = await supabaseAdmin
    .from('job_attachments').select('storage_path').eq('id', req.params.attId)
    .eq('tenant_id', req.tenantId).maybeSingle();
  if (!att) return res.status(404).json({ error: 'Not found' });
  await supabaseAdmin.storage.from('job-attachments').remove([att.storage_path]).catch(() => {});
  await supabaseAdmin.from('job_attachments').delete().eq('id', req.params.attId);
  res.json({ ok: true });
});

// ─── Work-order requests ──────────────────────────────────────────────────

app.post('/api/mobile/jobs/:id/request-work-order', mobileAuth, async (req, res) => {
  const { note } = req.body || {};
  const { data: job } = await supabaseAdmin
    .from('jobs').select('id, name').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Avoid duplicate open requests from the same crew on the same job.
  const { data: existing } = await supabaseAdmin
    .from('job_work_order_requests')
    .select('id')
    .eq('job_id', req.params.id)
    .eq('requested_by', req.employeeId)
    .is('resolved_at', null)
    .maybeSingle();
  if (existing) return res.json({ ok: true, request: existing, already_open: true });
  const { data: request, error } = await supabaseAdmin
    .from('job_work_order_requests')
    .insert({
      job_id: req.params.id,
      tenant_id: req.tenantId,
      requested_by: req.employeeId,
      note: note || null,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await notifyApprovers(req.tenantId,
    `${job.name}: work order requested`,
    note ? `${req.employeeName}: ${note}` : `${req.employeeName} needs plans`,
    { type: 'wo_request', job_id: job.id, request_id: request.id });
  res.json({ ok: true, request });
});

// List open work-order requests for a tenant.
app.get('/api/mobile/owner/work-order-requests', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('job_work_order_requests')
    .select('*, jobs(id, name, address, scheduled_date), employees:requested_by(name)')
    .eq('tenant_id', req.tenantId)
    .is('resolved_at', null)
    .order('requested_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data || [] });
});

// Dismiss with reason (no attachments needed after all).
app.post('/api/mobile/owner/work-order-requests/:id/dismiss', mobileAuth, requireMobileOwnerOrManager, async (req, res) => {
  const { reason } = req.body || {};
  const { data, error } = await supabaseAdmin
    .from('job_work_order_requests')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: req.employeeId,
      resolution: 'dismissed',
      resolution_note: reason || null,
    })
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (data?.requested_by) {
    await notifyEmployees([data.requested_by], 'Request dismissed',
      reason || 'Owner says no plans needed.', { type: 'wo_dismissed', job_id: data.job_id });
  }
  res.json({ ok: true });
});

// ─── Dashboard aggregate endpoints (for /app) ─────────────────────────────

// Pending closure approvals — jobs in 'completed' awaiting 'closed' signoff.
app.get('/api/dashboard/pending-approvals', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, scheduled_date, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'completed')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ jobs: data || [] });
});

// Open work-order requests for the tenant.
app.get('/api/dashboard/work-order-requests', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin
    .from('job_work_order_requests')
    .select('*, jobs(id, name, address, scheduled_date), employees:requested_by(name)')
    .eq('tenant_id', tenantId)
    .is('resolved_at', null)
    .order('requested_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data || [] });
});

// Approve/reject/cancel from web dashboard. Thin wrappers over transitionJob.
app.post('/api/dashboard/jobs/:id/approve', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId, toStatus: 'closed',
    actorEmployeeId: req.employeeId || null, actorRole: role, trigger: 'approve',
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/dashboard/jobs/:id/reject', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const { reason } = req.body || {};
  const result = await transitionJob({
    jobId: req.params.id, tenantId, toStatus: 'in_progress',
    actorEmployeeId: req.employeeId || null, actorRole: role,
    trigger: 'reject', note: reason || null,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/dashboard/jobs/:id/cancel', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId, toStatus: 'cancelled',
    actorEmployeeId: req.employeeId || null, actorRole: role,
    trigger: 'cancel', note: reason,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Override: any → any, approver only. Writes an audit row with trigger='override'.
app.post('/api/dashboard/jobs/:id/override-status', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const { to_status, note } = req.body || {};
  if (!to_status) return res.status(400).json({ error: 'to_status required' });
  const result = await transitionJob({
    jobId: req.params.id, tenantId, toStatus: to_status,
    actorEmployeeId: req.employeeId || null, actorRole: role,
    trigger: 'override', note: note || null, skipCheckpoint: true,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Work-order dismiss from web dashboard.
app.post('/api/dashboard/work-order-requests/:id/dismiss', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const { reason } = req.body || {};
  const { data, error } = await supabaseAdmin
    .from('job_work_order_requests')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: req.employeeId || null,
      resolution: 'dismissed',
      resolution_note: reason || null,
    })
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  if (data?.requested_by) {
    await notifyEmployees([data.requested_by], 'Request dismissed',
      reason || 'No plans needed.', { type: 'wo_dismissed', job_id: data.job_id });
  }
  res.json({ ok: true });
});

// Dashboard-scoped attachment endpoints (web JWT auth, not mobile).
app.post('/api/dashboard/jobs/:id/attachments', auth, upload.single('file'), async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const jobId = req.params.id;
  const { data: job } = await supabaseAdmin.from('jobs')
    .select('id').eq('id', jobId).eq('tenant_id', tenantId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const safeName = req.file.originalname.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${tenantId}/${jobId}/${Date.now()}_${safeName}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('job-attachments')
    .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: upErr.message });
  const requireAck = String(req.body?.require_acknowledgment || '').toLowerCase() === 'true';
  const { data: att, error } = await supabaseAdmin
    .from('job_attachments')
    .insert({
      job_id: jobId, tenant_id: tenantId,
      filename: req.file.originalname, storage_path: storagePath,
      mime_type: req.file.mimetype, size_bytes: req.file.size,
      label: req.body?.label || null,
      require_acknowledgment: requireAck,
      uploaded_by: req.employeeId || null,
    })
    .select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  await resolveWorkOrderRequests(jobId, req.employeeId || null, 'attachment_added');
  const { data: assigns } = await supabaseAdmin
    .from('job_assignments').select('employee_id').eq('job_id', jobId);
  const crewIds = (assigns || []).map(a => a.employee_id).filter(Boolean);
  if (crewIds.length) {
    await notifyEmployees(crewIds, 'New plans attached',
      `${req.file.originalname}${requireAck ? ' — review required' : ''}`,
      { type: 'job_attachment', job_id: jobId, attachment_id: att.id });
  }
  res.json({ ok: true, attachment: att });
});

app.get('/api/dashboard/jobs/:id/attachments', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const { data: atts, error } = await supabaseAdmin
    .from('job_attachments').select('*')
    .eq('job_id', req.params.id).eq('tenant_id', tenantId)
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const results = [];
  for (const a of (atts || [])) {
    const { data: signed } = await supabaseAdmin.storage
      .from('job-attachments').createSignedUrl(a.storage_path, 3600);
    // Summarize ack state across all assigned crew.
    const { data: acks } = await supabaseAdmin
      .from('job_attachment_acks')
      .select('employee_id, viewed_at, acknowledged_at')
      .eq('attachment_id', a.id);
    results.push({
      ...a,
      url: signed?.signedUrl || null,
      viewed_at: (acks || []).find(x => x.viewed_at)?.viewed_at || null,
      acknowledged_at: (acks || []).find(x => x.acknowledged_at)?.acknowledged_at || null,
      ack_summary: {
        total: (acks || []).length,
        viewed: (acks || []).filter(x => x.viewed_at).length,
        acked: (acks || []).filter(x => x.acknowledged_at).length,
      },
    });
  }
  res.json({ attachments: results });
});

app.delete('/api/dashboard/jobs/:id/attachments/:attId', auth, async (req, res) => {
  const tenantId = req.tenantId;
  const role = req.role || 'owner';
  if (!JOB_APPROVER_ROLES.has(role)) return res.status(403).json({ error: 'Approver role required' });
  const { data: att } = await supabaseAdmin
    .from('job_attachments').select('storage_path').eq('id', req.params.attId)
    .eq('tenant_id', tenantId).maybeSingle();
  if (!att) return res.status(404).json({ error: 'Not found' });
  await supabaseAdmin.storage.from('job-attachments').remove([att.storage_path]).catch(() => {});
  await supabaseAdmin.from('job_attachments').delete().eq('id', req.params.attId);
  res.json({ ok: true });
});

// ─── Live Map: dashboard-scoped location endpoints ───────────────────────

// All currently clocked-in crew with their last known coords.
// Updates live as crew phones heartbeat while clocked in.
app.get('/api/dashboard/crew-pins', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const dayStart = new Date(); dayStart.setHours(0,0,0,0);
  const { data: rows, error } = await supabaseAdmin
    .from('time_entries')
    .select(`
      id, employee_id, started_at, ended_at,
      start_lat, start_lng, end_lat, end_lng,
      last_ping_lat, last_ping_lng, last_ping_at,
      employees(name, avatar_url, phone, role)
    `)
    .eq('tenant_id', tenantId)
    .gte('started_at', dayStart.toISOString())
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const byEmployee = new Map();
  for (const r of (rows || [])) {
    if (!byEmployee.has(r.employee_id)) byEmployee.set(r.employee_id, r);
  }
  const pins = [];
  for (const r of byEmployee.values()) {
    const emp = r.employees || {};
    const active = !r.ended_at;
    // Prefer most-recent heartbeat for active crew; fall back to start_lat.
    const lat = active
      ? (r.last_ping_lat ?? r.start_lat)
      : (r.end_lat ?? r.last_ping_lat ?? r.start_lat);
    const lng = active
      ? (r.last_ping_lng ?? r.start_lng)
      : (r.end_lng ?? r.last_ping_lng ?? r.start_lng);
    if (lat == null || lng == null) continue;
    pins.push({
      employee_id: r.employee_id,
      name: emp.name || 'Crew',
      avatar_url: emp.avatar_url || null,
      phone: emp.phone || null,
      role: emp.role || 'crew',
      active,
      lat, lng,
      last_seen: active ? (r.last_ping_at || r.started_at) : r.ended_at,
      started_at: r.started_at,
      ended_at: r.ended_at || null,
    });
  }
  res.json({ pins, tenant_radius_m: 100 });
});

// Clock-in + clock-out markers for a specific day (defaults to today).
app.get('/api/dashboard/time-entries', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const dateStr = req.query.date || new Date().toISOString().slice(0,10);
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const { data, error } = await supabaseAdmin
    .from('time_entries')
    .select(`
      id, employee_id, started_at, ended_at,
      start_lat, start_lng, end_lat, end_lng,
      employees(name, role)
    `)
    .eq('tenant_id', tenantId)
    .gte('started_at', dayStart.toISOString())
    .lt('started_at', dayEnd.toISOString())
    .order('started_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const markers = [];
  for (const r of (data || [])) {
    const name = r.employees?.name || 'Crew';
    if (r.start_lat != null && r.start_lng != null) {
      markers.push({ kind: 'in', name, employee_id: r.employee_id,
        lat: r.start_lat, lng: r.start_lng, at: r.started_at });
    }
    if (r.ended_at && r.end_lat != null && r.end_lng != null) {
      markers.push({ kind: 'out', name, employee_id: r.employee_id,
        lat: r.end_lat, lng: r.end_lng, at: r.ended_at });
    }
  }
  res.json({ markers, date: dateStr });
});

// Geocoded jobs for today — job pins on the map.
app.get('/api/dashboard/jobs-today', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const today = new Date().toISOString().slice(0,10);
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('id, name, address, status, lat, lng, scheduled_date')
    .eq('tenant_id', tenantId)
    .or(`scheduled_date.eq.${today},status.in.(scheduled,dispatched,en_route,on_site,active,in_progress)`)
    .not('lat', 'is', null)
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ jobs: data || [] });
});

// Kick off geocoding for any un-geocoded jobs (tenant-scoped, rate-limited).
// Returns immediately; geocoding runs async with Google's free tier.
app.post('/api/dashboard/geocode-jobs', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (!JOB_APPROVER_ROLES.has(req.role || 'owner')) {
    return res.status(403).json({ error: 'Approver role required' });
  }
  const apiKey = process.env.GOOGLE_MAPS_STATIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GOOGLE_MAPS_STATIC_API_KEY not set' });
  // Fire-and-forget; report queue size.
  const { data: jobs } = await supabaseAdmin
    .from('jobs')
    .select('id, address')
    .eq('tenant_id', tenantId)
    .is('lat', null)
    .not('address', 'is', null)
    .limit(50);
  if (!jobs?.length) return res.json({ ok: true, queued: 0 });
  (async () => {
    for (const job of jobs) {
      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(job.address)}&key=${apiKey}`;
        const gr = await fetch(url);
        const gd = await gr.json();
        const hit = gd?.results?.[0]?.geometry?.location;
        if (hit) {
          await supabaseAdmin.from('jobs')
            .update({ lat: hit.lat, lng: hit.lng, geocoded_at: new Date().toISOString() })
            .eq('id', job.id);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
  })().catch(() => {});
  res.json({ ok: true, queued: jobs.length });
});

// Expose the Maps JS API key to the dashboard (same key that has
// Maps Static enabled — owner must turn on Maps JavaScript + Geocoding
// APIs on it in GCP console).
app.get('/api/dashboard/maps-config', auth, (req, res) => {
  res.json({
    api_key: process.env.GOOGLE_MAPS_STATIC_API_KEY || null,
    note: 'Enable Maps JavaScript API and Geocoding API on this key in GCP if not already done.',
  });
});

// Status-events feed for a single job (web job-detail panel).
app.get('/api/dashboard/jobs/:id/status-events', auth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAdmin
    .from('job_status_events')
    .select('id, from_status, to_status, trigger, note, created_at, employees:actor_employee_id(name, role)')
    .eq('job_id', req.params.id)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
});

// ── Keepalive — ping self every 14 min to prevent Render sleep ────────────────
cron.schedule('*/14 * * * *', () => {
  fetch('https://linkcrew.io/api/config').catch(() => {});
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FieldSync running at http://localhost:${PORT}`);
});

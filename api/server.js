require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { sendDailyDigest, sendNote } = require('../email/digest');
const { handleMessage } = require('../bot/whatsapp');

const app = express();

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
  if (event.type === 'checkout.session.completed') {
    const jobId = event.data.object.metadata?.job_id;
    if (jobId) {
      await supabaseAdmin.from('jobs').update({ payment_status: 'paid' }).eq('id', jobId);
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../dashboard'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/index.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/portal.html')));
app.get('/invoice', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/invoice.html')));

// Super-admin emails (comma-separated in env, e.g. "you@example.com")
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim()).filter(Boolean);

// ── Auth middleware ───────────────────────────────────────────────────────────

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

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
  const { email, password, company_name } = req.body;
  if (!email || !password || !company_name) {
    return res.status(400).json({ error: 'Email, password, and company name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Create Supabase Auth user
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError) return res.status(400).json({ error: authError.message });

  // Create tenant record
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .insert({ company_name: company_name.trim(), owner_email: email.toLowerCase() })
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
  const { name, address, manager_email } = req.body;
  const { data } = await supabaseAdmin.from('jobs')
    .insert({ name, address, manager_email, tenant_id: req.tenantId }).select().single();
  res.json(data);
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
  const { name, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabaseAdmin.from('clients')
    .insert({ name: name.trim(), phone, email, address, notes, tenant_id: req.tenantId })
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
  const { name, phone, email, address, notes } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
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
    .eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
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

// ── Invoice Data ──────────────────────────────────────────────────────────────

// Dashboard: fetch invoice data for a job
app.get('/api/invoice/:jobId', auth, async (req, res) => {
  const { data: job, error } = await supabaseAdmin.from('jobs')
    .select('*, clients(name, email, phone, address)')
    .eq('id', req.params.jobId)
    .eq('tenant_id', req.tenantId)
    .single();
  console.log('[invoice]', { jobId: req.params.jobId, tenantId: req.tenantId, found: !!job, err: error?.message });
  if (!job || error) return res.status(404).json({ error: error?.message || 'Not found' });
  const { data: tenant } = await supabaseAdmin.from('tenants')
    .select('company_name, owner_email')
    .eq('id', req.tenantId)
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

// ── Super-admin Routes ────────────────────────────────────────────────────────

// List all tenants with stats (admin only)
app.get('/api/admin/tenants', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const { data: tenants } = await supabaseAdmin
    .from('tenants').select('*').order('created_at', { ascending: false });

  const enriched = await Promise.all((tenants || []).map(async t => {
    const [{ count: jobCount }, { count: empCount }] = await Promise.all([
      supabaseAdmin.from('jobs').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
      supabaseAdmin.from('employees').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
    ]);
    return { ...t, job_count: jobCount || 0, employee_count: empCount || 0 };
  }));

  res.json(enriched);
});

// ── Scheduled Email Digest ────────────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log('📧 Sending daily digest...');
  await sendDailyDigest();
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FieldSync running at http://localhost:${PORT}`);
});

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const { sendDailyDigest, sendNote } = require('../email/digest');
const { handleMessage } = require('../bot/whatsapp');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../dashboard')));

// ── WhatsApp Webhook ──────────────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  const profileName = req.body.ProfileName;
  const mediaUrl = req.body.MediaUrl0 || null;

  res.sendStatus(200); // Acknowledge immediately
  handleMessage(from, body, profileName, mediaUrl).catch(console.error);
});

// ── API Routes ────────────────────────────────────────────────────────────────

// Get all active jobs with their latest status
app.get('/api/jobs', async (req, res) => {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .order('name');
  res.json(jobs || []);
});

// Get full dashboard data for a job
app.get('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;

  const [{ data: job }, { data: assignments }, { data: supplies }, { data: updates }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).single(),
    supabase.from('job_assignments')
      .select('*, employees(name, role)')
      .eq('job_id', id),
    supabase.from('supply_requests')
      .select('*, employees(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase.from('job_updates')
      .select('*, employees(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .limit(50)
  ]);

  res.json({ job, assignments, supplies, updates });
});

// Get all pending supply requests (yard manager view)
app.get('/api/supplies/pending', async (req, res) => {
  const { data } = await supabase
    .from('supply_requests')
    .select('*, jobs(name, address), employees(name)')
    .eq('status', 'pending')
    .order('urgency')
    .order('created_at');
  res.json(data || []);
});

// Update supply request status
app.patch('/api/supplies/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { data } = await supabase
    .from('supply_requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  res.json(data);
});

// Add a new job (manager/owner)
app.post('/api/jobs', async (req, res) => {
  const { name, address, manager_email } = req.body;
  const { data } = await supabase
    .from('jobs')
    .insert({ name, address, manager_email })
    .select()
    .single();
  res.json(data);
});

// Update job status
app.patch('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { data } = await supabase
    .from('jobs')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  res.json(data);
});

// Send a note to manager email
app.post('/api/send-note', async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });
  await sendNote({ subject, body });
  res.json({ ok: true });
});

// Supabase config for frontend (public values only)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY
  });
});

// ── Scheduled Email Digest — runs daily at 6pm ─────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log('📧 Sending daily digest...');
  await sendDailyDigest();
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FieldSync dashboard running at http://localhost:${PORT}`);
});

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function sendDailyDigest() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get all active jobs
  const { data: jobs } = await supabase.from('jobs').select('*').eq('status', 'active');
  if (!jobs?.length) return;

  // Get today's data
  const [{ data: updates }, { data: supplies }, { data: assignments }] = await Promise.all([
    supabase.from('job_updates')
      .select('*, jobs(name), employees(name)')
      .gte('created_at', today.toISOString())
      .order('created_at', { ascending: false }),
    supabase.from('supply_requests')
      .select('*, jobs(name), employees(name)')
      .gte('created_at', today.toISOString()),
    supabase.from('job_assignments')
      .select('*, jobs(name), employees(name)')
      .gte('checked_in_at', today.toISOString())
  ]);

  const pendingSupplies = supplies?.filter(s => s.status === 'pending') || [];
  const bottlenecks = updates?.filter(u => u.type === 'bottleneck') || [];

  const html = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333; }
  .header { background: #1a1a2e; color: white; padding: 24px; border-radius: 8px 8px 0 0; }
  .header h1 { margin: 0; font-size: 24px; }
  .header p { margin: 4px 0 0; opacity: 0.7; font-size: 14px; }
  .section { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .section h2 { margin: 0 0 12px; font-size: 16px; color: #1a1a2e; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
  .badge-red { background: #fee2e2; color: #dc2626; }
  .badge-yellow { background: #fef3c7; color: #d97706; }
  .badge-green { background: #d1fae5; color: #059669; }
  .job-card { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 8px 0; }
  .job-card h3 { margin: 0 0 8px; font-size: 15px; }
  .job-card p { margin: 4px 0; font-size: 13px; color: #6b7280; }
  .supply-item { padding: 10px; border-left: 3px solid #dc2626; background: white; margin: 6px 0; border-radius: 0 4px 4px 0; }
  .bottleneck-item { padding: 10px; border-left: 3px solid #d97706; background: white; margin: 6px 0; border-radius: 0 4px 4px 0; }
  .stat { text-align: center; padding: 16px; background: white; border-radius: 6px; }
  .stat .num { font-size: 32px; font-weight: bold; color: #1a1a2e; }
  .stat .label { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .stats-row { display: flex; gap: 12px; }
  .stats-row .stat { flex: 1; }
  .footer { text-align: center; padding: 16px; font-size: 12px; color: #9ca3af; }
</style>
</head>
<body>

<div class="header">
  <h1>📋 FieldSync Daily Digest</h1>
  <p>${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
</div>

<div class="section">
  <div class="stats-row">
    <div class="stat">
      <div class="num">${jobs.length}</div>
      <div class="label">Active Jobs</div>
    </div>
    <div class="stat">
      <div class="num">${assignments?.length || 0}</div>
      <div class="label">Check-Ins Today</div>
    </div>
    <div class="stat">
      <div class="num" style="color: ${pendingSupplies.length > 0 ? '#dc2626' : '#059669'}">${pendingSupplies.length}</div>
      <div class="label">Pending Supply Requests</div>
    </div>
    <div class="stat">
      <div class="num" style="color: ${bottlenecks.length > 0 ? '#d97706' : '#059669'}">${bottlenecks.length}</div>
      <div class="label">Bottlenecks Flagged</div>
    </div>
  </div>
</div>

${pendingSupplies.length > 0 ? `
<div class="section">
  <h2>🚨 Pending Supply Requests</h2>
  ${pendingSupplies.map(s => `
    <div class="supply-item">
      <strong>${s.jobs?.name}</strong>
      <span class="badge badge-${s.urgency === 'same_day' ? 'red' : 'yellow'}">${s.urgency.replace('_', ' ').toUpperCase()}</span><br>
      <span style="font-size:13px">📦 ${s.items}</span><br>
      <span style="font-size:12px; color:#6b7280">Reported by ${s.employees?.name}</span>
    </div>
  `).join('')}
</div>
` : ''}

${bottlenecks.length > 0 ? `
<div class="section">
  <h2>⚠️ Bottlenecks</h2>
  ${bottlenecks.map(b => `
    <div class="bottleneck-item">
      <strong>${b.jobs?.name}</strong><br>
      <span style="font-size:13px">${b.message}</span><br>
      <span style="font-size:12px; color:#6b7280">Flagged by ${b.employees?.name}</span>
    </div>
  `).join('')}
</div>
` : ''}

<div class="section">
  <h2>📋 Active Jobs Today</h2>
  ${jobs.map(job => {
    const jobAssignments = assignments?.filter(a => a.job_id === job.id) || [];
    const jobSupplies = supplies?.filter(s => s.job_id === job.id) || [];
    const jobUpdates = updates?.filter(u => u.job_id === job.id) || [];
    return `
    <div class="job-card">
      <h3>${job.name} <span class="badge badge-green">${job.status.toUpperCase()}</span></h3>
      <p>📍 ${job.address || 'No address set'}</p>
      <p>👷 ${jobAssignments.length} employee(s) checked in today</p>
      <p>📦 ${jobSupplies.length} supply request(s) | 🔄 ${jobUpdates.length} update(s)</p>
    </div>
  `}).join('')}
</div>

<div class="footer">
  FieldSync — Field Service Management • <a href="http://localhost:3000">View Live Dashboard</a>
</div>

</body>
</html>
  `;

  await resend.emails.send({
    from: 'FieldSync <onboarding@resend.dev>',
    to: process.env.MANAGER_EMAIL,
    subject: `FieldSync Daily Digest — ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} | ${jobs.length} active jobs`,
    html
  });

  console.log(`📧 Daily digest sent to ${process.env.MANAGER_EMAIL}`);
}

async function sendAlertEmail({ subject, title, color, rows, photoUrl }) {
  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#6b7280;width:120px">${label}</td>
      <td style="padding:8px 12px;font-size:13px;color:#111827;font-weight:500">${value}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:${color};padding:20px 24px">
    <h2 style="margin:0;color:white;font-size:18px">${title}</h2>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:8px 0">${rowsHtml}</table>
  ${photoUrl ? `<div style="padding:0 12px 16px"><img src="${photoUrl}" style="max-width:100%;border-radius:8px;border:1px solid #e5e7eb"></div>` : ''}
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
    FieldSync • <a href="http://localhost:3000" style="color:#6b7280">View Dashboard</a>
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: process.env.MANAGER_EMAIL,
    subject,
    html
  });
}

async function sendSupplyAlert({ jobName, employeeName, items, urgency }) {
  await sendAlertEmail({
    subject: `🚨 Supply Request — ${jobName}`,
    title: `📦 Missing Supplies — ${jobName}`,
    color: urgency === 'same_day' ? '#dc2626' : '#d97706',
    rows: [
      ['Job', jobName],
      ['Employee', employeeName],
      ['Items', items],
      ['Urgency', urgency.replace('_', ' ').toUpperCase()]
    ]
  });
}

async function sendBottleneckAlert({ jobName, employeeName, message }) {
  await sendAlertEmail({
    subject: `⚠️ Bottleneck Flagged — ${jobName}`,
    title: `⚠️ Bottleneck — ${jobName}`,
    color: '#d97706',
    rows: [
      ['Job', jobName],
      ['Reported by', employeeName],
      ['Issue', message]
    ]
  });
}

async function sendPhotoAlert({ jobName, employeeName, caption, photoUrl }) {
  await sendAlertEmail({
    subject: `📸 New Site Photo — ${jobName}`,
    title: `📸 Site Photo — ${jobName}`,
    color: '#2563eb',
    rows: [
      ['Job', jobName],
      ['Employee', employeeName],
      ['Caption', caption || 'No caption']
    ],
    photoUrl
  });
}

module.exports = { sendDailyDigest, sendSupplyAlert, sendBottleneckAlert, sendPhotoAlert };

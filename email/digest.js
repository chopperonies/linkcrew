require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { LINKCREW_FROM, LINKCREW_ALERT_FROM, SUPPORT_EMAIL } = require('./config');

const resend = new Resend(process.env.RESEND_API_KEY);
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
    from: LINKCREW_ALERT_FROM,
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
    from: LINKCREW_ALERT_FROM,
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

async function sendNote({ subject, body }) {
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#1a1a2e;padding:20px 24px">
    <h2 style="margin:0;color:white;font-size:18px">⚡ FieldSync Note</h2>
  </div>
  <div style="padding:24px;white-space:pre-wrap;font-size:14px;color:#111827;line-height:1.6">${body}</div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
    FieldSync • Sent on ${new Date().toLocaleString()}
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_ALERT_FROM,
    to: process.env.MANAGER_EMAIL,
    subject: subject || 'Note from FieldSync',
    html,
  });
}

async function sendInvoiceToClient({ clientName, clientEmail, jobName, amount, portalUrl, tenantName }) {
  const formattedAmount = Number(amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:24px">
    <h2 style="margin:0;color:white;font-size:20px">Invoice from ${tenantName || 'Your Contractor'}</h2>
    <p style="margin:6px 0 0;color:#888;font-size:14px">You have a new invoice ready to view and pay</p>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#111827;margin:0 0 20px">Hi ${clientName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 24px">
      An invoice has been created for <strong>${jobName}</strong>.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Invoice Total</div>
      <div style="font-size:36px;font-weight:800;color:#0a0a0a">${formattedAmount}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px">${jobName}</div>
    </div>
    ${portalUrl ? `
    <a href="${portalUrl}" style="display:block;background:#0265dc;color:white;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:16px">
      View &amp; Pay Invoice
    </a>
    <p style="font-size:12px;color:#9ca3af;text-align:center;margin:0">Or copy this link: ${portalUrl}</p>
    ` : ''}
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — Field Service Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_FROM,
    to: clientEmail,
    subject: `Invoice for ${jobName} — ${formattedAmount}`,
    html,
  });
}

async function sendClientPortalInvite({ clientName, clientEmail, portalUrl, tenantName }) {
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:24px">
    <h2 style="margin:0;color:white;font-size:20px">Your Client Portal Is Ready</h2>
    <p style="margin:6px 0 0;color:#d1d5db;font-size:14px">${tenantName || 'Your contractor'} shared a secure portal link with you</p>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#111827;margin:0 0 20px">Hi ${clientName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 24px">
      Use your client portal to view jobs, check updates, see site photos, and request new services.
    </p>
    <a href="${portalUrl}" style="display:block;background:#0265dc;color:white;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:16px">
      Open Client Portal
    </a>
    <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:0">
      If the button does not open, copy and paste this link into your browser:<br>${portalUrl}
    </p>
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — Field Service Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_FROM,
    to: clientEmail,
    subject: `Your client portal from ${tenantName || 'your contractor'}`,
    html,
  });
}

async function sendPaymentReceivedToOwner({ ownerEmail, clientName, jobName, amount, tenantName }) {
  const formattedAmount = Number(amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#052e16;padding:24px">
    <h2 style="margin:0;color:#4ade80;font-size:20px">Payment Received</h2>
    <p style="margin:6px 0 0;color:#86efac;font-size:14px">${clientName} paid their invoice</p>
  </div>
  <div style="padding:28px">
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Amount Paid</div>
      <div style="font-size:36px;font-weight:800;color:#15803d">${formattedAmount}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px">${jobName}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280;width:80px">Client</td>
        <td style="padding:8px 0;font-size:13px;color:#111827;font-weight:600">${clientName}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280">Job</td>
        <td style="padding:8px 0;font-size:13px;color:#111827;font-weight:600">${jobName}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280">Amount</td>
        <td style="padding:8px 0;font-size:13px;color:#15803d;font-weight:700">${formattedAmount}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280">Date</td>
        <td style="padding:8px 0;font-size:13px;color:#111827">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
      </tr>
    </table>
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — Field Service Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_ALERT_FROM,
    to: ownerEmail,
    subject: `Payment received — ${formattedAmount} from ${clientName}`,
    html,
  });
}

async function sendClientRequestToOwner({ ownerEmail, tenantName, clientName, address, description, dashboardUrl }) {
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#7c2d12;padding:24px">
    <h2 style="margin:0;color:#fed7aa;font-size:20px">New Client Service Request</h2>
    <p style="margin:6px 0 0;color:#fdba74;font-size:14px">${clientName} submitted a new request through the client portal</p>
  </div>
  <div style="padding:28px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280;width:96px">Client</td>
        <td style="padding:8px 0;font-size:13px;color:#111827;font-weight:600">${clientName}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#6b7280">Address</td>
        <td style="padding:8px 0;font-size:13px;color:#111827">${address || 'No address provided'}</td>
      </tr>
    </table>
    <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:16px;margin-bottom:24px">
      <div style="font-size:12px;color:#9a3412;font-weight:700;margin-bottom:8px">Request Details</div>
      <div style="font-size:14px;color:#7c2d12;line-height:1.6">${description}</div>
    </div>
    ${dashboardUrl ? `
    <a href="${dashboardUrl}" style="display:block;background:#0265dc;color:white;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:16px">
      Open LinkCrew Dashboard
    </a>
    ` : ''}
    <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:0">
      This request was added to LinkCrew as a quoted job so your team can review and schedule it.
    </p>
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    ${tenantName || 'LinkCrew'} — Field Service Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_ALERT_FROM,
    to: ownerEmail,
    subject: `New client request from ${clientName}`,
    html,
  });
}

function detectCallbackRequest(transcript) {
  const callerLines = transcript.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
  const keywords = ['call me back', 'call me at', 'callback', 'call back', 'reach me', 'get back to me', 'give me a call', 'have someone call', 'can you call', 'please call'];
  return keywords.some(kw => callerLines.includes(kw));
}

async function sendCallTranscriptToOwner({ ownerEmail, companyName, callerNumber, transcript, duration }) {
  const callbackRequested = detectCallbackRequest(transcript);

  const rows = transcript.map(m => `
    <tr>
      <td style="padding:6px 12px;font-size:12px;color:#6b7280;width:80px;vertical-align:top">${m.role === 'user' ? 'Caller' : 'Choppy'}</td>
      <td style="padding:6px 12px;font-size:13px;color:#111827">${m.content}</td>
    </tr>
  `).join('');

  const callbackBanner = callbackRequested ? `
  <div style="margin:0 0 20px;padding:14px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;display:flex;align-items:center;gap:10px">
    <span style="font-size:20px">📲</span>
    <div>
      <strong style="color:#92400e;font-size:14px">Callback Requested</strong>
      <p style="margin:2px 0 0;font-size:13px;color:#b45309">This caller asked to be called back. Call ${callerNumber} when you get a chance.</p>
    </div>
  </div>` : '';

  const subject = callbackRequested
    ? `📲 Callback requested — ${callerNumber} (${companyName})`
    : `📞 Missed call from ${callerNumber} — ${companyName}`;

  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:24px">
    <h2 style="margin:0;color:white;font-size:20px">${callbackRequested ? '📲' : '📞'} ${callbackRequested ? 'Callback Requested' : 'Missed Call'} — ${companyName}</h2>
    <p style="margin:6px 0 0;color:#888;font-size:14px">From ${callerNumber} · ${duration || 'Short call'}</p>
  </div>
  <div style="padding:24px">
    ${callbackBanner}
    <p style="font-size:14px;color:#374151;margin:0 0 16px">Choppy handled a call on your behalf. Here's the full transcript:</p>
    ${transcript.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      ${rows}
    </table>` : '<p style="font-size:13px;color:#9ca3af">No conversation recorded — caller hung up before speaking.</p>'}
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew Voice Bot · <a href="https://linkcrew.io/app" style="color:#6b7280">View Dashboard</a>
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_ALERT_FROM,
    to: ownerEmail,
    subject,
    html,
  });
}

async function sendWorkOrderToClient({ clientName, clientEmail, jobName, description, estimateAmount, workorderUrl, tenantName }) {
  const fmtAmount = estimateAmount
    ? Number(estimateAmount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : 'TBD';
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:24px">
    <h2 style="margin:0;color:white;font-size:20px">Work Order from ${tenantName || 'Your Contractor'}</h2>
    <p style="margin:6px 0 0;color:#888;font-size:14px">Estimate ready for your review</p>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#111827;margin:0 0 20px">Hi ${clientName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 24px">
      A work order has been prepared for <strong>${jobName}</strong>. You can view the full details and estimated pricing below.
    </p>
    ${description ? `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px">
      <div style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Scope of Work</div>
      <div style="font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap">${description}</div>
    </div>` : ''}
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Estimate Total</div>
      <div style="font-size:36px;font-weight:800;color:#0a0a0a">${fmtAmount}</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">Subject to change as work progresses</div>
    </div>
    <a href="${workorderUrl}" style="display:block;background:#0265dc;color:white;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:16px">
      View Full Work Order
    </a>
    <p style="font-size:12px;color:#9ca3af;text-align:center;margin:0">Or copy this link: ${workorderUrl}</p>
  </div>
  <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — Field Service Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_FROM,
    to: clientEmail,
    subject: `Work Order from ${tenantName || 'Your Contractor'} — ${jobName}`,
    html,
  });
}

async function sendIncomingSmsNotification({ toEmail, fromNumber, message, companyName }) {
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:20px 24px">
    <h2 style="margin:0;color:white;font-size:18px">📱 New text message — ${companyName || 'LinkCrew'}</h2>
    <p style="margin:6px 0 0;color:#888;font-size:13px">From: ${fromNumber}</p>
  </div>
  <div style="padding:28px">
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;font-size:15px;color:#111827;line-height:1.6;white-space:pre-wrap">${message}</div>
    <p style="margin:20px 0 0;font-size:13px;color:#6b7280">Reply by texting back to your Twilio number or calling ${fromNumber} directly.</p>
  </div>
  <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — SMS Inbox
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_ALERT_FROM,
    to: toEmail,
    subject: `📱 Text from ${fromNumber} — ${companyName || 'LinkCrew'}`,
    html,
  });
}

async function sendBusinessOnboardingEmail({ ownerEmail, companyName }) {
  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px">
<div style="background:white;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0a0a0a;padding:24px">
    <h2 style="margin:0;color:white;font-size:20px">Welcome to LinkCrew Business</h2>
    <p style="margin:6px 0 0;color:#888;font-size:13px">${companyName || 'Your team'} is now on the Business plan</p>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#111827;line-height:1.6">Hi there,</p>
    <p style="font-size:15px;color:#111827;line-height:1.6">
      You're now on the <strong>Business plan</strong> — up to 20 crew members, priority support, and full access to every feature LinkCrew offers.
    </p>
    <p style="font-size:15px;color:#111827;line-height:1.6">
      As a Business customer you get a free onboarding call with our team. We'll walk through your setup, import your crew, and make sure everything is configured the way you need it.
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="https://calendly.com/linkcrew-sales/30min" style="background:#0265dc;color:white;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">
        Book Your Onboarding Call
      </a>
    </div>
    <p style="font-size:13px;color:#6b7280;line-height:1.6">
      Questions before the call? Reply to this email or reach us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#0265dc">${SUPPORT_EMAIL}</a>.
    </p>
  </div>
  <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
    LinkCrew — Field Crew Management
  </div>
</div>
</body></html>`;

  await resend.emails.send({
    from: LINKCREW_FROM,
    to: ownerEmail,
    subject: 'Welcome to Business — book your onboarding call',
    html,
  });
}

async function sendAppointmentConfirmation({ clientName, clientEmail, title, startTime, endTime, notes, tenantName }) {
  const date = new Date(startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = new Date(startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endStr = endTime ? ` – ${new Date(endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  await resend.emails.send({
    from: LINKCREW_FROM,
    to: clientEmail,
    subject: `Appointment Confirmed: ${title}`,
    html: `<div style="font-family:sans-serif;max-width:500px;color:#17191c">
      <h2 style="color:#0265dc">Appointment Confirmed</h2>
      <p>Hi ${clientName},</p>
      <p>Your appointment has been scheduled:</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
        <div style="font-size:16px;font-weight:700;margin-bottom:8px">${title}</div>
        <div style="font-size:14px;color:#737475">📅 ${date}</div>
        <div style="font-size:14px;color:#737475">🕐 ${time}${endStr}</div>
        ${notes ? `<div style="font-size:13px;color:#737475;margin-top:8px">${notes}</div>` : ''}
      </div>
      <p style="color:#737475;font-size:12px">${tenantName || 'Your contractor'}</p>
    </div>`,
  });
}

async function sendAppointmentReminder({ clientName, clientEmail, title, startTime, endTime, notes, tenantName }) {
  const date = new Date(startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const time = new Date(startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endStr = endTime ? ` – ${new Date(endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  await resend.emails.send({
    from: LINKCREW_FROM,
    to: clientEmail,
    subject: `Reminder: ${title} — Tomorrow`,
    html: `<div style="font-family:sans-serif;max-width:500px;color:#17191c">
      <h2 style="color:#0265dc">Appointment Reminder</h2>
      <p>Hi ${clientName}, just a reminder about your appointment tomorrow:</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
        <div style="font-size:16px;font-weight:700;margin-bottom:8px">${title}</div>
        <div style="font-size:14px;color:#737475">📅 ${date}</div>
        <div style="font-size:14px;color:#737475">🕐 ${time}${endStr}</div>
        ${notes ? `<div style="font-size:13px;color:#737475;margin-top:8px">${notes}</div>` : ''}
      </div>
      <p style="color:#737475;font-size:12px">${tenantName || 'Your contractor'}</p>
    </div>`,
  });
}

module.exports = { sendDailyDigest, sendSupplyAlert, sendBottleneckAlert, sendPhotoAlert, sendNote, sendInvoiceToClient, sendClientPortalInvite, sendClientRequestToOwner, sendPaymentReceivedToOwner, sendCallTranscriptToOwner, sendWorkOrderToClient, sendIncomingSmsNotification, sendBusinessOnboardingEmail, sendAppointmentConfirmation, sendAppointmentReminder };

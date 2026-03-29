require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { sendSupplyAlert, sendBottleneckAlert, sendPhotoAlert } = require('../email/digest');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// In-memory conversation state per WhatsApp number
const userState = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function send(to, body) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
}

async function getOrCreateEmployee(whatsappNumber, name) {
  let { data } = await supabase
    .from('employees')
    .select('*')
    .eq('whatsapp_number', whatsappNumber)
    .single();

  if (!data) {
    const { data: newEmp } = await supabase
      .from('employees')
      .insert({ name, whatsapp_number: whatsappNumber, role: 'crew' })
      .select()
      .single();
    data = newEmp;
  }
  return data;
}

async function getActiveJobs() {
  const { data } = await supabase.from('jobs').select('*').eq('status', 'active').order('name');
  return data || [];
}

async function logJobUpdate(jobId, employeeId, type, message, photoUrl = null) {
  await supabase.from('job_updates').insert({ job_id: jobId, employee_id: employeeId, type, message, photo_url: photoUrl });
}

function jobListText(jobs) {
  return jobs.map((j, i) => `${i + 1}. ${j.name}`).join('\n');
}

function notifyManager(message) {
  const managerId = process.env.MANAGER_TELEGRAM_ID;
  if (managerId) {
    // WhatsApp notification to manager if they have a whatsapp number set
    supabase.from('employees').select('whatsapp_number').eq('role', 'manager').then(({ data }) => {
      (data || []).filter(m => m.whatsapp_number).forEach(m => {
        send(`whatsapp:${m.whatsapp_number}`, message).catch(console.error);
      });
    });
  }
}

// ── Main Message Handler ──────────────────────────────────────────────────────

async function handleMessage(from, body, profileName, mediaUrl) {
  const text = (body || '').trim();
  const state = userState[from] || {};
  const employee = await getOrCreateEmployee(from, profileName || 'Crew Member');

  // Photo received during awaiting_photo state
  if (mediaUrl && state.action === 'awaiting_photo') {
    const { job } = state;
    await logJobUpdate(job.id, employee.id, 'photo', 'Site photo', mediaUrl);
    userState[from] = {};
    await send(from, `📸 Photo saved for *${job.name}*!`);
    notifyManager(`📸 New site photo — ${job.name}\n👷 ${employee.name}`);
    sendPhotoAlert({ jobName: job.name, employeeName: employee.name, photoUrl: mediaUrl }).catch(console.error);
    return;
  }

  // ── Menu ──────────────────────────────────────────────────────────────────
  if (!text || text === '0' || text.toLowerCase() === 'menu' || text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
    userState[from] = {};
    await send(from,
      `👷 Welcome to *FieldSync*, ${employee.name}!\n\nReply with a number:\n\n` +
      `1️⃣ Check In to Job Site\n` +
      `2️⃣ Report Missing Supplies\n` +
      `3️⃣ Flag a Bottleneck\n` +
      `4️⃣ Send Site Photo\n` +
      `5️⃣ Check Out\n\n` +
      `Reply *0* or *menu* anytime to return here.`
    );
    return;
  }

  // ── Step 1 — Action selection ─────────────────────────────────────────────
  if (!state.action) {
    const jobs = await getActiveJobs();
    const actions = {
      '1': 'checkin', '2': 'supplies_job', '3': 'bottleneck_job', '4': 'photo_job', '5': 'checkout'
    };
    const action = actions[text];
    if (!action) {
      await send(from, 'Reply with 1-5 or *menu* to see options.');
      return;
    }
    if (!jobs.length) {
      await send(from, 'No active jobs found. Ask your manager to add jobs.');
      return;
    }
    userState[from] = { action };
    await send(from, `Which job site?\n\n${jobListText(jobs)}\n\nReply with the number.`);
    return;
  }

  // ── Step 2 — Job selection ────────────────────────────────────────────────
  if (['checkin', 'supplies_job', 'bottleneck_job', 'photo_job', 'checkout'].includes(state.action)) {
    const jobs = await getActiveJobs();
    const idx = parseInt(text) - 1;
    if (isNaN(idx) || idx < 0 || idx >= jobs.length) {
      await send(from, `Reply with a number between 1 and ${jobs.length}.`);
      return;
    }
    const job = jobs[idx];

    if (state.action === 'checkin') {
      await supabase.from('job_assignments').upsert({
        job_id: job.id, employee_id: employee.id,
        checked_in_at: new Date().toISOString(), checked_out_at: null,
      }, { onConflict: 'job_id,employee_id' });
      await logJobUpdate(job.id, employee.id, 'checkin', `${employee.name} checked in`);
      userState[from] = {};
      await send(from, `✅ Checked in to *${job.name}*! Reply *menu* for more options.`);

    } else if (state.action === 'checkout') {
      await supabase.from('job_assignments')
        .update({ checked_out_at: new Date().toISOString() })
        .eq('job_id', job.id).eq('employee_id', employee.id);
      await logJobUpdate(job.id, employee.id, 'checkout', `${employee.name} checked out`);
      userState[from] = {};
      await send(from, `👋 Checked out from *${job.name}*. Good work today!`);

    } else if (state.action === 'supplies_job') {
      userState[from] = { action: 'supplies_items', job, employee };
      await send(from, `📦 What supplies are missing at *${job.name}*?\n\nDescribe the items (e.g. "10x conduit, 4x junction boxes")`);

    } else if (state.action === 'bottleneck_job') {
      userState[from] = { action: 'bottleneck_desc', job, employee };
      await send(from, `🚧 Describe the bottleneck at *${job.name}*:`);

    } else if (state.action === 'photo_job') {
      userState[from] = { action: 'awaiting_photo', job, employee };
      await send(from, `📸 Send the photo for *${job.name}* now.`);
    }
    return;
  }

  // ── Supply items ──────────────────────────────────────────────────────────
  if (state.action === 'supplies_items') {
    userState[from] = { ...state, action: 'supplies_urgency', items: text };
    await send(from, `When do you need these?\n\n1️⃣ Same Day 🔴\n2️⃣ Next Day 🟡`);
    return;
  }

  if (state.action === 'supplies_urgency') {
    const urgency = text === '1' ? 'same_day' : text === '2' ? 'next_day' : null;
    if (!urgency) { await send(from, 'Reply 1 for Same Day or 2 for Next Day.'); return; }
    const { job, employee: emp, items } = state;
    await supabase.from('supply_requests').insert({
      job_id: job.id, employee_id: emp.id, items, urgency,
    });
    await logJobUpdate(job.id, emp.id, 'supply_request', `Missing supplies: ${items} (${urgency.replace('_', ' ')})`);
    notifyManager(`🚨 Supply Request — ${job.name}\n👷 ${emp.name}\n📦 ${items}\n⏰ ${urgency.replace('_', ' ').toUpperCase()}`);
    sendSupplyAlert({ jobName: job.name, employeeName: emp.name, items, urgency }).catch(console.error);
    userState[from] = {};
    await send(from, `✅ Supply request submitted! Manager has been notified.\n\nReply *menu* for more options.`);
    return;
  }

  // ── Bottleneck description ────────────────────────────────────────────────
  if (state.action === 'bottleneck_desc') {
    const { job, employee: emp } = state;
    await logJobUpdate(job.id, emp.id, 'bottleneck', text);
    notifyManager(`⚠️ Bottleneck — ${job.name}\n👷 ${emp.name}: "${text}"`);
    sendBottleneckAlert({ jobName: job.name, employeeName: emp.name, message: text }).catch(console.error);
    userState[from] = {};
    await send(from, `⚠️ Bottleneck reported. Manager has been notified.\n\nReply *menu* for more options.`);
    return;
  }

  // Fallback
  await send(from, 'Reply *menu* to see options.');
}

module.exports = { handleMessage };

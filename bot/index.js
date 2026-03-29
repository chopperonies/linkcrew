require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { sendSupplyAlert, sendBottleneckAlert, sendPhotoAlert } = require('../email/digest');

// Track conversation state per user
const userState = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function uploadPhotoToSupabase(fileId, employeeId) {
  // Get file path from Telegram
  const filePath = await new Promise((resolve, reject) => {
    https.get(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data).result?.file_path));
      }
    ).on('error', reject);
  });

  if (!filePath) return null;

  // Download photo bytes
  const photoBuffer = await new Promise((resolve, reject) => {
    https.get(
      `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`,
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    ).on('error', reject);
  });

  // Upload to Supabase Storage
  const fileName = `${employeeId}/${Date.now()}.jpg`;
  const { data, error } = await supabaseAdmin.storage
    .from('photos')
    .upload(fileName, photoBuffer, { contentType: 'image/jpeg', upsert: true });

  if (error) { console.error('Upload error:', error.message); return null; }

  const { data: { publicUrl } } = supabaseAdmin.storage.from('photos').getPublicUrl(fileName);
  return publicUrl;
}

async function getOrCreateEmployee(telegramId, name) {
  let { data } = await supabase
    .from('employees')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (!data) {
    const { data: newEmp } = await supabase
      .from('employees')
      .insert({ name, telegram_id: telegramId })
      .select()
      .single();
    data = newEmp;
  }
  return data;
}

async function getActiveJobs() {
  const { data } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'active')
    .order('name');
  return data || [];
}

async function logJobUpdate(jobId, employeeId, type, message, photoUrl = null) {
  await supabase.from('job_updates').insert({
    job_id: jobId,
    employee_id: employeeId,
    type,
    message,
    photo_url: photoUrl
  });
}

function jobKeyboard(jobs) {
  return {
    reply_markup: {
      inline_keyboard: jobs.map(j => ([{ text: j.name, callback_data: `job_${j.id}` }]))
    }
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

// /start — register & show menu
bot.onText(/\/start/, async (msg) => {
  const { id: telegramId, first_name } = msg.from;
  await getOrCreateEmployee(telegramId, first_name);
  userState[telegramId] = {};

  bot.sendMessage(telegramId,
    `👷 Welcome to *FieldSync*, ${first_name}!\n\nWhat would you like to do?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['📍 Check In to Job Site'],
          ['📦 Report Missing Supplies'],
          ['🚧 Flag a Bottleneck'],
          ['📸 Send Site Photo'],
          ['✅ Check Out']
        ],
        resize_keyboard: true
      }
    }
  );
});

// ── Check In ──────────────────────────────────────────────────────────────────

bot.onText(/📍 Check In to Job Site/, async (msg) => {
  const telegramId = msg.from.id;
  const jobs = await getActiveJobs();

  if (!jobs.length) {
    return bot.sendMessage(telegramId, 'No active jobs found. Ask your manager to add jobs.');
  }

  userState[telegramId] = { action: 'checkin' };
  bot.sendMessage(telegramId, 'Which job site are you checking in to?', jobKeyboard(jobs));
});

// ── Missing Supplies ──────────────────────────────────────────────────────────

bot.onText(/📦 Report Missing Supplies/, async (msg) => {
  const telegramId = msg.from.id;
  const jobs = await getActiveJobs();

  userState[telegramId] = { action: 'supplies_job' };
  bot.sendMessage(telegramId, 'Which job site is missing supplies?', jobKeyboard(jobs));
});

// ── Bottleneck ────────────────────────────────────────────────────────────────

bot.onText(/🚧 Flag a Bottleneck/, async (msg) => {
  const telegramId = msg.from.id;
  const jobs = await getActiveJobs();

  userState[telegramId] = { action: 'bottleneck_job' };
  bot.sendMessage(telegramId, 'Which job site has a bottleneck?', jobKeyboard(jobs));
});

// ── Site Photo ────────────────────────────────────────────────────────────────

bot.onText(/📸 Send Site Photo/, async (msg) => {
  const telegramId = msg.from.id;
  const jobs = await getActiveJobs();

  userState[telegramId] = { action: 'photo_job' };
  bot.sendMessage(telegramId, 'Which job site is this photo for?', jobKeyboard(jobs));
});

// ── Check Out ─────────────────────────────────────────────────────────────────

bot.onText(/✅ Check Out/, async (msg) => {
  const telegramId = msg.from.id;
  const jobs = await getActiveJobs();

  userState[telegramId] = { action: 'checkout' };
  bot.sendMessage(telegramId, 'Which job site are you checking out from?', jobKeyboard(jobs));
});

// ── Callback Queries (inline keyboard selections) ─────────────────────────────

bot.on('callback_query', async (query) => {
  const telegramId = query.from.id;
  const data = query.data;
  const state = userState[telegramId] || {};

  bot.answerCallbackQuery(query.id);

  // Job selected
  if (data.startsWith('job_')) {
    const jobId = data.replace('job_', '');
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    const employee = await getOrCreateEmployee(telegramId, query.from.first_name);

    if (state.action === 'checkin') {
      // Upsert assignment
      await supabase.from('job_assignments').upsert({
        job_id: jobId,
        employee_id: employee.id,
        checked_in_at: new Date().toISOString()
      }, { onConflict: 'job_id,employee_id' });

      await logJobUpdate(jobId, employee.id, 'checkin', `${employee.name} checked in`);
      userState[telegramId] = {};
      bot.sendMessage(telegramId, `✅ Checked in to *${job.name}*!\n\nSend photos or updates as needed.`, { parse_mode: 'Markdown' });

    } else if (state.action === 'supplies_job') {
      userState[telegramId] = { action: 'supplies_items', jobId, job, employee };
      bot.sendMessage(telegramId,
        `📦 Reporting missing supplies for *${job.name}*\n\nPlease list the missing items (e.g. "10x 1/2 inch conduit, 4x junction boxes"):`,
        { parse_mode: 'Markdown' }
      );

    } else if (state.action === 'bottleneck_job') {
      userState[telegramId] = { action: 'bottleneck_desc', jobId, job, employee };
      bot.sendMessage(telegramId,
        `🚧 Flagging bottleneck for *${job.name}*\n\nDescribe the issue:`,
        { parse_mode: 'Markdown' }
      );

    } else if (state.action === 'photo_job') {
      userState[telegramId] = { action: 'awaiting_photo', jobId, job, employee };
      bot.sendMessage(telegramId, `📸 Send the photo for *${job.name}*:`, { parse_mode: 'Markdown' });

    } else if (state.action === 'checkout') {
      await supabase.from('job_assignments')
        .update({ checked_out_at: new Date().toISOString() })
        .eq('job_id', jobId)
        .eq('employee_id', employee.id);

      await logJobUpdate(jobId, employee.id, 'checkout', `${employee.name} checked out`);
      userState[telegramId] = {};
      bot.sendMessage(telegramId, `👋 Checked out from *${job.name}*. Good work today!`, { parse_mode: 'Markdown' });
    }

  // Urgency selected for supply request
  } else if (data.startsWith('urgency_')) {
    const urgency = data.replace('urgency_', '');
    const { jobId, job, employee, items, photoUrl } = state;

    const { data: request } = await supabase.from('supply_requests').insert({
      job_id: jobId,
      employee_id: employee.id,
      items,
      urgency,
      photo_url: photoUrl || null
    }).select().single();

    await logJobUpdate(jobId, employee.id, 'supply_request',
      `Missing supplies reported: ${items} (${urgency.replace('_', ' ')})`
    );

    // Notify manager via Telegram if MANAGER_TELEGRAM_ID is set
    if (process.env.MANAGER_TELEGRAM_ID) {
      bot.sendMessage(process.env.MANAGER_TELEGRAM_ID,
        `🚨 *Supply Request* — ${job.name}\n\n` +
        `👷 Employee: ${employee.name}\n` +
        `📦 Items: ${items}\n` +
        `⏰ Urgency: ${urgency.replace('_', ' ').toUpperCase()}\n\n` +
        `Update status at: http://localhost:${process.env.PORT || 3000}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Send email alert
    sendSupplyAlert({ jobName: job.name, employeeName: employee.name, items, urgency }).catch(console.error);

    userState[telegramId] = {};
    bot.sendMessage(telegramId,
      `✅ Supply request submitted!\n\n📦 *${items}*\n⏰ ${urgency.replace('_', ' ').toUpperCase()}\n\nYard manager has been notified.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ── Text Messages (conversational flow) ───────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const telegramId = msg.from.id;
  const state = userState[telegramId] || {};
  const text = msg.text;

  // Skip keyboard command buttons (handled above)
  if (['📍 Check In to Job Site','📦 Report Missing Supplies','🚧 Flag a Bottleneck','📸 Send Site Photo','✅ Check Out'].includes(text)) return;

  if (state.action === 'supplies_items') {
    userState[telegramId] = { ...state, action: 'supplies_urgency', items: text };
    bot.sendMessage(telegramId, 'When do you need these supplies?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔴 Same Day', callback_data: 'urgency_same_day' },
          { text: '🟡 Next Day', callback_data: 'urgency_next_day' }
        ]]
      }
    });

  } else if (state.action === 'bottleneck_desc') {
    const { jobId, job, employee } = state;
    await supabase.from('job_updates').insert({
      job_id: jobId,
      employee_id: employee.id,
      type: 'bottleneck',
      message: text
    });

    if (process.env.MANAGER_TELEGRAM_ID) {
      bot.sendMessage(process.env.MANAGER_TELEGRAM_ID,
        `⚠️ *Bottleneck Flagged* — ${job.name}\n\n👷 ${employee.name}: "${text}"`,
        { parse_mode: 'Markdown' }
      );
    }

    // Send email alert
    sendBottleneckAlert({ jobName: job.name, employeeName: employee.name, message: text }).catch(console.error);

    userState[telegramId] = {};
    bot.sendMessage(telegramId, `⚠️ Bottleneck reported. Manager has been notified.`);
  }
});

// ── Photo Messages ─────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  const telegramId = msg.from.id;
  const state = userState[telegramId] || {};

  if (state.action === 'awaiting_photo' || state.action === 'supplies_items') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const employee = await getOrCreateEmployee(telegramId, msg.from.first_name);

    bot.sendMessage(telegramId, '⏳ Uploading photo...');
    const publicUrl = await uploadPhotoToSupabase(fileId, employee.id);

    if (state.action === 'awaiting_photo') {
      const { jobId, job } = state;
      await logJobUpdate(jobId, employee.id, 'photo', msg.caption || 'Site photo', publicUrl);
      userState[telegramId] = {};
      bot.sendMessage(telegramId, `📸 Photo saved for *${job.name}*!`, { parse_mode: 'Markdown' });

      if (process.env.MANAGER_TELEGRAM_ID) {
        bot.sendPhoto(process.env.MANAGER_TELEGRAM_ID, fileId, {
          caption: `📸 New site photo — *${job.name}*\n👷 ${employee.name}${msg.caption ? '\n"' + msg.caption + '"' : ''}`,
          parse_mode: 'Markdown'
        });
      }

      // Send email alert with photo
      sendPhotoAlert({ jobName: job.name, employeeName: employee.name, caption: msg.caption, photoUrl: publicUrl }).catch(console.error);

    } else if (state.action === 'supplies_items') {
      userState[telegramId] = { ...state, photoUrl: publicUrl };
      bot.sendMessage(telegramId, `📸 Photo received! Now list the missing items:`);
    }
  }
});

console.log('🤖 FieldSync bot is running...');

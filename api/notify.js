const https = require('https');

async function sendPushNotification(pushToken, title, body) {
  if (!pushToken || !pushToken.startsWith('ExponentPushToken')) return;

  const message = JSON.stringify({
    to: pushToken,
    sound: 'default',
    title,
    body,
    priority: 'high',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'exp.host',
      path: '/--/api/v2/push/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(message),
      },
    }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', console.error);
    req.write(message);
    req.end();
  });
}

async function notifyManagers(supabase, title, body) {
  const { data: managers } = await supabase
    .from('employees')
    .select('push_token')
    .in('role', ['manager', 'owner'])
    .not('push_token', 'is', null);

  await Promise.all((managers || []).map(m => sendPushNotification(m.push_token, title, body)));
}

module.exports = { notifyManagers };

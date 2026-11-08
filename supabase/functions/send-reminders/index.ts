// Runs every few minutes. Sends each device its daily reminder once, at its own
// local time, and only if nothing has been logged yet that day.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const WINDOW_MINUTES = 60; // If the schedule runs late, still send within this long.
const MESSAGE = {
  title: 'Steady',
  body: "You haven't logged anything today. A quick tick keeps your streak going.",
};

function localTime(now: Date, timeZone: string) {
  const parts = (zone: string) => Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  let p;
  try {
    p = parts(timeZone);
  } catch {
    p = parts('UTC');
  }
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('Not allowed', { status: 401 });
  }
  const test = new URL(req.url).searchParams.get('test') === '1';

  webpush.setVapidDetails(
    'https://nihadahmadov.github.io/steady/',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: subscriptions, error } = await db.from('push_subscriptions').select('*');
  if (error) return new Response(error.message, { status: 500 });

  const now = new Date();
  const result = { devices: subscriptions.length, sent: 0, skipped: 0, removed: 0, failed: 0 };

  for (const s of subscriptions) {
    const local = localTime(now, s.tz);
    const minutesPast = local.minutes - toMinutes(s.remind_at);
    const due = test || (s.last_day !== local.day && minutesPast >= 0 && minutesPast < WINDOW_MINUTES);
    if (!due) continue;

    if (!test) {
      await db.from('push_subscriptions').update({ last_day: local.day }).eq('endpoint', s.endpoint);
      const { count } = await db.from('logs')
        .select('habit_id', { count: 'exact', head: true })
        .eq('user_id', s.user_id).eq('day', local.day).eq('deleted', false);
      if ((count ?? 0) > 0) {
        result.skipped++;
        continue;
      }
    }

    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(MESSAGE),
      );
      result.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // The phone no longer accepts this registration.
        await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        result.removed++;
      } else {
        console.error('Push failed', status);
        result.failed++;
      }
    }
  }

  return Response.json(result);
});

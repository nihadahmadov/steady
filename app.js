(function () {
  'use strict';

  const STORAGE_KEY = 'steady.data.v1';
  const COLORS = ['#b8e04a', '#62b8f6', '#ffa94d', '#ff8a7a', '#b79cff', '#ffd25a', '#ff9ccb', '#4fd1b5'];
  const EMOJIS = ['🏋️', '📚', '🎬', '🏃', '🚴', '🏊', '🧘', '🚶', '💧', '🥗', '😴', '✍️', '🎸', '🧠', '🌱', '☀️'];
  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.6 4.6L19 7.6"/></svg>';
  const DEFAULT_IDS = ['gym', 'reading', 'film', 'cardio'];

  const view = document.getElementById('view');
  const editor = document.getElementById('editor');
  const notice = document.getElementById('notice');

  /* ---------- Dates: always the phone/laptop's local calendar day ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const todayKey = () => keyOf(new Date());
  const weekStart = (k) => addDays(k, -((parseKey(k).getDay() + 6) % 7)); // weeks start on Monday
  const fmtDate = (k, opts) => parseKey(k).toLocaleDateString('en-GB', opts);

  /* ---------- Saving and loading ---------- */
  function normalize(d) {
    d.version = 2;
    d.meta = d.meta || { userId: null, email: '', synced: false, lastSync: 0 };
    d.pending = d.pending || { habits: {}, logs: {} };
    d.habits.forEach((h, i) => { if (typeof h.pos !== 'number') h.pos = i; });
    return d;
  }

  function defaults() {
    return normalize({
      habits: [
        { id: 'gym', name: 'Gym', emoji: '🏋️', color: COLORS[0], perWeek: 4, unit: 'minutes' },
        { id: 'reading', name: 'Reading', emoji: '📚', color: COLORS[1], perWeek: 7, unit: 'pages' },
        { id: 'film', name: 'Film', emoji: '🎬', color: COLORS[4], perWeek: 2, unit: '' },
        { id: 'cardio', name: 'Cardio', emoji: '🏃', color: COLORS[2], perWeek: 3, unit: 'km' },
      ],
      logs: {},
    });
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      showNotice("This browser is blocking saved data, so today's entries won't be kept.");
      return defaults();
    }
    if (raw === null) return defaults();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.habits) && parsed.logs && typeof parsed.logs === 'object') return normalize(parsed);
      throw new Error('unexpected shape');
    } catch (e) {
      try { localStorage.setItem(STORAGE_KEY + '.broken', raw); } catch (ignored) { /* nothing more to try */ }
      showNotice('Your saved data could not be read. A copy was kept and the app started fresh.');
      return defaults();
    }
  }

  let data = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      showNotice('Your last change could not be saved.');
    }
  }

  /* ---------- Syncing between devices ----------
     Every change is saved on this device first and queued in data.pending.
     A sync downloads everything, keeps whichever version of each entry is newest,
     then uploads what's still queued. Deleted items stay online marked "deleted"
     so the other device learns about the deletion. */
  let client = null;
  let needsLogin = !data.meta.userId;
  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  let clock = 0;
  let renderWaiting = false;

  function tick() {
    clock = Math.max(Date.now(), clock + 1);
    return clock;
  }

  function habitRow(h, deleted) {
    return {
      user_id: data.meta.userId, id: h.id, name: h.name, emoji: h.emoji, color: h.color,
      per_week: h.perWeek, unit: h.unit, pos: h.pos, deleted: Boolean(deleted), t: h.t,
    };
  }

  function logRow(day, habitId, entry, t) {
    return {
      user_id: data.meta.userId, day, habit_id: habitId,
      value: entry && entry.v !== undefined ? entry.v : null, deleted: !entry, t,
    };
  }

  function touchHabit(h, deleted) {
    h.t = tick();
    data.pending.habits[h.id] = habitRow(h, deleted);
    scheduleSync();
  }

  function touchLog(day, habitId) {
    const entry = data.logs[day] && data.logs[day][habitId];
    const t = tick();
    if (entry) entry.t = t;
    data.pending.logs[`${day}|${habitId}`] = logRow(day, habitId, entry, t);
    scheduleSync();
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 800);
  }

  function setSyncText(text) {
    document.getElementById('sync').textContent = text;
  }

  async function fetchAll(table, columns) {
    const size = 1000;
    const rows = [];
    for (let from = 0; ; from += size) {
      let query = client.from(table).select('*');
      columns.forEach((c) => { query = query.order(c); });
      const { data: page, error } = await query.range(from, from + size - 1);
      if (error) throw error;
      rows.push(...page);
      if (page.length < size) return rows;
    }
  }

  function queueEverythingLocal(cloudHasHabits) {
    // A brand-new device shouldn't push its untouched starter habits over the real ones.
    if (cloudHasHabits) data.habits = data.habits.filter((h) => h.t || !DEFAULT_IDS.includes(h.id));
    data.habits.forEach((h) => {
      h.t = h.t || 1;
      data.pending.habits[h.id] = habitRow(h, false);
    });
    Object.keys(data.logs).forEach((day) => {
      Object.keys(data.logs[day]).forEach((id) => {
        const entry = data.logs[day][id];
        entry.t = entry.t || 1;
        data.pending.logs[`${day}|${id}`] = logRow(day, id, entry, entry.t);
      });
    });
  }

  function mergeCloud(habitRows, logRows) {
    let changed = false;
    if (!data.meta.synced) {
      queueEverythingLocal(habitRows.length > 0);
      data.meta.synced = true;
      changed = true;
    }

    habitRows.forEach((r) => {
      clock = Math.max(clock, r.t);
      const queued = data.pending.habits[r.id];
      if (queued) {
        if (queued.t > r.t) return;
        delete data.pending.habits[r.id];
      }
      const i = data.habits.findIndex((h) => h.id === r.id);
      if (r.deleted) {
        if (i >= 0) { data.habits.splice(i, 1); changed = true; }
        return;
      }
      if (i >= 0 && data.habits[i].t === r.t) return;
      const fields = { id: r.id, name: r.name, emoji: r.emoji, color: r.color, perWeek: r.per_week, unit: r.unit, pos: r.pos, t: r.t };
      if (i >= 0) Object.assign(data.habits[i], fields);
      else data.habits.push(fields);
      changed = true;
    });
    data.habits.sort((a, b) => (a.pos - b.pos) || a.id.localeCompare(b.id));

    logRows.forEach((r) => {
      clock = Math.max(clock, r.t);
      const key = `${r.day}|${r.habit_id}`;
      const queued = data.pending.logs[key];
      if (queued) {
        if (queued.t > r.t) return;
        delete data.pending.logs[key];
      }
      const current = data.logs[r.day] && data.logs[r.day][r.habit_id];
      if (r.deleted) {
        if (current) {
          delete data.logs[r.day][r.habit_id];
          if (!Object.keys(data.logs[r.day]).length) delete data.logs[r.day];
          changed = true;
        }
        return;
      }
      if (current && current.t === r.t) return;
      data.logs[r.day] = data.logs[r.day] || {};
      data.logs[r.day][r.habit_id] = { v: r.value, t: r.t };
      changed = true;
    });
    return changed;
  }

  async function uploadQueue(table, queue, conflict) {
    const entries = Object.entries(queue);
    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500);
      const rows = batch.map(([, row]) => Object.assign({}, row, { user_id: data.meta.userId }));
      const { error } = await client.from(table).upsert(rows, { onConflict: conflict });
      if (error) throw error;
      batch.forEach(([key, row]) => {
        if (queue[key] && queue[key].t === row.t) delete queue[key];
      });
      save();
    }
  }

  const pendingCount = () => Object.keys(data.pending.habits).length + Object.keys(data.pending.logs).length;

  async function syncNow() {
    if (!client || needsLogin || !data.meta.userId) return;
    if (syncing) { syncAgain = true; return; }
    clearTimeout(syncTimer);
    syncing = true;
    setSyncText('Syncing…');
    try {
      const [habitRows, logRows] = await Promise.all([
        fetchAll('habits', ['id']),
        fetchAll('logs', ['day', 'habit_id']),
      ]);
      const changed = mergeCloud(habitRows, logRows);
      save();
      await uploadQueue('habits', data.pending.habits, 'user_id,id');
      await uploadQueue('logs', data.pending.logs, 'user_id,day,habit_id');
      data.meta.lastSync = Date.now();
      save();
      setSyncText('Synced');
      if (changed) renderWhenIdle();
    } catch (e) {
      console.warn('Sync failed', e);
      setSyncText(navigator.onLine ? 'Sync problem, will retry' : 'Offline, saved here');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  // Don't redraw under someone's fingers while they're typing.
  function renderWhenIdle() {
    if (editor.open || (document.activeElement && document.activeElement.matches('.amount input'))) {
      renderWaiting = true;
      return;
    }
    render();
  }

  /* ---------- Habit maths ---------- */
  const isDone = (id, day) => Boolean(data.logs[day] && data.logs[day][id]);
  const isDaily = (h) => h.perWeek >= 7;
  const doneDays = (id) => Object.keys(data.logs).filter((k) => data.logs[k][id]).sort();

  function weekCount(id, monday) {
    let count = 0;
    for (let i = 0; i < 7; i++) if (isDone(id, addDays(monday, i))) count++;
    return count;
  }

  // Daily habits count days in a row. Other habits count weeks in a row with the goal met.
  // Today, or the current week, can only add to a streak: it never breaks one until it's over.
  function streakInfo(h) {
    const today = todayKey();
    const days = doneDays(h.id);
    let cur = 0;
    let best = 0;

    if (isDaily(h)) {
      let k = isDone(h.id, today) ? today : addDays(today, -1);
      while (isDone(h.id, k)) { cur++; k = addDays(k, -1); }
      let run = 0;
      let prev = null;
      days.forEach((d) => {
        run = prev && addDays(prev, 1) === d ? run + 1 : 1;
        best = Math.max(best, run);
        prev = d;
      });
      return { cur, best, word: 'day' };
    }

    const thisWeek = weekStart(today);
    if (weekCount(h.id, thisWeek) >= h.perWeek) cur = 1;
    let w = addDays(thisWeek, -7);
    while (weekCount(h.id, w) >= h.perWeek) { cur++; w = addDays(w, -7); }
    if (days.length) {
      let run = 0;
      for (let m = weekStart(days[0]); m <= thisWeek; m = addDays(m, 7)) {
        run = weekCount(h.id, m) >= h.perWeek ? run + 1 : 0;
        best = Math.max(best, run);
      }
    }
    return { cur, best, word: 'week' };
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const fmtNum = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const schedule = (h) => (isDaily(h) ? 'Every day' : `${h.perWeek} ${h.perWeek === 1 ? 'time' : 'times'} a week`);

  /* ---------- Screens ---------- */
  let tab = 'today';
  let viewDay = null; // null means "whatever today is"
  let calFilter = 'all';
  let lastToggled = null;
  let lastRenderedToday = todayKey();

  function cardStatus(h, day) {
    const monday = weekStart(day);
    const current = monday === weekStart(todayKey());
    const label = current ? 'this week' : 'that week';
    const parts = [];
    if (!isDaily(h)) {
      const n = weekCount(h.id, monday);
      parts.push(n >= h.perWeek ? `Goal met ${label}` : `${n} of ${h.perWeek} ${label}`);
    }
    const s = streakInfo(h);
    if (s.cur > 0) parts.push(`🔥 ${plural(s.cur, s.word)}`);
    else if (isDaily(h)) parts.push('Every day');
    return parts.join(' · ');
  }

  function renderToday() {
    const today = todayKey();
    const day = viewDay || today;
    const isToday = day === today;
    const title = isToday ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : fmtDate(day, { weekday: 'long' });
    const done = data.habits.filter((h) => isDone(h.id, day)).length;
    const total = data.habits.length;

    const cards = data.habits.map((h) => {
      const entry = data.logs[day] && data.logs[day][h.id];
      const value = entry && entry.v !== null && entry.v !== undefined ? entry.v : '';
      const amount = entry && h.unit
        ? `<label class="amount"><input type="number" inputmode="decimal" min="0" step="any" placeholder="Add" value="${value}" data-id="${esc(h.id)}" data-day="${day}" aria-label="${esc(h.name)} amount in ${esc(h.unit)}"> ${esc(h.unit)}</label>`
        : '';
      return `<article class="card${entry ? ' is-done' : ''}${lastToggled === h.id && entry ? ' just-done' : ''}" style="--c:${esc(h.color)}">
        <button class="card-main" data-action="toggle" data-id="${esc(h.id)}" aria-pressed="${entry ? 'true' : 'false'}">
          <span class="emoji" aria-hidden="true">${esc(h.emoji)}</span>
          <span class="card-text"><span class="name">${esc(h.name)}</span><span class="status">${esc(cardStatus(h, day))}</span></span>
          <span class="tick">${TICK}</span>
        </button>${amount}
      </article>`;
    }).join('');

    view.innerHTML = `
      <section class="day-head">
        <button class="round" data-action="prev-day" aria-label="Previous day">‹</button>
        <div class="day-title"><h1>${title}</h1><p>${fmtDate(day, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
        <button class="round" data-action="next-day" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
      </section>
      ${total ? `<div class="tally">
        <div class="tally-bar"><div class="tally-fill" style="width:${(done / total) * 100}%"></div></div>
        <div class="tally-text">${done === total ? 'All done' : `${done} of ${total} done`}</div>
      </div>
      <div class="cards">${cards}</div>` : `<div class="empty"><p>You have no habits yet.</p><button class="primary" data-action="add">Add your first habit</button></div>`}`;
    lastToggled = null;
  }

  function statCard(h) {
    const today = todayKey();
    const monday = weekStart(today);
    const s = streakInfo(h);
    const n = weekCount(h.id, monday);
    const days = doneDays(h.id);
    const sum = days.reduce((acc, d) => acc + (Number(data.logs[d][h.id].v) || 0), 0);
    let pips = '';
    for (let i = 0; i < h.perWeek; i++) pips += `<div class="pip${i < n ? ' on' : ''}"></div>`;
    const totals = [plural(days.length, 'time')];
    if (h.unit && sum > 0) totals.push(`${fmtNum(sum)} ${h.unit}`);
    return `<article class="stat-card" style="--c:${esc(h.color)}">
      <div class="stat-top">
        <span class="emoji" aria-hidden="true">${esc(h.emoji)}</span>
        <div class="stat-name">${esc(h.name)}</div>
        <div class="stat-week">${n}/${h.perWeek} this week</div>
      </div>
      <div class="pips" aria-hidden="true">${pips}</div>
      <div class="stat-streak"><b>${s.cur}</b><span>${s.word}${s.cur === 1 ? '' : 's'} in a row</span></div>
      <div class="stat-foot">Best ${plural(s.best, s.word)} · ${esc(totals.join(' · '))}</div>
    </article>`;
  }

  function calendarHtml() {
    const today = todayKey();
    const first = addDays(weekStart(today), -52 * 7);
    const selected = data.habits.find((h) => h.id === calFilter) || null;
    const total = data.habits.length;
    let months = '';
    let cells = '';
    let lastMonth = -1;

    for (let w = 0; w < 53; w++) {
      const monday = addDays(first, w * 7);
      const date = parseKey(monday);
      if (date.getMonth() !== lastMonth) {
        if (w > 0 || date.getDate() <= 14) {
          months += `<span class="cal-month" style="grid-column:${w + 1} / span 3">${fmtDate(monday, { month: 'short' })}</span>`;
        }
        lastMonth = date.getMonth();
      }
      for (let d = 0; d < 7; d++) {
        const k = addDays(monday, d);
        if (k > today) break;
        let level = 0;
        let detail;
        if (selected) {
          const done = isDone(selected.id, k);
          level = done ? 4 : 0;
          detail = done ? 'done' : 'not done';
        } else {
          const n = data.habits.filter((h) => isDone(h.id, k)).length;
          if (n > 0) {
            const share = n / total;
            level = share === 1 ? 4 : share > 0.66 ? 3 : share > 0.33 ? 2 : 1;
          }
          detail = `${n} of ${total} done`;
        }
        const label = `${fmtDate(k, { weekday: 'short', day: 'numeric', month: 'short' })}: ${detail}`;
        cells += `<button class="cell${level ? ` l${level}` : ''}${k === today ? ' is-today' : ''}" tabindex="-1" style="grid-column:${w + 1};grid-row:${d + 2}" data-action="goto-day" data-day="${k}" title="${label}" aria-label="${label}"></button>`;
      }
    }

    const chips = [`<button class="chip${selected ? '' : ' is-active'}" data-action="cal-filter" data-id="all">All habits</button>`]
      .concat(data.habits.map((h) => `<button class="chip${selected && selected.id === h.id ? ' is-active' : ''}" data-action="cal-filter" data-id="${esc(h.id)}">${esc(h.emoji)} ${esc(h.name)}</button>`))
      .join('');
    const legend = selected ? '' : `<div class="legend"><span>Fewer</span><i class="cell"></i><i class="cell l1"></i><i class="cell l2"></i><i class="cell l3"></i><i class="cell l4"></i><span>All habits</span></div>`;

    return `<div class="chips">${chips}</div>
      <div class="cal-card" style="--fill:${selected ? esc(selected.color) : 'var(--accent)'}">
        <div class="cal-wrap">
          <div class="cal-days" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
          <div class="cal-scroll"><div class="cal">${months}${cells}</div></div>
        </div>
        ${legend}
      </div>
      <p class="hint">Tap any day to open it and fill in something you forgot.</p>`;
  }

  function renderProgress() {
    if (!data.habits.length) {
      view.innerHTML = `<h1 class="page-title">Progress</h1><div class="empty"><p>Add a habit and your progress will appear here.</p><button class="primary" data-action="add">Add a habit</button></div>`;
      return;
    }
    view.innerHTML = `
      <h1 class="page-title">Progress</h1>
      <div class="cards">${data.habits.map(statCard).join('')}</div>
      <h2 class="section-title">Your year</h2>
      ${calendarHtml()}`;
    const scroller = view.querySelector('.cal-scroll');
    scroller.scrollLeft = scroller.scrollWidth; // show the most recent weeks first on phones
  }

  function renderHabits() {
    const rows = data.habits.map((h, i) => `<div class="row">
        <span class="emoji" style="--c:${esc(h.color)}" aria-hidden="true">${esc(h.emoji)}</span>
        <div class="row-text"><b>${esc(h.name)}</b><span>${schedule(h)}${h.unit ? ` · tracks ${esc(h.unit)}` : ''}</span></div>
        <button class="icon-btn" data-action="move-up" data-id="${esc(h.id)}" aria-label="Move ${esc(h.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-action="move-down" data-id="${esc(h.id)}" aria-label="Move ${esc(h.name)} down" ${i === data.habits.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="text-btn" data-action="edit" data-id="${esc(h.id)}" aria-label="Edit ${esc(h.name)}">Edit</button>
      </div>`).join('');
    const synced = data.meta.lastSync
      ? new Date(data.meta.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : 'not yet';
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Habits</h1><button class="primary" data-action="add">Add habit</button></div>
      ${rows ? `<div class="list">${rows}</div>` : `<div class="empty"><p>You have no habits yet.</p></div>`}
      <div class="account">
        <div class="row-text"><b>${esc(data.meta.email || 'Signed in')}</b><span>Last synced: ${synced}</span></div>
        <button class="text-btn" data-action="sign-out">Sign out</button>
      </div>`;
  }

  /* ---------- Sign-in screen ---------- */
  let loginMode = 'signin';
  let loginEmail = '';

  function renderLogin() {
    const creating = loginMode === 'create';
    view.innerHTML = `<section class="login">
      <h1 class="page-title">${creating ? 'Create your account' : 'Sign in'}</h1>
      <p class="login-sub">Your habits stay in sync on your laptop and phone.</p>
      <form id="login-form" novalidate>
        <label class="field"><span class="field-label">Email</span>
          <input class="text-input" type="email" name="email" autocomplete="username" autocapitalize="off" required value="${esc(loginEmail)}"></label>
        <label class="field"><span class="field-label">Password</span>
          <input class="text-input" type="password" name="password" autocomplete="${creating ? 'new-password' : 'current-password'}" required></label>
        ${creating ? '<p class="field-hint login-hint">Use at least 8 characters.</p>' : ''}
        <p class="field-hint danger" id="login-error" role="alert" hidden></p>
        <button class="primary login-go" type="submit">${creating ? 'Create account' : 'Sign in'}</button>
      </form>
      <button class="text-btn login-switch" data-action="login-mode">${creating ? 'I already have an account' : 'First time? Create an account'}</button>
    </section>`;
  }

  function friendlyAuthError(error) {
    const text = String(error.message || '').toLowerCase();
    if (text.includes('invalid login')) return "That email or password doesn't match.";
    if (text.includes('email not confirmed')) return 'Please confirm your email first, using the link we sent you.';
    if (text.includes('not allowed') || text.includes('disabled')) return 'New accounts are switched off for this app.';
    if (text.includes('already registered')) return 'That email already has an account. Try signing in instead.';
    if (text.includes('fetch') || text.includes('network')) return "Couldn't reach the internet. Please try again.";
    return error.message || 'Something went wrong. Please try again.';
  }

  async function submitLogin(form) {
    const errorEl = form.querySelector('#login-error');
    const button = form.querySelector('.login-go');
    const fail = (text) => { errorEl.textContent = text; errorEl.hidden = false; };
    const email = form.email.value.trim();
    const password = form.password.value;
    loginEmail = email;
    errorEl.hidden = true;
    if (!client) return fail("The sign-in service didn't load. Please reload the page.");
    if (!email || !password) return fail('Please enter your email and password.');
    if (loginMode === 'create' && password.length < 8) return fail('Please use at least 8 characters.');

    button.disabled = true;
    try {
      const { data: result, error } = loginMode === 'create'
        ? await client.auth.signUp({ email, password })
        : await client.auth.signInWithPassword({ email, password });
      if (error) return fail(friendlyAuthError(error));
      if (!result.session) fail('Almost there: check your email and open the link to confirm your account, then sign in here.');
    } catch (e) {
      fail(friendlyAuthError(e));
    } finally {
      button.disabled = false;
    }
  }

  function handleAuth(event, session) {
    if (session && session.user) {
      const user = session.user;
      if (data.meta.userId && data.meta.userId !== user.id) data = defaults();
      const wasSignedOut = needsLogin;
      data.meta.userId = user.id;
      data.meta.email = user.email || '';
      save();
      needsLogin = false;
      if (wasSignedOut) render();
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') syncNow();
      return;
    }
    // With no internet the session can't be refreshed. That isn't the same as being signed out.
    if (event === 'SIGNED_OUT' || navigator.onLine) {
      needsLogin = true;
      render();
    }
  }

  async function signOut(button) {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.textContent = 'Tap again to sign out';
      return;
    }
    await syncNow();
    if (pendingCount() > 0) {
      delete button.dataset.armed;
      button.textContent = 'Not synced yet, check internet';
      return;
    }
    data = defaults();
    save();
    await client.auth.signOut({ scope: 'local' });
    needsLogin = true;
    render();
  }

  function render() {
    lastRenderedToday = todayKey();
    renderWaiting = false;
    document.body.classList.toggle('needs-login', needsLogin);
    if (needsLogin) {
      setSyncText('');
      renderLogin();
      return;
    }
    document.querySelectorAll('.tab').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (tab === 'progress') renderProgress();
    else if (tab === 'habits') renderHabits();
    else renderToday();
  }

  function refocus(action, id) {
    const sel = `[data-action="${action}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}`;
    const el = view.querySelector(sel);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  /* ---------- Add / edit dialog ---------- */
  let editingId = null;

  function openEditor(id) {
    editingId = id || null;
    const h = data.habits.find((x) => x.id === id);
    const used = data.habits.map((x) => x.color);
    const current = h || {
      name: '', emoji: EMOJIS[0], perWeek: 7, unit: '',
      color: COLORS.find((c) => !used.includes(c)) || COLORS[0],
    };
    const emojis = EMOJIS.includes(current.emoji) ? EMOJIS : [current.emoji].concat(EMOJIS);
    const freq = [1, 2, 3, 4, 5, 6, 7];
    editor.innerHTML = `<form id="habit-form" novalidate>
      <h2>${h ? 'Edit habit' : 'New habit'}</h2>
      <label class="field"><span class="field-label">Name</span>
        <input class="text-input" name="name" maxlength="30" required value="${esc(current.name)}" placeholder="e.g. Meditation" autocomplete="off"></label>
      <fieldset class="field"><legend class="field-label">Icon</legend><div class="choices">
        ${emojis.map((e) => `<label class="choice"><input type="radio" name="emoji" value="${esc(e)}" ${e === current.emoji ? 'checked' : ''} aria-label="${esc(e)}"><span>${esc(e)}</span></label>`).join('')}
      </div></fieldset>
      <fieldset class="field"><legend class="field-label">Colour</legend><div class="choices">
        ${COLORS.map((c, i) => `<label class="choice swatch" style="--swatch:${c}"><input type="radio" name="color" value="${c}" ${c === current.color ? 'checked' : ''} aria-label="Colour ${i + 1}"><span></span></label>`).join('')}
      </div></fieldset>
      <fieldset class="field"><legend class="field-label">Goal: how many times a week?</legend><div class="choices">
        ${freq.map((n) => `<label class="choice num"><input type="radio" name="perWeek" value="${n}" ${n === current.perWeek ? 'checked' : ''}><span>${n === 7 ? 'Every day' : n}</span></label>`).join('')}
      </div></fieldset>
      <label class="field"><span class="field-label">Number to track (optional)</span>
        <input class="text-input" name="unit" maxlength="16" value="${esc(current.unit)}" placeholder="minutes, pages, km…" autocomplete="off">
        <p class="field-hint">Leave empty if a simple tick is enough.</p></label>
      <p class="field-hint danger" id="form-error" hidden>Please give the habit a name.</p>
      <div class="dialog-actions">
        ${h ? '<button type="button" class="text-btn danger" data-action="delete">Delete</button>' : ''}
        <div class="spacer"></div>
        <button type="button" class="text-btn" data-action="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>`;
    editor.showModal();
    editor.scrollTop = 0;
    if (!h) editor.querySelector('[name=name]').focus();
  }

  function submitEditor(form) {
    const fields = new FormData(form);
    const name = String(fields.get('name')).trim();
    if (!name) {
      form.querySelector('#form-error').hidden = false;
      form.querySelector('[name=name]').focus();
      return;
    }
    const values = {
      name,
      emoji: String(fields.get('emoji')),
      color: String(fields.get('color')),
      perWeek: Number(fields.get('perWeek')),
      unit: String(fields.get('unit')).trim(),
    };
    const existing = data.habits.find((h) => h.id === editingId);
    if (existing) {
      Object.assign(existing, values);
      touchHabit(existing, false);
    } else {
      const created = Object.assign({
        id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        pos: data.habits.reduce((max, h) => Math.max(max, h.pos), -1) + 1,
      }, values);
      data.habits.push(created);
      touchHabit(created, false);
    }
    save();
    editor.close();
    render();
  }

  function deleteHabit(id) {
    const removed = data.habits.find((h) => h.id === id);
    if (removed) touchHabit(removed, true);
    data.habits = data.habits.filter((h) => h.id !== id);
    Object.keys(data.logs).forEach((k) => {
      if (!data.logs[k][id]) return;
      delete data.logs[k][id];
      touchLog(k, id);
      if (!Object.keys(data.logs[k]).length) delete data.logs[k];
    });
    if (calFilter === id) calFilter = 'all';
    save();
    editor.close();
    render();
  }

  /* ---------- Taps and typing ---------- */
  function goTo(next) {
    tab = next;
    if (location.hash.slice(1) !== next) history.replaceState(null, '', '#' + next);
    render();
    window.scrollTo(0, 0);
  }

  function moveHabit(id, delta) {
    const i = data.habits.findIndex((h) => h.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= data.habits.length) return;
    [data.habits[i], data.habits[j]] = [data.habits[j], data.habits[i]];
    data.habits.forEach((h, position) => {
      if (h.pos !== position) {
        h.pos = position;
        touchHabit(h, false);
      }
    });
    save();
    render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    switch (action) {
      case 'tab':
        viewDay = null;
        goTo(el.dataset.tab);
        break;
      case 'toggle': {
        const day = viewDay || todayKey();
        if (isDone(id, day)) {
          delete data.logs[day][id];
          if (!Object.keys(data.logs[day]).length) delete data.logs[day];
        } else {
          data.logs[day] = data.logs[day] || {};
          data.logs[day][id] = { v: null };
          lastToggled = id;
        }
        touchLog(day, id);
        save();
        render();
        refocus('toggle', id);
        break;
      }
      case 'prev-day':
        viewDay = addDays(viewDay || todayKey(), -1);
        render();
        refocus('prev-day');
        break;
      case 'next-day': {
        const next = addDays(viewDay || todayKey(), 1);
        viewDay = next >= todayKey() ? null : next;
        render();
        refocus(viewDay ? 'next-day' : 'prev-day');
        break;
      }
      case 'goto-day':
        viewDay = el.dataset.day === todayKey() ? null : el.dataset.day;
        goTo('today');
        break;
      case 'cal-filter':
        calFilter = id;
        render();
        refocus('cal-filter', id);
        break;
      case 'add':
        openEditor(null);
        break;
      case 'edit':
        openEditor(id);
        break;
      case 'move-up':
        moveHabit(id, -1);
        refocus('move-up', id);
        break;
      case 'move-down':
        moveHabit(id, 1);
        refocus('move-down', id);
        break;
      case 'cancel':
        editor.close();
        break;
      case 'login-mode':
        loginEmail = view.querySelector('[name=email]').value.trim();
        loginMode = loginMode === 'create' ? 'signin' : 'create';
        render();
        break;
      case 'sign-out':
        signOut(el);
        break;
      case 'delete':
        if (el.dataset.armed) deleteHabit(editingId);
        else {
          el.dataset.armed = '1';
          el.textContent = 'Delete habit and history?';
        }
        break;
      default:
        break;
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'habit-form') {
      e.preventDefault();
      submitEditor(e.target);
    } else if (e.target.id === 'login-form') {
      e.preventDefault();
      submitLogin(e.target);
    }
  });

  editor.addEventListener('close', () => { if (renderWaiting) render(); });
  document.addEventListener('focusout', (e) => {
    if (renderWaiting && e.target.matches('.amount input')) setTimeout(renderWhenIdle, 0);
  });

  // Numbers save as you type. No redraw here, so the keyboard stays open.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches('.amount input')) return;
    const entry = data.logs[el.dataset.day] && data.logs[el.dataset.day][el.dataset.id];
    if (!entry) return;
    const v = parseFloat(el.value);
    entry.v = Number.isFinite(v) && v >= 0 ? v : null;
    touchLog(el.dataset.day, el.dataset.id);
    save();
  });

  // If the app was left open overnight, roll over to the new day when it's looked at again.
  function refreshIfNewDay() {
    if (document.visibilityState !== 'visible' || needsLogin) return;
    if (todayKey() !== lastRenderedToday && !editor.open) render();
    syncNow();
  }
  document.addEventListener('visibilitychange', refreshIfNewDay);
  window.addEventListener('focus', refreshIfNewDay);
  window.addEventListener('online', syncNow);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);

  /* ---------- Start ---------- */
  function tabFromAddress() {
    const wanted = location.hash.slice(1);
    if (['today', 'progress', 'habits'].includes(wanted)) tab = wanted;
  }
  window.addEventListener('hashchange', () => {
    tabFromAddress();
    render();
  });
  tabFromAddress();
  render();

  if (window.supabase && window.STEADY_CONFIG) {
    client = window.supabase.createClient(window.STEADY_CONFIG.url, window.STEADY_CONFIG.key);
    // Deferred so the auth library has finished its own work before we call it again.
    client.auth.onAuthStateChange((event, session) => { setTimeout(() => handleAuth(event, session), 0); });
  } else {
    showNotice("The sign-in service didn't load, so changes will stay on this device for now.");
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline support unavailable', e));
  }
})();

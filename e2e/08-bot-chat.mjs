// ============ E2E 8: botlar chatda GAPIRADI va odamga JAVOB beradi ============
//
// Talab: "soxta odamlarimizni aqlliroq qiling — chatda yozishsin va o'yinda
// faol o'ynasin". Bu yerda haqiqiy serverga qarshi tekshiriladi:
//   1) kutish xonasida odam "salom" desa bot javob beradi;
//   2) kunduzgi muhokamada botlar bir necha marta yozadi;
//   3) odam botni NOMI bilan ayblasa, AYNAN o'sha bot javob qaytaradi;
//   4) odam "men komissarman" desa botlar munosabat bildiradi;
//   5) odam mafiya bo'lsa, tunda bot sherigi mafiya kanalida gapiradi va odam
//      tanlamasa botlar o'zlari nishon tanlaydi (faollik).
//
// `BOT_FILL=1` talab qiladi (1-4). 5-bo'lim "botlar bilan o'ynash" xonasida.
import { io } from 'socket.io-client';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const ADMIN_KEY = process.env.E2E_ADMIN_KEY || 'e2ekey';
const PASS = 'e2e-parol-12345';
const URINISH = Number(process.env.E2E_URINISH || 14);

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(p, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function reg(u) {
  let r = await http('/api/register', { method: 'POST', body: { username: u, password: PASS } });
  if (r.status === 409) r = await http('/api/login', { method: 'POST', body: { username: u, password: PASS } });
  if (!r.json?.token) throw new Error('reg ' + u + ': ' + r.status + ' ' + r.text.slice(0, 160));
  return r.json;
}
function connect(user) {
  const s = io(API, { transports: ['websocket'], auth: { token: user.token } });
  s.evts = new Map();
  s.onAny?.((ev, d) => { if (!s.evts.has(ev)) s.evts.set(ev, []); s.evts.get(ev).push(d); });
  s.waitFor = (ev, ms = 15000) => new Promise((res, rej) => {
    const a = s.evts.get(ev); if (a?.length) return res(a[a.length - 1]);
    const t = setTimeout(() => rej(new Error('kutish: ' + ev)), ms);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });
  s.all = (ev) => s.evts.get(ev) || [];
  s.last = (ev) => { const a = s.evts.get(ev); return a?.length ? a[a.length - 1] : null; };
  return s;
}
// `from` — shu vaqtdan keyin kelgan, `who` (yoki odam emas) yozgan chat xabarlari
function botMsgs(s, me, from = 0, pred = null) {
  return s.all('chat_message').filter((m) => m && m.username !== me && (m.timestamp || 0) >= from && (!pred || pred(m)));
}
async function waitMsg(s, me, from, pred, ms) {
  const chek = Date.now() + ms;
  while (Date.now() < chek) {
    const hit = botMsgs(s, me, from, pred);
    if (hit.length) return hit[0];
    await sleep(300);
  }
  return null;
}
async function kutFaza(s, phase, ms = 120000) {
  const chek = Date.now() + ms;
  while (Date.now() < chek) {
    const ph = s.last('phase_change')?.phase || s.last('game_state')?.phase;
    if (ph === phase) return true;
    if (s.last('game_state')?.status === 'finished') return false;
    await sleep(300);
  }
  return false;
}

async function main() {
  const admin = await reg('e2e_admin');
  const st = await http('/api/admin/settings', {
    method: 'PUT', token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY },
    body: {
      minPlayers: 5,
      durations: {
        day_discussion: 45, day_results: 3, night_results: 3, night_skip: 1,
        night_mafia: 20, night_komissar: 4, night_doctor: 4, night_escort: 4,
        night_advokat: 4, night_qotil: 4, night_daydi: 4,
      },
    },
  });
  ok(st.status === 200, 'sozlamalar (kunduz 45 s, mafiya tuni 20 s)', st.status + ' ' + st.text.slice(0, 120));

  // ================= 1. KUTISH XONASI =================
  log('\n=== 1. Kutish xonasida salomga javob ===');
  const u = await reg('e2e_chat1');
  const mk = await http('/api/games', { method: 'POST', token: u.token, body: { name: 'chat sinovi', totalPlayers: 8, isPrivate: false } });
  ok(!!mk.json?.id, 'xona yaratildi', mk.status + ' ' + mk.text.slice(0, 120));
  const gameId = mk.json.id;
  const s = connect(u);
  await s.waitFor('connect').catch(() => null);
  s.emit('join_game', { gameId, userId: u.userId, username: u.username });

  // Botlar bittalab kiradi — kamida 5 o'yinchi bo'lguncha kutamiz
  let toldi = false;
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    if ((s.last('game_state')?.players || []).length >= 5) { toldi = true; break; }
  }
  ok(toldi, 'xonaga botlar keldi (>=5)', 'soni: ' + (s.last('game_state')?.players || []).length);

  const t0 = Date.now();
  s.emit('chat_message', { gameId, message: 'salom hammaga' });
  const hi = await waitMsg(s, u.username, t0, null, 12000);
  ok(!!hi, 'bot salomga javob berdi', hi ? hi.username + ': ' + hi.message : 'javob yo\'q');

  // ================= 2-4. KUNDUZ =================
  log('\n=== 2. Kunduzgi muhokamada botlar yozadi ===');
  s.emit('chat_message', { gameId, message: 'goo' });
  const day = await kutFaza(s, 'day_discussion', 60000);
  ok(day, 'o\'yin boshlandi, kunduz keldi');
  const dayAt = Date.now();
  const players = s.last('game_state')?.players || [];
  const bots = players.filter((p) => p.username !== u.username && p.isAlive !== false);

  // 3) Odam botni NOMI bilan aybladi
  await sleep(4000);
  const target = bots[0];
  const t3 = Date.now();
  s.emit('chat_message', { gameId, message: `${target.username} mafiya` });
  // O'qish (1.5-5 s) + yozish (uzun gap 12 s gacha) — 20 s oynasi kerak
  const reply = await waitMsg(s, u.username, t3, (m) => m.username === target.username && m.channel === 'public', 20000);
  log('\n=== 3. Ayblangan bot javob beradi ===');
  ok(!!reply, `"${target.username} mafiya" ga AYNAN ${target.username} javob berdi`, reply ? reply.message : 'javob yo\'q');

  // 4) Odam komissar deb ochildi
  await sleep(2500);
  const t4 = Date.now();
  const other = bots[1];
  s.emit('chat_message', { gameId, message: `men komissarman ${other.username} mafiya` });
  const react = await waitMsg(s, u.username, t4, (m) => m.channel === 'public', 14000);
  log('\n=== 4. Komissar da\'vosiga munosabat ===');
  ok(!!react, 'botlar da\'voga munosabat bildirdi', react ? react.username + ': ' + react.message : 'yo\'q');

  // 2) Butun kun davomida nechta bot gapi bo'ldi
  const dayLen = 45000;
  const qoldi = dayLen - (Date.now() - dayAt);
  if (qoldi > 0) await sleep(Math.min(qoldi, 40000));
  const dayMsgs = botMsgs(s, u.username, dayAt, (m) => m.channel === 'public');
  const speakers = new Set(dayMsgs.map((m) => m.username));
  ok(dayMsgs.length >= 4, 'kunduzda kamida 4 ta bot gapi', 'soni: ' + dayMsgs.length);
  ok(speakers.size >= 2, 'kamida 2 xil bot gapirdi', [...speakers].join(','));
  ok(new Set(dayMsgs.map((m) => m.message)).size === dayMsgs.length, 'bir xil gap takrorlanmadi',
    dayMsgs.map((m) => m.message).join(' | '));
  log('  namunalar: ' + dayMsgs.slice(0, 5).map((m) => m.username + ': ' + m.message).join(' | '));
  s.disconnect();

  // ================= 5. MAFIYA KANALI =================
  log('\n=== 5. Odam mafiya: bot sherigi kanalda gapiradi, odam AFK bo\'lsa o\'zi tanlaydi ===');
  let sinaldi = false;
  for (let i = 1; i <= URINISH && !sinaldi; i++) {
    const m = await reg('e2e_chatm' + i);
    const mk2 = await http('/api/games/bots', { method: 'POST', token: m.token, body: {} });
    if (!mk2.json?.id) { log(`  ${i}-urinish: xona yaratilmadi (${mk2.status})`); continue; }
    const g2 = mk2.json.id;
    const sm = connect(m);
    await sm.waitFor('connect').catch(() => null);
    sm.emit('join_game', { gameId: g2, userId: m.userId, username: m.username });
    const rol = await sm.waitFor('your_role', 20000).catch(() => null);
    if (!rol || !['mafia', 'don'].includes(rol.role)) { sm.emit('leave_game', { gameId: g2 }); sm.disconnect(); continue; }
    log(`  ${i}-urinish: rol ${rol.role}`);
    const keldi = await kutFaza(sm, 'night_mafia', 120000);
    if (!keldi) { log('  night_mafia kelmadi'); sm.disconnect(); continue; }
    const nAt = Date.now();
    // Odam HECH NARSA qilmaydi (AFK). Sherik gapirishi va 60% da tanlashi kerak.
    // Birinchi gap 2.5-6 s kechikish + 3-5 s "yozish" — 11 s gacha cho'zilishi mumkin.
    const msg = await waitMsg(sm, m.username, nAt, (mm) => mm.channel === 'mafia', 15000);
    ok(!!msg, 'bot sherik mafiya kanalida gap boshladi', msg ? msg.username + ': ' + msg.message : 'yo\'q');
    // 20 s * 0.6 = 12 s dan keyin bot ovozlari paydo bo'ladi
    let votes = null;
    for (let k = 0; k < 40; k++) {
      await sleep(400);
      const v = sm.last('mafia_vote_update')?.votes || {};
      const botVotes = Object.entries(v).filter(([n, t]) => n !== m.username && t);
      if (botVotes.length) { votes = v; break; }
      if ((sm.last('phase_change')?.phase || '') !== 'night_mafia') break;
    }
    ok(!!votes, 'odam AFK — botlar o\'zlari nishon tanladi', JSON.stringify(votes || sm.last('mafia_vote_update')));
    // Tanlaganini AYTADI ham ("Aziz ni olaylik") — kanal jim qolmasin
    await sleep(6000);
    const mafiaMsgs = botMsgs(sm, m.username, nAt, (mm) => mm.channel === 'mafia');
    ok(mafiaMsgs.length >= 1, 'mafiya kanalida kamida bitta bot gapi bor',
      mafiaMsgs.map((x) => x.username + ': ' + x.message).join(' | ') || 'yo\'q');
    log('  mafiya kanali: ' + (mafiaMsgs.map((x) => x.username + ': ' + x.message).join(' | ') || '—'));
    sinaldi = true;
    sm.disconnect();
  }
  ok(sinaldi, `${URINISH} urinishda odam mafiya bo'lgan o'yin topildi`);

  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E8 XATOSI:', e?.stack || e); process.exit(2); });

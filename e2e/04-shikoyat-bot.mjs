// ============ E2E 4: shikoyat BOTGA ham ishlaydi va botni OSHKOR QILMAYDI ============
//
// 2026-09-18 auditi topgan nuqson: botga qilingan shikoyat har doim
// "Shikoyat yuborilmadi" berardi, odamga esa "yuborildi". Ikki oqibati:
//   1) xonalarning aksariyati botlar bilan to'lgani uchun shikoyatlar
//      amalda umuman ishlamasdi;
//   2) 🚩 tugmasi BEPUL BOT DETEKTORIGA aylangandi.
//
// Shu sababli bu yerda AYNAN farqning yo'qligi tekshiriladi.
import { io } from 'socket.io-client';
import { execSync } from 'child_process';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const PASS = 'e2e-parol-12345';
const REDIS = process.env.E2E_REDIS || 'redis-cli -n 9';

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redis = (cmd) => execSync(`${REDIS} ${cmd}`, { encoding: 'utf8' }).trim();

async function http(p, { method = 'GET', body, token } = {}) {
  const h = {};
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
  if (!r.json?.token) throw new Error('reg ' + u + ': ' + r.status + ' ' + r.text.slice(0, 140));
  return r.json;
}
function connect(user) {
  const s = io(API, { transports: ['websocket'], auth: { token: user.token } });
  s.evts = new Map();
  s.onAny?.((ev, d) => { if (!s.evts.has(ev)) s.evts.set(ev, []); s.evts.get(ev).push(d); });
  s.waitFor = (ev, ms = 12000) => new Promise((res, rej) => {
    const a = s.evts.get(ev); if (a?.length) return res(a[a.length - 1]);
    const t = setTimeout(() => rej(new Error('kutish: ' + ev)), ms);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });
  s.last = (ev) => { const a = s.evts.get(ev); return a?.length ? a[a.length - 1] : null; };
  return s;
}

async function main() {
  log('\n=== 0. Botlar bilan to\'lgan xona ===');
  const a = await reg('e2e_rep_a');
  const b = await reg('e2e_rep_b');

  const mk = await http('/api/games', {
    method: 'POST', token: a.token,
    body: { name: 'shikoyat sinovi', totalPlayers: 8, isPrivate: false },
  });
  ok(mk.status === 200 && mk.json?.id, 'xona yaratildi', mk.status + ' ' + mk.text.slice(0, 120));
  const g = mk.json.id;

  const sa = connect(a), sb = connect(b);
  await Promise.all([sa.waitFor('connect'), sb.waitFor('connect')].map((p) => p.catch(() => null)));
  sa.emit('join_game', { gameId: g, userId: a.userId, username: a.username });
  sb.emit('join_game', { gameId: g, userId: b.userId, username: b.username });
  // Botlar bittalab qo'shiladi (BOT_FILL yoqilgan bo'lishi kerak)
  await sleep(11000);

  const st = sa.last('game_state');
  const players = st?.players || [];
  const me = players.find((p) => p.username === a.username);
  const human = players.find((p) => p.username === b.username);
  const bots = players.filter((p) => p.username !== a.username && p.username !== b.username);
  ok(bots.length >= 1, 'xonada bot bor', 'o\'yinchilar: ' + players.length + ', bot: ' + bots.length);
  if (!bots.length) { log('\nBOT YO\'Q — BOT_FILL yoqilganini tekshiring'); process.exit(2); }

  log('\n=== 1. BOTGA shikoyat ODAMNIKI BILAN BIR XIL javob beradi ===');
  const before = Number(redis('llen reports'));

  sa.evts.delete('report_result');
  sa.emit('report_player', { gameId: g, targetSocketId: bots[0].socketId, type: 'voice_abuse', reason: 'sinov' });
  const rBot = await sa.waitFor('report_result', 10000).catch(() => null);
  ok(rBot?.ok === true, 'BOTGA shikoyat QABUL qilindi', JSON.stringify(rBot));
  ok(rBot?.code === 'reportSent', 'javob kodi odamniki bilan bir xil', JSON.stringify(rBot?.code));

  sa.evts.delete('report_result');
  sa.emit('report_player', { gameId: g, targetSocketId: human.socketId, type: 'chat_abuse', reason: 'sinov' });
  const rHum = await sa.waitFor('report_result', 10000).catch(() => null);
  ok(rHum?.ok === true, 'ODAMGA shikoyat qabul qilindi', JSON.stringify(rHum));

  // ENG MUHIMI: ikkala javob bir xil bo'lsin — aks holda bot detektori
  ok(JSON.stringify(rBot) === JSON.stringify(rHum),
    'BOT va ODAM javoblari AYNAN BIR XIL (detektor yo\'q)',
    'bot=' + JSON.stringify(rBot) + ' odam=' + JSON.stringify(rHum));

  log('\n=== 2. Takroriy shikoyat ham bir xil ishlaydi ===');
  sa.evts.delete('report_result');
  sa.emit('report_player', { gameId: g, targetSocketId: bots[0].socketId, type: 'afk' });
  const rBot2 = await sa.waitFor('report_result', 10000).catch(() => null);
  sa.evts.delete('report_result');
  sa.emit('report_player', { gameId: g, targetSocketId: human.socketId, type: 'afk' });
  const rHum2 = await sa.waitFor('report_result', 10000).catch(() => null);
  ok(rBot2?.code === 'reportDup', 'botga takroriy shikoyat "allaqachon" beradi', JSON.stringify(rBot2));
  ok(JSON.stringify(rBot2) === JSON.stringify(rHum2),
    'takroriy javoblar ham AYNAN BIR XIL', 'bot=' + JSON.stringify(rBot2) + ' odam=' + JSON.stringify(rHum2));

  log('\n=== 3. Kunlik hisob: bot ham hisobga olinadi (aks holda farq sezilardi) ===');
  const day = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const members = redis(`smembers rep:by:${a.userId}:${day}`).split('\n').filter(Boolean);
  ok(members.length === 2, 'kunlik to\'plamda IKKI nishon (bot + odam)', 'a\'zolar: ' + members.length);

  log('\n=== 4. Lekin BOT shikoyati adminga YOZILMAYDI ===');
  const after = Number(redis('llen reports'));
  ok(after - before === 1, 'adminga faqat ODAM shikoyati tushdi', 'qo\'shilgan: ' + (after - before));
  const last = JSON.parse(redis('lrange reports -1 -1'));
  ok(last.on === human.username, 'saqlangan shikoyat — odam haqida', 'on=' + last.on);
  ok(last.type === 'chat_abuse', 'tur saqlandi', 'type=' + last.type);

  // ================================================================
  // 2026-09-18 auditi: tez o'yin SANOQ BOSHLANGAN xonaga yuborardi va
  // o'yinchi kirib ulgurmay "O'yin boshlangan" halokatli ekraniga tushardi.
  log('\n=== 5. Tez o\'yin BOSHLANAYOTGAN xonaga yubormaydi ===');
  const c = await reg('e2e_rep_c');
  const dd = await reg('e2e_rep_d');
  const mk2 = await http('/api/games', {
    method: 'POST', token: c.token,
    body: { name: 'sanoq sinovi', totalPlayers: 6, isPrivate: false },
  });
  const g2 = mk2.json?.id;
  ok(!!g2, 'ikkinchi xona yaratildi', mk2.status + ' ' + mk2.text.slice(0, 120));
  const sc = connect(c);
  await sc.waitFor('connect').catch(() => null);
  sc.emit('join_game', { gameId: g2, userId: c.userId, username: c.username });

  // Botlar bittalab qo'shiladi — kamida `minPlayers` (5) bo'lishini kutamiz.
  let toldi = false;
  for (let i = 0; i < 100; i++) {
    await sleep(1200);
    const st = sc.last('game_state');
    if ((st?.players || []).length >= 5) { toldi = true; break; }
    if (st && st.status !== 'waiting') break;
  }
  ok(toldi, 'xonaga botlar to\'ldi (>=5)', 'o\'yinchilar: ' + (sc.last('game_state')?.players || []).length);

  // "goo" — odam boshlashni so'raydi: bot javob beradi va server 7-13
  // soniyalik sanoqni QUROLLAYDI. Aynan shu oynada tez o'yin bu xonani
  // bermasligi kerak.
  sc.emit('chat_message', { gameId: g2, message: 'goo' });
  let sanoq = false, boshlandi = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = sc.last('game_state');
    if ((st?.log || []).some((e) => e?.code === 'startingSoon')) { sanoq = true; break; }
    if (st?.status === 'playing') { boshlandi = true; break; }
  }
  ok(sanoq || boshlandi, 'xonada sanoq boshlandi', 'sanoq=' + sanoq + ' playing=' + boshlandi);

  const q = await http('/api/games/quick', { method: 'POST', token: dd.token });
  ok(q.status === 200 && !!q.json?.id, 'tez o\'yin javob berdi', q.status + ' ' + q.text.slice(0, 140));
  ok(q.json?.id !== g2, 'tez o\'yin boshlanayotgan xonani BERMADI', 'qaytdi: ' + q.json?.id + ' (xona: ' + g2 + ')');
  sc.disconnect();
  sa.disconnect(); sb.disconnect();
  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E4 XATOSI:', e?.stack || e); process.exit(2); });

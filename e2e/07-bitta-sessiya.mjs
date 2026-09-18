// ============ E2E 7: bitta hisob = bitta faol sessiya ============
//
// Talab: hisobga ikkinchi qurilmadan kirilib o'yinga qo'shilsa, ESKI
// qurilmadagi ulanish o'yindan chiqarilsin.
//
// Ilgari eski socket xonada QOLIB KETARDI: `remapSocketId` o'yinchini yangi
// socketga ko'chirar, eskisi esa `game:<id>` xonasida qolib `game_state`
// oqimini olishda davom etardi. Ekranda o'yin "tirik" ko'rinar, lekin hech
// bir tugma ishlamasdi — server o'yinchini socketId bo'yicha topadi.
//
// Eng nozik joyi: eski ulanish uzilganda o'yinchi o'yindan CHIQIB KETMASLIGI
// kerak (aks holda yangi qurilma bo'sh xonaga tushib qolardi).
import { io } from 'socket.io-client';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const PASS = 'e2e-parol-12345';

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(p, { method = 'GET', body, token, device } = {}) {
  const h = {};
  if (token) h.Authorization = 'Bearer ' + token;
  if (device) h['X-Device-Id'] = device;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
// Bir hisob, TURLI qurilma: har kirishda token o'sha qurilmaga bog'lanadi
async function kir(username, device) {
  let r = await http('/api/register', { method: 'POST', body: { username, password: PASS }, device });
  if (r.status === 409) r = await http('/api/login', { method: 'POST', body: { username, password: PASS }, device });
  if (!r.json?.token) throw new Error('kir ' + username + '@' + device + ': ' + r.status + ' ' + r.text.slice(0, 160));
  return { ...r.json, device };
}
function connect(u) {
  const s = io(API, { transports: ['websocket'], auth: { token: u.token, deviceId: u.device } });
  s.evts = new Map();
  s.onAny?.((ev, d) => { if (!s.evts.has(ev)) s.evts.set(ev, []); s.evts.get(ev).push(d); });
  s.waitFor = (ev, ms = 12000) => new Promise((res, rej) => {
    const a = s.evts.get(ev); if (a?.length) return res(a[a.length - 1]);
    const t = setTimeout(() => rej(new Error('kutish: ' + ev)), ms);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });
  s.all = (ev) => s.evts.get(ev) || [];
  s.last = (ev) => { const a = s.evts.get(ev); return a?.length ? a[a.length - 1] : null; };
  return s;
}
async function xona(user, nom) {
  const r = await http('/api/games', {
    method: 'POST', token: user.token, device: user.device,
    body: { name: nom, totalPlayers: 8, isPrivate: false },
  });
  if (!r.json?.id) throw new Error('xona: ' + r.status + ' ' + r.text.slice(0, 140));
  return r.json.id;
}

async function main() {
  log('\n=== 1. Ikkinchi QURILMA eskisini o\'yindan chiqaradi ===');
  const A = await kir('e2e_ses1', 'qurilma-A');
  const B = { ...A, ...(await kir('e2e_ses1', 'qurilma-B')) };
  ok(A.token !== B.token, 'ikki qurilma uchun ikki token berildi');

  const g1 = await xona(A, 'sessiya sinovi');
  const sa = connect(A);
  await sa.waitFor('connect').catch(() => null);
  sa.emit('join_game', { gameId: g1, userId: A.userId, username: A.username });
  const st1 = await sa.waitFor('game_state', 12000).catch(() => null);
  ok((st1?.players || []).length === 1, 'A qurilmasi xonaga kirdi', JSON.stringify((st1?.players || []).length));

  // Ikkinchi qurilma xuddi SHU o'yinga qo'shiladi
  const sb = connect(B);
  await sb.waitFor('connect').catch(() => null);
  sa.evts.delete('game_state');
  sb.emit('join_game', { gameId: g1, userId: B.userId, username: B.username });

  const taken = await sa.waitFor('session_taken', 10000).catch(() => null);
  ok(!!taken, 'A ga session_taken keldi', JSON.stringify(taken));
  ok(taken?.code === 'otherDevice', 'sabab: boshqa QURILMA', JSON.stringify(taken?.code));

  const st2 = await sb.waitFor('game_state', 12000).catch(() => null);
  ok((st2?.players || []).length === 1, 'B qurilmasi o\'yinda (o\'yinchi ikkilanmadi)', JSON.stringify((st2?.players || []).length));

  // A haqiqatan uziladi
  await sleep(4000);
  ok(sa.connected === false, 'A qurilmasining ulanishi uzildi', 'connected=' + sa.connected);

  // ENG MUHIMI: A uzilgani o'yinchini xonadan CHIQARIB YUBORMAYDI
  sb.evts.delete('game_state');
  sb.emit('chat_message', { gameId: g1, message: 'men hali xonadaman' });
  const xabar = await sb.waitFor('chat_message', 8000).catch(() => null);
  ok(!!xabar, 'B chatga yoza oladi (o\'yinchi B ning socketiga bog\'landi)', JSON.stringify(xabar));
  const st3 = sb.last('game_state') || st2;
  ok((st3?.players || []).length === 1, 'o\'yinchi xonada QOLDI', JSON.stringify((st3?.players || []).length));

  // A endi xonadan hech narsa olmaydi
  ok(sa.all('chat_message').length === 0, 'chiqarilgan ulanish endi xabar olmaydi', 'olgan: ' + sa.all('chat_message').length);

  log('\n=== 2. O\'SHA qurilmaning ikkinchi varag\'i — boshqa sabab ===');
  const C = await kir('e2e_ses2', 'qurilma-C');
  const g2 = await xona(C, 'varaq sinovi');
  const s1 = connect(C);
  await s1.waitFor('connect').catch(() => null);
  s1.emit('join_game', { gameId: g2, userId: C.userId, username: C.username });
  await s1.waitFor('game_state', 12000).catch(() => null);

  // AYNAN o'sha token va o'sha deviceId — ya'ni bir qurilmaning ikkinchi varag'i
  const s2 = connect(C);
  await s2.waitFor('connect').catch(() => null);
  s2.emit('join_game', { gameId: g2, userId: C.userId, username: C.username });
  const taken2 = await s1.waitFor('session_taken', 10000).catch(() => null);
  ok(!!taken2, 'birinchi varaqqa session_taken keldi', JSON.stringify(taken2));
  ok(taken2?.code === 'otherTab', 'sabab: o\'sha qurilmaning boshqa VARAG\'I', JSON.stringify(taken2?.code));

  log('\n=== 3. Ikkinchi qurilma BOSHQA o\'yinga kirsa ham eskisi chiqariladi ===');
  const D = await kir('e2e_ses3', 'qurilma-D');
  const E = { ...D, ...(await kir('e2e_ses3', 'qurilma-E')) };
  const g3 = await xona(D, 'birinchi xona');
  const sd = connect(D);
  await sd.waitFor('connect').catch(() => null);
  sd.emit('join_game', { gameId: g3, userId: D.userId, username: D.username });
  await sd.waitFor('game_state', 12000).catch(() => null);

  const g4 = await xona(E, 'ikkinchi xona');
  const se = connect(E);
  await se.waitFor('connect').catch(() => null);
  se.emit('join_game', { gameId: g4, userId: E.userId, username: E.username });
  const taken3 = await sd.waitFor('session_taken', 10000).catch(() => null);
  ok(!!taken3, 'boshqa o\'yinga kirilganda ham eskisi chiqarildi', JSON.stringify(taken3));
  const st4 = await se.waitFor('game_state', 12000).catch(() => null);
  ok((st4?.players || []).length === 1, 'yangi qurilma yangi xonada', JSON.stringify((st4?.players || []).length));

  [sa, sb, s1, s2, sd, se].forEach((s) => { try { s.disconnect(); } catch {} });
  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E7 XATOSI:', e?.stack || e); process.exit(2); });

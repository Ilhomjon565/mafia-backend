// ==================== E2E 3: reyting bo'yicha moslashtirish ====================
// Kuchi yaqin o'yinchilar bitta xonaga tushishi kerak.
//
// Reytinglar sinov bazasiga TO'G'RIDAN-TO'G'RI yoziladi (psql) — o'yin
// o'ynab reyting yig'ish uchun soatlab vaqt ketardi.
import { io } from 'socket.io-client';
import { execSync } from 'child_process';
import fs from 'fs';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const PASS = 'e2e-parol-12345';
const PSQL = process.env.E2E_PSQL;          // to'liq psql ulanish satri

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// Reytingni bazaga to'g'ridan-to'g'ri yozadi.
//
// SQL FAYL orqali beriladi: Prisma ustun nomlari katta-kichik harfli
// ("userId"), ya'ni qo'shtirnoq SHART — buyruq satrida esa uni shell
// yeb qo'yadi. Ulanish satri ham buyruqda ko'rinmasin: xato chiqqanda
// execSync butun buyruqni (parol bilan) logga chiqarardi.
const SQLF = '/tmp/e2e-rating.sql';
function setRating(userId, rating) {
  fs.writeFileSync(SQLF, [
    'SET search_path TO mafia_test;',
    'INSERT INTO "UserStats" ("id","userId","gamesPlayed","gamesWon","winRate","rating","xp")',
    `VALUES (md5(random()::text), '${userId}', 20, 10, 50, ${rating}, 0)`,
    `ON CONFLICT ("userId") DO UPDATE SET "rating" = ${rating}, "gamesPlayed" = 20;`,
  ].join('\n'));
  try {
    execSync(`psql "$E2E_PSQL" -tAf ${SQLF}`, { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, E2E_PSQL: PSQL } });
  } catch (e) {
    // Xatoni SANITIZATSIYA qilamiz — ulanish satri (parol bilan) chiqmasin
    throw new Error('setRating: ' + String(e.stderr || e.message).split('\n')[0]);
  }
}

async function main() {
  if (!PSQL) { console.error('E2E_PSQL berilmagan'); process.exit(2); }

  log('\n=== 0. Turli reytingdagi o\'yinchilar ===');
  const u = {};
  for (const n of ['low1', 'low2', 'low3', 'high1', 'high2', 'high3', 'mid1']) u[n] = await reg('e2e_r_' + n);
  // past liga ~900 (silver), yuqori ~1600 (diamond)
  for (const n of ['low1', 'low2', 'low3']) setRating(u[n].userId, 900);
  for (const n of ['high1', 'high2', 'high3']) setRating(u[n].userId, 1600);
  setRating(u.mid1.userId, 1200);
  ok(true, 'reytinglar yozildi (900 / 1600 / 1200)');

  // Keshni yangilash uchun qayta login (token ichida reyting yo'q, lekin
  // serverdagi `myRating` keshi 30 s — shuning uchun biroz kutamiz emas,
  // hisoblar YANGI, ya'ni kesh ham bo'sh)
  const me = await http('/api/me', { token: u.high1.token });
  ok(me.json?.tier === 'diamond', '/api/me liga qaytaradi', 'tier: ' + me.json?.tier + ' rating: ' + me.json?.stats?.rating);
  const meLow = await http('/api/me', { token: u.low1.token });
  ok(meLow.json?.tier === 'silver', 'past reyting uchun ham to\'g\'ri liga', 'tier: ' + meLow.json?.tier);

  log('\n=== 1. Ikki xona: past va yuqori ===');
  const mkA = await http('/api/games', { method: 'POST', token: u.low1.token, body: { name: 'past liga xonasi', totalPlayers: 8, isPrivate: false } });
  const mkB = await http('/api/games', { method: 'POST', token: u.high1.token, body: { name: 'yuqori liga xonasi', totalPlayers: 8, isPrivate: false } });
  ok(!!mkA.json?.id && !!mkB.json?.id, 'ikki xona yaratildi', mkA.status + '/' + mkB.status);
  const A = mkA.json.id, Bq = mkB.json.id;

  // Egalari xonaga kiradi — xona reytingi shundan hosil bo'ladi
  const sA = connect(u.low1), sB = connect(u.high1);
  await Promise.all([sA.waitFor('connect'), sB.waitFor('connect')].map((p) => p.catch(() => null)));
  sA.emit('join_game', { gameId: A, userId: u.low1.userId, username: u.low1.username });
  sB.emit('join_game', { gameId: Bq, userId: u.high1.userId, username: u.high1.username });
  await sleep(1500);

  const list = await http('/api/games');
  const rA = (list.json || []).find((r) => r.id === A);
  const rB = (list.json || []).find((r) => r.id === Bq);
  ok(rA?.tier === 'silver', 'past xona ligasi to\'g\'ri', 'tier: ' + rA?.tier);
  ok(rB?.tier === 'diamond', 'yuqori xona ligasi to\'g\'ri', 'tier: ' + rB?.tier);
  ok((list.json || []).every((r) => !!r.tier), 'HAMMA xonada liga bor (bot xonasi oshkor bo\'lmasin)',
    'ligasiz: ' + (list.json || []).filter((r) => !r.tier).length);

  log('\n=== 2. Tez o\'yin: har kim o\'z ligasiga tushadi ===');
  const q1 = await http('/api/games/quick', { method: 'POST', token: u.low2.token });
  ok(q1.json?.id === A, 'PAST reytingli o\'yinchi past xonaga tushdi',
    'kutilgan ' + A.slice(0, 8) + ', keldi ' + String(q1.json?.id).slice(0, 8));
  ok(q1.json?.mos === true, 'javobda "mos xona topildi" belgisi bor', JSON.stringify(q1.json));

  const q2 = await http('/api/games/quick', { method: 'POST', token: u.high2.token });
  ok(q2.json?.id === Bq, 'YUQORI reytingli o\'yinchi yuqori xonaga tushdi',
    'kutilgan ' + Bq.slice(0, 8) + ', keldi ' + String(q2.json?.id).slice(0, 8));

  log('\n=== 3. Xona reytingi YANGI o\'yinchi bilan YANGILANADI ===');
  // low2 (900) va high3 (1600) past xonaga kiradi.
  // O'rtacha: (900 + 900 + 1600) / 3 = 1133 -> silver EMAS, gold.
  // Ya'ni xona reytingi haqiqatan qayta hisoblanayotganini ko'rsatadi.
  const sA2 = connect(u.low2), sA3 = connect(u.high3);
  await Promise.all([sA2.waitFor('connect'), sA3.waitFor('connect')].map((p) => p.catch(() => null)));
  sA2.emit('join_game', { gameId: A, userId: u.low2.userId, username: u.low2.username });
  sA3.emit('join_game', { gameId: A, userId: u.high3.userId, username: u.high3.username });
  // /api/games 3 soniya keshlanadi (xotira 1.5 s + Redis 3 s) — kutamiz
  await sleep(5000);
  const list2 = await http('/api/games');
  const rA2 = (list2.json || []).find((r) => r.id === A);
  ok(rA2?.players?.length === 3, 'uchala o\'yinchi xonada', 'soni: ' + rA2?.players?.length);
  ok(rA2?.tier === 'gold', 'xona ligasi O\'RTACHAGA qarab o\'zgardi (silver -> gold)', 'tier: ' + rA2?.tier);

  log('\n=== 4. O\'rtacha reyting: oyna tashqarisidagi xona ham beriladi ===');
  // mid1 (1200): A endi ~1133 (|67| — oyna ichida), B 1600 (|400| — tashqarida).
  // Demak A tanlanishi kerak.
  const q3 = await http('/api/games/quick', { method: 'POST', token: u.mid1.token });
  ok(q3.json?.id === A || q3.json?.id === Bq, 'o\'rtacha o\'yinchi kutib qolmadi (xona berildi)', JSON.stringify(q3.json));
  ok(q3.json?.id === A, 'eng YAQIN xona tanlandi (67 < 400)',
    'kutilgan ' + A.slice(0, 8) + ', keldi ' + String(q3.json?.id).slice(0, 8));

  log('\n=== 5. Bo\'sh (odamsiz) xona hammaga bir xil mos ===');
  // Ikkala xonani to'ldirib, faqat botli xona qolsin — buni tekshirish uchun
  // yangi o'yinchi uchun xona YARATILISHI kerak (mos xona yo'q bo'lsa).
  // Bu yerda faqat javob shakli tekshiriladi.
  const q4 = await http('/api/games/quick', { method: 'POST', token: u.high3.token });
  ok(q4.status === 200 && !!q4.json?.id, 'har doim xona beriladi (kutib qolmaydi)', q4.status + ' ' + q4.text.slice(0, 100));

  sA.disconnect(); sB.disconnect(); sA2.disconnect(); sA3.disconnect();
  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E3 XATOSI:', e?.stack || e); process.exit(2); });

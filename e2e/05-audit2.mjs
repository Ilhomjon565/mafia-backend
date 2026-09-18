// ============ E2E 5: 2026-09-18 auditidan keyingi tuzatishlar ============
//
// Bu yerda tekshiriladigan narsalarning HAMMASI jonli saytda buzuq edi:
//   1) kunlik shikoyat chegarasi atomik emasdi — bitta odamga daqiqasiga
//      6 tagacha shikoyat yozish mumkin edi (sismember + sadd orasidagi poyga);
//   2) yozuv qayta boshlanganda ikkinchi webm SARLAVHASI eski faylga qo'shilib,
//      dalil hech bir pleyerda ochilmasdi;
//   3) chat takrori qoidasi umuman ishlamasdi (`g.chatRecent` saqlanmasdi);
//   4) telefon filtri o'yindagi RAQAM RO'YXATINI ("1 2 3 4 5 6 7 8 9") to'sardi;
//   5) o'lgan o'yinchiga shikoyat qilib bo'lmasdi.
import { io } from 'socket.io-client';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const RECDIR = process.env.E2E_REC || '/srv/mafia/rec-test';
const ADMIN_KEY = process.env.E2E_ADMIN_KEY || 'e2ekey';
const REDIS = process.env.E2E_REDIS || 'redis-cli -n 9';
const PASS = 'e2e-parol-12345';

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redis = (cmd) => { try { return execSync(`${REDIS} ${cmd}`, { encoding: 'utf8' }).trim(); } catch { return ''; } };

async function http(p, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (!raw && body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers: h, body: raw ? body : (body !== undefined ? JSON.stringify(body) : undefined) });
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
const dirOf = (id) => path.join(RECDIR, id);

async function main() {
  const admin = await reg('e2e_admin');
  await http('/api/admin/settings', {
    method: 'PUT', token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY },
    body: {
      minPlayers: 5,
      durations: {
        day_discussion: 14, day_results: 3, night_results: 3, night_skip: 1,
        night_mafia: 5, night_komissar: 4, night_doctor: 4, night_escort: 4,
        night_advokat: 4, night_qotil: 4, night_daydi: 4,
      },
    },
  });

  log('\n=== 0. O\'yin tayyorlash ===');
  const users = [];
  for (let i = 0; i < 5; i++) users.push(await reg('e2e_q' + i));
  const mk = await http('/api/games', {
    method: 'POST', token: users[0].token,
    body: { name: 'audit sinovi', totalPlayers: 5, isPrivate: false },
  });
  ok(mk.status === 200 && mk.json?.id, 'xona yaratildi', mk.status + ' ' + mk.text.slice(0, 120));
  const gameId = mk.json.id;

  const socks = users.map(connect);
  await Promise.all(socks.map((s) => s.waitFor('connect').catch(() => null)));
  socks.forEach((s, i) => s.emit('join_game', { gameId, userId: users[i].userId, username: users[i].username }));
  await sleep(1500);

  // Har bir mijoz navbati kelganda harakat qiladi — o'yin tez yakunlanadi
  const roles = new Map();
  const oldi = new Map();   // o'yin davomida o'lganlar: username -> socketId
  let kun = 0;
  let kunTest = null;
  socks.forEach((s, i) => {
    s.on('your_role', (d) => roles.set(i, d.role));
    s.on('phase_change', async (d) => {
      const st = s.last('game_state') || {};
      const hammasi = d.players || st.players || [];
      if (i === 0) {
        // Ikki manba: holatdagi `isAlive` va serverning o'z xabari
        for (const p of hammasi) if (p.isAlive === false) oldi.set(p.username, p.socketId);
        const chiqdi = d?.result?.eliminated;
        if (chiqdi) {
          const sid = (st.players || hammasi).find((p) => p.username === chiqdi)?.socketId;
          if (sid) oldi.set(chiqdi, sid);
        }
      }
      const alive = hammasi.filter((p) => p.isAlive);
      if (!alive.some((p) => p.socketId === s.id)) return;   // men o'ldim
      const others = alive.filter((p) => p.socketId !== s.id);
      if (d.phase === 'day_discussion') {
        if (i === 0) {
          kun++;
          if (kun === 1 && kunTest) { try { await kunTest(); } catch (e) { log('  1-kun xatosi:', e.message); } }
        }
        await sleep(i === 0 ? 9000 : 700 + i * 120);
        s.emit('day_vote', { gameId, targetSocketId: others.length ? others[0].socketId : 'skip' });
      } else if (String(d.phase).startsWith('night') && d.phase !== 'night_results') {
        await sleep(200 + i * 80);
        if (others.length) s.emit('night_action', { gameId, targetSocketId: others[0].socketId });
      }
    });
  });

  // ---------- 1-kun: chat, ovoz bo'laklari, atomik shikoyat ----------
  kunTest = async () => {
    const s = socks[0], me = users[0];

    log('\n=== 1. Chat takrori ENDI ishlaydi ===');
    s.evts.delete('game_error');
    s.emit('chat_message', { gameId, message: 'menimcha bu odam mafiya' });
    await sleep(600);
    s.emit('chat_message', { gameId, message: 'menimcha bu odam mafiya' });
    await sleep(900);
    const err = s.all('game_error').find((e) => e?.code === 'chat_repeat');
    ok(!!err, 'bir xil xabar ikkinchi marta o\'tmadi', JSON.stringify(s.all('game_error')));

    log('\n=== 2. RAQAM RO\'YXATI to\'silmaydi ===');
    s.evts.delete('game_error');
    const oldMsgs = s.all('chat_message').length;
    s.emit('chat_message', { gameId, message: '1 2 3 4 5 6 7 8 9 tekshirdim' });
    await sleep(900);
    const phoneErr = s.all('game_error').find((e) => e?.code === 'chat_phone');
    ok(!phoneErr, 'raqam ro\'yxati telefon deb hisoblanmadi', JSON.stringify(phoneErr));
    ok(s.all('chat_message').length > oldMsgs, 'xabar chatga tushdi');

    log('\n=== 3. Yozuv BO\'LAKLARI alohida faylga tushadi ===');
    const chunk = (n) => Buffer.alloc(n, 7);
    const send = (seg) => http('/api/voice-chunk', {
      method: 'POST', token: me.token, raw: true, body: chunk(4096),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Game-Id': gameId, 'X-Rec-Ext': 'webm', 'X-Rec-Seg': String(seg),
        'X-Device-Id': 'e2e-qurilma',
      },
    });
    const r0 = await send(0), r1 = await send(1), r2 = await send(2);
    ok(r0.status === 200 && r1.status === 200 && r2.status === 200,
      'uchala bo\'lak qabul qilindi', [r0.status, r1.status, r2.status].join(','));
    const files = (() => { try { return fs.readdirSync(dirOf(gameId)); } catch { return []; } })();
    const audio = files.filter((f) => /\.webm$/.test(f)).sort();
    ok(audio.length === 3, 'uchta ALOHIDA fayl yaratildi', 'fayllar: ' + files.join(','));
    ok(audio.some((f) => /\.2\.webm$/.test(f)) && audio.some((f) => /\.3\.webm$/.test(f)),
      'bo\'lak raqami fayl nomida', audio.join(','));
    // Har fayl aynan bitta bo'lak — ya'ni sarlavhalar QO'SHILIB ketmagan
    const sizes = audio.map((f) => fs.statSync(path.join(dirOf(gameId), f)).size);
    ok(sizes.every((n) => n === 4096), 'har fayl aynan bitta bo\'lak (sarlavha qo\'shilmagan)', sizes.join(','));

    log('\n=== 4. Kunlik chegara ATOMIK (poyga yo\'q) ===');
    const oldRep = Number(redis('llen reports')) || 0;
    const st = s.last('game_state') || {};
    const target = (st.players || []).find((p) => p.username === users[1].username);
    s.evts.delete('report_result');
    // Soket qo'riqchisi daqiqasiga 6 ta beradi — hammasini BIR VAQTDA yuboramiz.
    // Ilgari shulardan bir nechtasi o'tib ketardi; endi faqat bittasi o'tishi kerak.
    for (let i = 0; i < 6; i++) s.emit('report_player', { gameId, targetSocketId: target.socketId, type: 'chat_abuse', reason: 'sinov' });
    await sleep(2500);
    const res = s.all('report_result');
    const okCount = res.filter((r) => r?.ok === true).length;
    const dupCount = res.filter((r) => r?.code === 'reportDup').length;
    ok(okCount === 1, 'AYNAN BITTA shikoyat qabul qilindi', 'qabul: ' + okCount + ' / javoblar: ' + res.length);
    ok(dupCount === res.length - 1, 'qolganlari "allaqachon" javobini oldi', 'dup: ' + dupCount);
    const newRep = Number(redis('llen reports')) || 0;
    ok(newRep - oldRep === 1, 'adminga aynan bitta shikoyat tushdi', 'qo\'shilgan: ' + (newRep - oldRep));
  };

  // O'lganga shikoyat o'yin tugagach tekshiriladi (pastda) — 5 kishilik
  // o'yin 2-kunga yetmasligi mumkin.

  log('\n=== O\'yin boshlanmoqda ===');
  socks[0].emit('start_game', { gameId });
  await socks[0].waitFor('game_starting', 15000);
  const over = await Promise.race([
    socks[0].waitFor('game_over', 200000).then(() => 'over'),
    sleep(200000).then(() => 'timeout'),
  ]);
  ok(over === 'over', 'o\'yin yakunlandi', over);
  await sleep(2500);

  log('\n=== 4b. O\'LGAN o\'yinchiga ham shikoyat qilinadi ===');
  // Mijozda tugma `p.isAlive` sharti bilan yashirilgandi, holbuki o'liklarning
  // ALOHIDA chati va ovozli kanali aynan yozib olinadi.
  {
    // Shikoyatchi — hali hech kimga shikoyat qilmagan o'yinchi (socks[4]),
    // aks holda javob `reportDup` bo'lib, tekshiruv ma'nosini yo'qotadi.
    const s = socks[4];
    const juft = [...oldi.entries()].find(([nom]) => nom !== users[4].username);
    ok(!!juft, "o'yinda kamida bitta o'yinchi o'ldi", "o'lganlar: " + JSON.stringify([...oldi.keys()]));
    if (juft) {
      s.evts.delete('report_result');
      s.emit('report_player', { gameId, targetSocketId: juft[1], type: 'voice_abuse', reason: 'o\'liklar chatida so\'kindi' });
      const r = await s.waitFor('report_result', 9000).catch(() => null);
      ok(r?.ok === true, 'O\'LGAN o\'yinchiga shikoyat qabul qilindi', JSON.stringify(r) + ' (nishon: ' + juft[0] + ')');
    }
  }

  log('\n=== 5. Admin dalilida bo\'laklar BITTA o\'yinchiga bog\'lanadi ===');
  const ev = await http(`/api/admin/evidence/${gameId}`, { token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY } });
  ok(ev.status === 200, 'dalil ochildi (shikoyat bor — saqlangan)', ev.status + ' ' + ev.text.slice(0, 140));
  const list = ev.json?.audio || [];
  ok(list.length === 3, 'uchala bo\'lak dalilda ko\'rinadi', 'soni: ' + list.length);
  const egalar = [...new Set(list.map((a) => a.player))];
  ok(egalar.length === 1 && egalar[0] === users[0].username,
    'uchala fayl AYNAN bitta o\'yinchiga bog\'landi', 'egalar: ' + JSON.stringify(egalar));
  ok(list.filter((a) => a.qism).length === 2, 'bo\'lak raqami ko\'rsatildi', JSON.stringify(list.map((a) => a.qism)));
  // Fayl haqiqatan yuklab olinadimi
  const bir = list.find((a) => /\.2\.webm$/.test(a.file));
  if (bir) {
    const dl = await http(`/api/admin/evidence/${gameId}/file/${bir.file}`, { token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY } });
    ok(dl.status === 200, 'bo\'lak fayli yuklab olindi', dl.status + '');
  }

  log('\n=== 6. Kunlik 20 chegarasi ANIQ 20 da to\'xtaydi ===');
  // Redis'ga 20 ta soxta nishon yozamiz — 21-chisi rad etilishi va to'plam
  // hajmi 20 da QOLISHI kerak (ilgari 21 bo'lib ketardi).
  const day = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const key = `rep:by:${users[2].userId}:${day}`;
  redis(`del ${key}`);
  const soxta = Array.from({ length: 20 }, (_, i) => 'soxta-nishon-' + i).join(' ');
  redis(`sadd ${key} ${soxta}`);
  ok(Number(redis(`scard ${key}`)) === 20, 'sinov uchun 20 ta nishon yozildi');
  const s2 = socks[2];
  s2.evts.delete('report_result');
  const snap = socks[0].last('game_state') || {};
  const t21 = (snap.players || []).find((p) => p.username === users[3].username);
  s2.emit('report_player', { gameId, targetSocketId: t21?.socketId, type: 'afk' });
  const r21 = await s2.waitFor('report_result', 8000).catch(() => null);
  ok(r21?.code === 'reportDaily', '21-chi nishon rad etildi', JSON.stringify(r21));
  ok(Number(redis(`scard ${key}`)) === 20, 'to\'plam hajmi 20 da QOLDI (qaytarib olindi)', redis(`scard ${key}`));

  socks.forEach((s) => s.disconnect());
  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E5 XATOSI:', e?.stack || e); process.exit(2); });

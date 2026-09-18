// ====== E2E 6: bot mafiya sheriklari ODAMNING JORIY tanloviga qo'shiladi ======
//
// Nuqson: `scheduleBotMafiaFollow` ga NISHON uzatilardi va taymer ichida o'sha
// eski nishon yozilardi. Odam fikrini o'zgartirsa (juda tez-tez bo'ladigan
// holat — kimdir "menda komissar" desa hamma fikridan qaytadi), sheriklari
// BIRINCHI bosilgan odamga ovoz berib qolardi. Natijada mafiya kelisha olmay,
// kecha bo'sh ketardi yoki noto'g'ri odam o'ldirilardi.
//
// Bu yerda aynan shu holat o'ynaladi: odam A ga ovoz beradi, keyin B ga
// o'tadi — sheriklarning HAMMASI B da bo'lishi kerak.
//
// "Botlar bilan o'ynash" xonasi ishlatiladi: u bir zumda to'ladi, shuning
// uchun odam mafiya bo'lguncha bir necha marta urinib ko'rish arzon.
import { io } from 'socket.io-client';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const ADMIN_KEY = process.env.E2E_ADMIN_KEY || 'e2ekey';
const PASS = 'e2e-parol-12345';
const URINISH = Number(process.env.E2E_URINISH || 16);

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
  s.waitFor = (ev, ms = 20000) => new Promise((res, rej) => {
    const a = s.evts.get(ev); if (a?.length) return res(a[a.length - 1]);
    const t = setTimeout(() => rej(new Error('kutish: ' + ev)), ms);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });
  s.last = (ev) => { const a = s.evts.get(ev); return a?.length ? a[a.length - 1] : null; };
  return s;
}

// `night_mafia` fazasini kutamiz (sekin, lekin ishonchli)
async function kutFaza(s, phase, ms = 90000) {
  const chek = Date.now() + ms;
  const korilgan = new Set();
  while (Date.now() < chek) {
    // Faza IKKI manbada bo'ladi: `phase_change` hodisasi va `game_state`.
    // Faqat bittasiga qarash yetmaydi — holat suratini server har fazada
    // qayta yubormasligi mumkin.
    const ph = s.last('phase_change')?.phase || s.last('game_state')?.phase;
    if (ph) korilgan.add(ph);
    if (ph === phase) return true;
    const st = s.last('game_state');
    if (st?.status === 'finished') { log('    ko\'rilgan fazalar: ' + [...korilgan].join(' -> ')); return false; }
    await sleep(400);
  }
  log('    ko\'rilgan fazalar: ' + [...korilgan].join(' -> '));
  return false;
}

async function main() {
  const admin = await reg('e2e_admin');
  // Kecha uzun bo'lsin: ovoz -> fikrni o'zgartirish -> kuzatish uchun vaqt kerak
  const st = await http('/api/admin/settings', {
    method: 'PUT', token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY },
    body: {
      minPlayers: 2,
      durations: {
        day_discussion: 6, day_results: 2, night_results: 2, night_skip: 1,
        night_mafia: 30, night_komissar: 3, night_doctor: 3, night_escort: 3,
        night_advokat: 3, night_qotil: 3, night_daydi: 3,
      },
    },
  });
  ok(st.status === 200, 'sozlamalar qo\'yildi (night_mafia = 30s)', st.status + ' ' + st.text.slice(0, 120));

  let sinaldi = false;
  for (let i = 1; i <= URINISH && !sinaldi; i++) {
    const u = await reg('e2e_mf' + i);
    const mk = await http('/api/games/bots', { method: 'POST', token: u.token, body: { totalPlayers: 8 } });
    if (!mk.json?.id) { log(`  ${i}-urinish: xona yaratilmadi (${mk.status})`); continue; }
    const gameId = mk.json.id;
    const s = connect(u);
    await s.waitFor('connect').catch(() => null);
    s.emit('join_game', { gameId, userId: u.userId, username: u.username });

    const rol = await s.waitFor('your_role', 20000).catch(() => null);
    if (!rol || !['mafia', 'don'].includes(rol.role)) {
      log(`  ${i}-urinish: rol "${rol?.role || '?'}" — mafiya emas, keyingisi`);
      s.emit('leave_game', { gameId }); s.disconnect();
      continue;
    }
    log(`\n  ${i}-urinish: rol MAFIYA (${rol.role}) — sinovni o'tkazamiz`);

    const keldi = await kutFaza(s, 'night_mafia');
    if (!keldi) { log('  night_mafia fazasiga yetib borilmadi'); s.disconnect(); continue; }
    await sleep(700);

    const holat = s.last('game_state') || {};
    // Sheriklar `mafia_team` dan olinadi (`mafia_vote_update` faqat kimdir
    // ovoz bergandan KEYIN keladi, ya'ni boshida bo'sh bo'ladi).
    const mates = (s.last('mafia_team')?.mates || []).map((m) => m.username);
    const sheriklar = mates.filter((n) => n !== u.username);
    if (!sheriklar.length) { log('  bu o\'yinda bot sherik yo\'q — keyingisi'); s.disconnect(); continue; }
    const nishonlar = (holat.players || [])
      .filter((p) => p.isAlive && p.socketId !== s.id && !mates.includes(p.username));
    if (nishonlar.length < 2) { log('  yetarli nishon yo\'q'); s.disconnect(); continue; }

    const A = nishonlar[0], B = nishonlar[1];
    log(`  sherik: ${sheriklar.join(', ')}`);
    log(`  A = ${A.username}  ->  B = ${B.username}`);

    // Odam A ni bosadi va DARHOL fikridan qaytadi. Bot sherigi 1.5 soniyadan
    // keyin "o'ylab" qo'shiladi — o'sha payt u JORIY tanlovni (B) o'qishi kerak.
    // Eski kodda taymerga eski nishon (A) yopilib ketgandi.
    s.evts.delete('game_error'); s.evts.delete('action_confirmed');
    s.emit('night_action', { gameId, targetSocketId: A.socketId });
    await sleep(500);
    log('    A javobi: ' + JSON.stringify(s.last('action_confirmed') || s.last('game_error')));
    s.evts.delete('game_error'); s.evts.delete('action_confirmed');
    s.emit('night_action', { gameId, targetSocketId: B.socketId });
    await sleep(600);
    const bJavob = s.last('action_confirmed');
    log('    B javobi: ' + JSON.stringify(bJavob || s.last('game_error')));
    // Kecha bosqichi ikkinchi ovozdan OLDIN yopilib qolishi mumkin (hamma
    // mafiya ovoz bergan bo'lsa server bosqichni darhol tugatadi). Bunda
    // sinovning sharti umuman qurilmagan — yiqitmaymiz, keyingi o'yinga o'tamiz.
    if (bJavob?.name !== B.username) {
      log('  ikkinchi ovoz ulgurmadi (bosqich yopilgan) — keyingi urinish');
      s.disconnect();
      continue;
    }

    await sleep(8400);
    const v = s.last('mafia_vote_update')?.votes || {};
    ok(v[u.username] === B.username, 'odamning ovozi B da', JSON.stringify(v));
    const botlar = Object.entries(v).filter(([n]) => n !== u.username).map(([, t]) => t);
    ok(botlar.length > 0, 'sherik paneli bo\'sh emas', JSON.stringify(v));
    ok(botlar.every((t) => t === B.username),
      'bot sherik ODAMNING JORIY tanloviga (B) qo\'shildi', JSON.stringify(v));
    ok(!botlar.some((t) => t === A.username),
      'sherik eski nishonda (A) qolib ketmadi', JSON.stringify(v));

    sinaldi = true;
    s.disconnect();
  }

  ok(sinaldi, `${URINISH} urinishda odam mafiya bo'lgan o'yin topildi`);
  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E6 XATOSI:', e?.stack || e); process.exit(2); });

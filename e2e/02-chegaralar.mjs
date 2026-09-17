// ==================== E2E 2: chegaralar va chekka holatlar ====================
// 1) Kunlik 20 ta odam chegarasi
// 2) O'yin TUGAGANDAN KEYIN (natija ekranidan) shikoyat — yozuv saqlanib qolsinmi
// 3) Disk kvotasi: bitta o'yinchi chegarasiga yetganda nima bo'ladi
import { io } from 'socket.io-client';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const API = process.env.E2E_API || 'http://127.0.0.1:4199';
const RECDIR = process.env.E2E_REC || '/srv/mafia/rec-test';
const ADMIN_KEY = process.env.E2E_ADMIN_KEY || 'e2ekey';
const PASS = 'e2e-parol-12345';

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(c, n, e = '') { if (c) { pass++; log('  OK   ' + n); } else { fail++; log('  XATO ' + n + (e ? '  << ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (!r.json?.token) throw new Error('reg ' + u + ': ' + r.status + ' ' + r.text.slice(0, 140));
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
  s.last = (ev) => { const a = s.evts.get(ev); return a?.length ? a[a.length - 1] : null; };
  return s;
}
const dirOf = (id) => path.join(RECDIR, id);
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const redis = (cmd) => execSync(`redis-cli -n 9 ${cmd}`, { encoding: 'utf8' }).trim();

async function playTo(socks, gameId, onDay) {
  socks.forEach((s, i) => {
    s.on('phase_change', async (d) => {
      const st = s.last('game_state') || {};
      const alive = (d.players || st.players || []).filter((p) => p.isAlive);
      const others = alive.filter((p) => p.socketId !== s.id);
      if (!alive.some((p) => p.socketId === s.id)) return;
      await sleep(250 + i * 90);
      if (d.phase === 'day_discussion') {
        if (onDay) { try { await onDay(i, s, d); } catch (e) { log('  onDay:', e.message); } }
        s.emit('day_vote', { gameId, targetSocketId: others.length ? others[0].socketId : 'skip' });
      } else if (String(d.phase).startsWith('night') && d.phase !== 'night_results') {
        if (others.length) s.emit('night_action', { gameId, targetSocketId: others[0].socketId });
      }
    });
  });
  socks[0].emit('start_game', { gameId });
  await socks[0].waitFor('game_starting', 15000);
  return Promise.race([socks[0].waitFor('game_over', 180000).then(() => 'over'), sleep(180000).then(() => 'timeout')]);
}

async function main() {
  const admin = await reg('e2e_admin');

  // ============ 1. KUNLIK 20 TA ODAM CHEGARASI ============
  log('\n=== 1. Kunlik chegara: 20 ta TURLI odam ===');
  const rep = await reg('e2e_c_reporter');
  const day = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const key = `rep:by:${rep.userId}:${day}`;
  // 20 ta soxta nishonni to'plamga qo'yamiz — chegara AYNAN shu to'plam bilan o'lchanadi
  const fakes = Array.from({ length: 20 }, (_, i) => 'soxta_nishon_' + i).join(' ');
  redis(`sadd ${key} ${fakes}`);
  ok(Number(redis(`scard ${key}`)) === 20, "to'plamga 20 ta nishon qo'yildi", redis(`scard ${key}`));

  const players = [];
  for (let i = 0; i < 4; i++) players.push(await reg('e2e_c' + i));
  const all = [rep, ...players];
  const mk = await http('/api/games', { method: 'POST', token: rep.token, body: { name: 'E2E chegara', totalPlayers: 5, isPrivate: false } });
  const gid = mk.json?.id;
  ok(!!gid, 'xona yaratildi', mk.status + ' ' + mk.text.slice(0, 100));
  const socks = all.map(connect);
  await Promise.all(socks.map((s) => s.waitFor('connect', 10000).catch(() => null)));
  socks.forEach((s, i) => s.emit('join_game', { gameId: gid, userId: all[i].userId, username: all[i].username }));
  await sleep(1500);

  socks[0].emit('report_player', { gameId: gid, targetSocketId: socks[1].id, type: 'chat_abuse' });
  const r = await socks[0].waitFor('report_result', 10000).catch(() => null);
  ok(r?.ok === false && r?.code === 'reportDaily', '21-chi odamga shikoyat RAD ETILDI', JSON.stringify(r));
  ok(r?.n === 20, 'chegara soni javobda ko\'rsatildi', JSON.stringify(r?.n));

  // Chegara BOSHQA foydalanuvchiga ta'sir qilmasligi kerak
  socks[1].emit('report_player', { gameId: gid, targetSocketId: socks[0].id, type: 'afk' });
  const r2 = await socks[1].waitFor('report_result', 10000).catch(() => null);
  ok(r2?.ok === true, 'boshqa foydalanuvchining chegarasi tegilmadi', JSON.stringify(r2));
  socks.forEach((s) => s.disconnect());
  redis(`del ${key}`);

  // ============ 2. O'YIN TUGAGANDAN KEYIN SHIKOYAT ============
  log('\n=== 2. Natija ekranidan shikoyat (yozuv saqlanib qolsinmi) ===');
  const u2 = [];
  for (let i = 0; i < 5; i++) u2.push(await reg('e2e_d' + i));
  const mk2 = await http('/api/games', { method: 'POST', token: u2[0].token, body: { name: 'E2E keyingi shikoyat', totalPlayers: 5, isPrivate: false } });
  const g2 = mk2.json?.id;
  ok(!!g2, '2-xona yaratildi', mk2.status);
  const sk2 = u2.map(connect);
  await Promise.all(sk2.map((s) => s.waitFor('connect', 10000).catch(() => null)));
  sk2.forEach((s, i) => s.emit('join_game', { gameId: g2, userId: u2[i].userId, username: u2[i].username }));
  await sleep(1500);
  const targetSid = sk2[1].id;
  const res2 = await playTo(sk2, g2, async (i, s) => {
    s.emit('chat_message', { gameId: g2, message: 'oddiy xabar ' + i });
    if (i === 0) {
      await http('/api/voice-chunk', {
        method: 'POST', token: u2[0].token, raw: true, body: Buffer.alloc(20 * 1024, 5),
        headers: { 'Content-Type': 'application/octet-stream', 'X-Game-Id': g2, 'X-Rec-Ext': 'webm' },
      });
    }
  });
  ok(res2 === 'over', 'o\'yin tugadi', res2);
  await sleep(1500);
  ok(exists(dirOf(g2)), 'tugagach yozuv hali joyida (muhlat ichida)');

  // O'yin tugagan — Redis holati yo'q. Shikoyat SHU PAYTDA kelishi kerak.
  sk2[0].evts.delete('report_result');
  sk2[0].emit('report_player', { gameId: g2, targetSocketId: targetSid, type: 'voice_abuse', reason: 'oyindan keyin' });
  const rr = await sk2[0].waitFor('report_result', 10000).catch(() => null);
  ok(rr?.ok === true, 'O\'YIN TUGAGACH shikoyat qabul qilindi', JSON.stringify(rr));

  log('  ... o\'chirish muhlatini kutamiz (36 s)');
  await sleep(36000);
  ok(exists(dirOf(g2)), 'kech kelgan shikoyat yozuvni SAQLAB QOLDI', 'katalog yo\'q: ' + dirOf(g2));
  const ev = await http('/api/admin/evidence/' + g2, { token: admin.token, headers: { 'X-Admin-Key': ADMIN_KEY } });
  ok(ev.status === 200 && (ev.json?.reports?.length || 0) >= 1, 'kech shikoyat dalilga yozildi', 'soni: ' + (ev.json?.reports?.length ?? 0));
  ok((ev.json?.game?.chat?.length || 0) > 0, 'chat tarixi saqlanib qoldi', 'xabarlar: ' + (ev.json?.game?.chat?.length ?? 0));
  sk2.forEach((s) => s.disconnect());

  // ============ 3. DISK KVOTASI ============
  log('\n=== 3. Disk kvotasi: bitta o\'yinchi chegarasi ===');
  const u3 = [];
  for (let i = 0; i < 5; i++) u3.push(await reg('e2e_e' + i));
  const mk3 = await http('/api/games', { method: 'POST', token: u3[0].token, body: { name: 'E2E kvota', totalPlayers: 5, isPrivate: false } });
  const g3 = mk3.json?.id;
  const sk3 = u3.map(connect);
  await Promise.all(sk3.map((s) => s.waitFor('connect', 10000).catch(() => null)));
  sk3.forEach((s, i) => s.emit('join_game', { gameId: g3, userId: u3[i].userId, username: u3[i].username }));
  await sleep(1200);
  sk3[0].emit('start_game', { gameId: g3 });
  await sk3[0].waitFor('game_starting', 15000).catch(() => null);
  await sleep(1500);
  ok(exists(dirOf(g3)), '3-o\'yin yozuvi ochildi');

  // Bitta o'yinchi chegarasi 6 MB — 512 KB lik bo'laklar bilan to'ldiramiz
  let statuses = [];
  for (let i = 0; i < 16; i++) {
    const rr2 = await http('/api/voice-chunk', {
      method: 'POST', token: u3[0].token, raw: true, body: Buffer.alloc(512 * 1024, 1),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Game-Id': g3, 'X-Rec-Ext': 'webm' },
    });
    statuses.push(rr2.status);
    if (rr2.status !== 200) break;
  }
  const accepted = statuses.filter((s) => s === 200).length;
  ok(accepted >= 10 && accepted <= 13, 'chegaragacha bo\'laklar qabul qilindi', 'qabul: ' + accepted);
  ok(statuses[statuses.length - 1] === 507, 'chegaraga yetganda 507 qaytdi', JSON.stringify(statuses.slice(-3)));

  // BOSHQA o'yinchi hali yoza olishi kerak — chegara har kishiga alohida
  const other = await http('/api/voice-chunk', {
    method: 'POST', token: u3[1].token, raw: true, body: Buffer.alloc(100 * 1024, 2),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Game-Id': g3, 'X-Rec-Ext': 'webm' },
  });
  ok(other.status === 200, 'boshqa o\'yinchi chegaradan ta\'sirlanmadi', 'status: ' + other.status);

  // Juda katta bo'lak rad etilishi kerak
  const big = await http('/api/voice-chunk', {
    method: 'POST', token: u3[2].token, raw: true, body: Buffer.alloc(900 * 1024, 3),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Game-Id': g3, 'X-Rec-Ext': 'webm' },
  });
  ok(big.status === 413 || big.status === 400, 'juda katta bo\'lak rad etildi', 'status: ' + big.status);

  // O'yin BUZILMAGANI: chegaradan keyin ham chat va o'yin ishlaydi
  sk3[0].evts.delete('game_error');
  sk3[0].emit('chat_message', { gameId: g3, message: 'kvotadan keyin ham yozaman' });
  await sleep(800);
  const gerr = sk3[0].last('game_error');
  ok(!gerr || !['chatBanned', 'muted'].includes(gerr.code), 'kvota to\'lgach ham o\'yin ishlayapti', JSON.stringify(gerr));

  sk3.forEach((s) => s.disconnect());

  log(`\n===== NATIJA: ${pass} ta o'tdi, ${fail} ta yiqildi =====\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nE2E2 XATOSI:', e?.stack || e); process.exit(2); });

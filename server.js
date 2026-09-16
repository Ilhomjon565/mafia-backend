import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import {
  makePersona, voteDelayMs, fakePing, buildSuspicion, buildVoteWeight,
  chooseDayVote, chooseNightTarget, makeFillerBots, BOT_NAMES, botAvatar,
} from './bot-ai.js';
// Onlayn ko'rsatkichi egri chizig'i — alohida modulda, testlari presence.test.mjs da
import {
  fakeOnlineBase, fakePlayersBase, fakeGamesPlayed, fakeRooms, dueBotGameSlot,
} from './presence.js';
// FAKE_ONLINE=0 — soxta qo'shimchani butunlay o'chiradi (faqat haqiqiy onlayn)
const FAKE_ONLINE = process.env.FAKE_ONLINE !== '0';
import {
  roleName, sideOf, checkWin, isWinner, killerLabel,
  SELECTABLE_ROLES, MAFIA_VOTERS, normalizeRoleConfig, assignRoles, chooseMafiaTarget, resolveNightDeaths,
  NIGHT_STEPS, nightStepByPhase, stepHasActor, nightStepComplete,
} from './rules.js';
import {
  RATING_START, TIERS, XP, eloDelta, applyElo, xpForGame,
  levelFromXp, levelProgress, tierOf, tierProgress, xpForLevel,
} from './progression.js';


// override: true — .env HAR DOIM ustun. Busiz pm2 (yoki shell) dan kelgan bo'sh
// qiymat .env dagi to'g'ri qiymatni bosib qolardi (2026-09-15: TG_ADMIN_* shunday
// bo'sh ko'ringan va admin tasdiqlash "disabled" bo'lib qolgandi).
dotenv.config({ override: true });

// JWT_SECRET — production'da MAJBURIY. Ilgari zaxira qiymat ('mafia-dev-secret')
// ishlatilardi: `.env` yuklanmay qolsa (bu loyihada bir marta bo'lgan) server
// JIMGINA hammaga ma'lum sir bilan ishlab ketardi va istalgan odam o'ziga
// `isAdmin: true` tokenini yasay olardi. Endi bunday holatda server ishga
// tushmaydi — jim ishlashdan ko'ra yiqilish xavfsizroq.
// Dev'da (NODE_ENV != production) har ishga tushishda tasodifiy sir olinadi:
// eski tokenlar bekor bo'ladi, lekin zaif sir hech qachon ishlatilmaydi.
const JWT_SECRET = (() => {
  const v = process.env.JWT_SECRET;
  if (v && v.length >= 32) return v;
  if (process.env.NODE_ENV === 'production') {
    console.error(v
      ? 'FATAL: JWT_SECRET juda qisqa (kamida 32 belgi kerak).'
      : "FATAL: JWT_SECRET topilmadi. /srv/mafia/backend.env ni tekshiring.");
    process.exit(1);
  }
  const tmp = crypto.randomBytes(32).toString('hex');
  console.warn("OGOHLANTIRISH: JWT_SECRET topilmadi — vaqtinchalik tasodifiy sir olindi (faqat dev).");
  return tmp;
})();
// Parol hash kuchi. 8 -> 12: 2026 yil tavsiyasi 10-14 oralig'ida. Hash ichida
// round soni saqlanadi, shuning uchun ESKI parollar ham ishlaydi — ular keyingi
// marta parol o'zgartirilganda yangi kuchga o'tadi.
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// maxfiy admin kalit — admin panel/API'ni yashiradi. .env'da bo'ladi (repoda yo'q).
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || '';
// Telegram orqali admin kirishini tasdiqlash (token/chat .env'da)
const TG_ADMIN_BOT_TOKEN = process.env.TG_ADMIN_BOT_TOKEN || '';
const TG_ADMIN_CHAT_ID = process.env.TG_ADMIN_CHAT_ID || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1012676002382-21keol37nklhi22reit714nkgjb58dgm.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
app.set('trust proxy', true); // cloudflared/nginx ortida — X-Forwarded-For ga ishonamiz
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,   // 1MB — katta socket xabar floodini cheklaydi
  pingTimeout: 20000,
});

// ==================== HIMOYA: real IP + rate limiting ====================
// Cloudflare/nginx ortidagi haqiqiy mijoz IP'si
// Sarlavhaga (cf-connecting-ip / x-forwarded-for) FAQAT ulanish mahalliy yoki ichki
// tarmoqdan kelganda ishonamiz — ya'ni oldimizda nginx/cloudflared turganda.
// Aks holda to'g'ridan-to'g'ri ulangan hujumchi har so'rovda soxta IP yozib
// BARCHA IP-asosidagi cheklovlarni (rate-limit, handshake, ulanish soni) chetlab o'tardi.
function clientIp(req) {
  const direct = String(req.socket?.remoteAddress || '').replace('::ffff:', '');
  if (direct && isPublicIp(direct)) return direct;   // proxy yo'q — o'z manzili
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || direct || 'unknown';
}
// IP haqiqiy ommaviy IP'mi? (proxy/local bo'lsa — IP-cheklovga ishonmaymiz,
// chunki real IP uzatilmagan bo'lsa hamma bitta IP bo'lib ko'rinib bloklanib qoladi)
function isPublicIp(ip) {
  if (!ip) return false;
  ip = String(ip).replace('::ffff:', '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'unknown' || ip === '') return false;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip)) return false;
  return true;
}
// yengil, xotirada ishlaydigan fixed-window rate limiter (Redis/round-trip yo'q — tez)
function rateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }, windowMs);
  sweep.unref?.();
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : clientIp(req);
    if (!key) return next();
    // IP-asosli cheklov: IP ishonchsiz (proxy/local) bo'lsa o'tkazib yuboramiz —
    // aks holda real IP uzatilmasa hamma bitta IP bo'lib bloklanib qolardi.
    if (!keyFn && !isPublicIp(key)) return next();
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.resetAt) { h = { count: 0, resetAt: now + windowMs }; hits.set(key, h); }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Juda ko\'p so\'rov yubordingiz. Birozdan keyin urinib ko\'ring.' });
    }
    next();
  };
}
// tez-tez ishlatiladigan limiterlar
const limitAuth = rateLimiter({ windowMs: 60000, max: 40, message: 'Juda ko\'p urinish. Bir daqiqadan keyin urinib ko\'ring.' }); // login/register (IP)
const limitGlobal = rateLimiter({ windowMs: 60000, max: 1000 }); // umumiy xavfsizlik to'ri (IP)
const limitByUser = (max) => rateLimiter({ windowMs: 60000, max, keyFn: (req) => 'u:' + (req.user?.userId || clientIp(req)) });

// yangi akkaunt yaratish tezligi — bitta IP'dan soatiga (faqat ishonchli ommaviy IP)
const signupHits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of signupHits) if (now > v.resetAt) signupHits.delete(k); }, 3600000).unref?.();
function signupAllowed(ip, max) {
  if (!isPublicIp(ip)) return true; // proxy/local — IP'ga ishonmaymiz, bu yerda cheklamaymiz
  const now = Date.now();
  let h = signupHits.get(ip);
  if (!h || now > h.resetAt) { h = { count: 0, resetAt: now + 3600000 }; signupHits.set(ip, h); }
  h.count++;
  return h.count <= max;
}

const prisma = new PrismaClient();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  // umumiy Redis serverida boshqa loyihalar bilan aralashmaslik uchun alohida DB indeksi
  db: parseInt(process.env.REDIS_DB || '0'),
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

app.use(cors());
app.use(express.json({ limit: '800kb' })); // avatar (base64) sig'adi, lekin ulkan payload floodini cheklaydi
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(limitGlobal); // umumiy IP xavfsizlik to'ri (saxiy — CGNAT'ni hisobga olib)

// 🕵️ Admin panelni yashirish: maxfiy kalitsiz BARCHA /api/admin/* — 404 (mavjud emasdek).
// Kalit .env'da (ADMIN_ACCESS_KEY); repoda yo'q. Login paroldan oldingi qatlam.
// qurilma Telegram orqali tasdiqlanganmi?
async function isDeviceApproved(deviceId) {
  if (!deviceId) return false;
  try { return (await redis.exists(`admin:approved:${deviceId}`)) === 1; } catch { return false; }
}
async function adminGate(req, res, next) {
  if (req.method === 'OPTIONS') return next(); // CORS preflight
  // hech narsa sozlanmagan bo'lsa — eski xatti-harakat (lockout bo'lmasin)
  if (!ADMIN_ACCESS_KEY && !TG_ADMIN_BOT_TOKEN) return next();
  // 1) maxfiy kalit (zaxira) yoki 2) Telegram orqali tasdiqlangan qurilma
  if (ADMIN_ACCESS_KEY && req.headers['x-admin-key'] === ADMIN_ACCESS_KEY) return next();
  if (await isDeviceApproved(req.headers['x-device-id'])) return next();
  return res.status(404).json({ error: 'Not found' }); // mavjudligini oshkor qilmaymiz
}
app.use('/api/admin', (req, res, next) => { adminGate(req, res, next).catch(() => res.status(404).json({ error: 'Not found' })); });

// ==================== TELEGRAM ORQALI ADMIN KIRISH TASDIG'I ====================
const accessReqs = new Map(); // requestId -> { deviceId, ip, ua, status, t }
async function tgApi(method, body) {
  if (!TG_ADMIN_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_ADMIN_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json().catch(() => null);
  } catch { return null; }
}
// ==================== TELEGRAM GURUHIGA XONA E'LONI ====================
// Yangi ochiq xona ochilganda guruhga havola + o'yinchilar soni bilan e'lon ketadi.
// Son o'zgarsa YANGI xabar emas — o'sha xabar tahrirlanadi (guruh spamlanmaydi).
// Xabar ID si o'yin holati ichida (Redis) saqlanadi — backend qayta ishga tushsa ham yo'qolmaydi.
const TG_GROUP_CHAT_ID = process.env.TG_GROUP_CHAT_ID || '';
// Botga /start bosgan odam shu ikki joyga yo'naltiriladi
const TG_GROUP_LINK = process.env.TG_GROUP_LINK || 'https://t.me/uzbekistan_mafia_games';
const SITE_URL = (process.env.FRONTEND_URL || 'https://mafia-game.uz').replace(/\/+$/, '');
const TG_EDIT_THROTTLE_MS = 4000;      // Telegram tahrir limiti — bir xabarga ~4s da bir marta
const tgEditTimers = new Map();        // gameId -> { timer, dirty }

function tgGroupOn() { return !!(TG_ADMIN_BOT_TOKEN && TG_GROUP_CHAT_ID); }
function tgEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tgRoomUrl(gameId) { return SITE_URL + '/game/' + gameId; }
// Guruhdagi tugma uchun — kim guruh orqali kelganini ajratish
function tgRoomUrlRef(gameId) { return tgRoomUrl(gameId) + '?ref=tggroup'; }
function tgRoomKb(g) {
  return g.status === 'waiting'
    ? { inline_keyboard: [[{ text: '\u{1F3AE} Xonaga qo\u2018shilish', url: tgRoomUrlRef(g.id) }]] }
    : { inline_keyboard: [] };
}
function tgRoomText(g) {
  const n = (g.players || []).filter(p => !p.isBot).length;
  const max = g.totalPlayers || g.maxPlayers || 8;
  const name = tgEsc(g.name || 'Mafia xonasi');
  if (g.status === 'finished') {
    const ever = Array.isArray(g.everPlayers) ? g.everPlayers.length : n;
    return `\u{1F3C1} <b>${name}</b>\n\n${tgEsc(winnerMessage(g.winner))}\n\u{1F465} ${Math.max(n, ever)} o'yinchi qatnashdi`;
  }
  if (g.status === 'playing') {
    return `\u25B6\uFE0F <b>${name}</b> — o'yin boshlandi\n\n\u{1F465} ${n} o'yinchi o'ynayapti`;
  }
  return `\u{1F3AD} <b>${name}</b> — yangi xona ochildi!\n\n`
       + `\u{1F465} O'yinchilar: <b>${n}/${max}</b>\n`
       + `\u{1F517} ${tgRoomUrl(g.id)}\n\n`
       + `Bo'sh joy bor — qo'shiling \u{1F447}`;
}

// Botga /start bosgan foydalanuvchiga javob — Telegram profilidagi tilga qarab uz/ru/en.
const TG_WELCOME = {
  uz: {
    text: (name) =>
      `🎭 <b>Salom, ${name}!</b>\n\n` +
      `<b>Mafia Game UZ</b> — onlayn Mafiya o'yini. Kunduzi shahar ovoz beradi, kechasi mafiya ov qiladi.\n\n` +
      `👥 5–20 o'yinchi · 🎭 12 xil rol · 🎤 ovozli chat\n` +
      `🆓 Butunlay bepul, dastur o'rnatish shart emas.\n\n` +
      `Quyidagi tugmalardan foydalaning 👇`,
    play: "🎮 O'ynash — mafia-game.uz",
    group: '💬 Guruhga qo‘shilish',
  },
  ru: {
    text: (name) =>
      `🎭 <b>Привет, ${name}!</b>\n\n` +
      `<b>Mafia Game UZ</b> — онлайн-игра «Мафия». Днём город голосует, ночью мафия охотится.\n\n` +
      `👥 5–20 игроков · 🎭 12 ролей · 🎤 голосовой чат\n` +
      `🆓 Полностью бесплатно, ничего устанавливать не нужно.\n\n` +
      `Воспользуйтесь кнопками ниже 👇`,
    play: '🎮 Играть — mafia-game.uz',
    group: '💬 Вступить в группу',
  },
  en: {
    text: (name) =>
      `🎭 <b>Hi, ${name}!</b>\n\n` +
      `<b>Mafia Game UZ</b> — the classic Mafia party game, online. By day the town votes, by night the mafia hunts.\n\n` +
      `👥 5–20 players · 🎭 12 roles · 🎤 voice chat\n` +
      `🆓 Completely free, nothing to install.\n\n` +
      `Use the buttons below 👇`,
    play: '🎮 Play — mafia-game.uz',
    group: '💬 Join the group',
  },
};

async function tgStart(msg) {
  // /start bosgan UNIKAL Telegram foydalanuvchilari (saytga o'tmaganlar ham) —
  // admin panelda "botni ochganlar" soni shundan olinadi.
  if (msg.from?.id) {
    redis.sadd('tg:started', String(msg.from.id)).catch(() => {});
  }
  const code = String(msg.from?.language_code || '').slice(0, 2).toLowerCase();
  const L = TG_WELCOME[code === 'ru' ? 'ru' : code === 'en' ? 'en' : 'uz'];
  const name = tgEsc(msg.from?.first_name || msg.from?.username || '');
  await tgApi('sendMessage', {
    chat_id: msg.chat.id,
    text: L.text(name),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: L.play, url: `${SITE_URL}/?ref=tgbot` }],
        [{ text: L.group, url: TG_GROUP_LINK }],
      ],
    },
  });
}

// xona ochilganda — bir marta
async function tgRoomAnnounce(gameId) {
  if (!tgGroupOn()) return;
  const g = await getG(gameId);
  if (!g || g.isPrivate || g.vsBots || g.tgMessageId) return;
  const r = await tgApi('sendMessage', {
    chat_id: TG_GROUP_CHAT_ID, text: tgRoomText(g), parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: tgRoomKb(g),
  });
  if (!r?.ok) return;
  await withLock(gameId, async () => {
    const g2 = await getG(gameId);
    if (!g2) { await tgApi('deleteMessage', { chat_id: TG_GROUP_CHAT_ID, message_id: r.result.message_id }); return; }
    g2.tgMessageId = r.result.message_id;
    g2.tgText = tgRoomText(g2);
    await saveG(gameId, g2);
  });
}

// holat o'zgardi — xabarni yangilash (throttle + coalescing)
function tgRoomTouch(gameId) {
  if (!tgGroupOn()) return;
  const t = tgEditTimers.get(gameId);
  if (t) { t.dirty = true; return; }
  tgEditTimers.set(gameId, { dirty: false, timer: setTimeout(() => {
    const cur = tgEditTimers.get(gameId);
    tgEditTimers.delete(gameId);
    if (cur?.dirty) tgRoomTouch(gameId);
  }, TG_EDIT_THROTTLE_MS) });
  tgRoomFlush(gameId).catch(() => {});
}

async function tgRoomFlush(gameId) {
  if (!tgGroupOn()) return;
  const g = await getG(gameId);
  if (!g || !g.tgMessageId) return;
  const text = tgRoomText(g);
  if (text === g.tgText) return;       // o'zgarish yo'q — Telegram'ni bezovta qilmaymiz
  const r = await tgApi('editMessageText', {
    chat_id: TG_GROUP_CHAT_ID, message_id: g.tgMessageId, text,
    parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: tgRoomKb(g),
  });
  if (!r?.ok) return;
  await withLock(gameId, async () => {
    const g2 = await getG(gameId);
    if (g2) { g2.tgText = text; await saveG(gameId, g2); }
  });
}

// o'yin tugadi — e'lonni yakuniy holatga keltiramiz
async function tgRoomFinish(gameId) {
  if (!tgGroupOn()) return;
  const t = tgEditTimers.get(gameId);
  if (t) { clearTimeout(t.timer); tgEditTimers.delete(gameId); }
  const g = await getG(gameId);
  if (!g || !g.tgMessageId) return;
  await tgApi('editMessageText', {
    chat_id: TG_GROUP_CHAT_ID, message_id: g.tgMessageId, text: tgRoomText(g),
    parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
  });
}

// Toshkent vaqtida qisqa sana-vaqt
function tgTime(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent', hour12: false,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

// Xona o'chirilgandagi e'lon matni — xabar O'CHIRILMAYDI, shu holatga tahrirlanadi,
// ya'ni guruhda xona haqidagi ma'lumot tarix bo'lib qoladi.
function tgRoomClosedText(g, reason) {
  const inRoom = (g.players || []).filter(p => !p.isBot).length;
  const max = g.totalPlayers || g.maxPlayers || 8;
  const ever = Array.isArray(g.everPlayers) ? g.everPlayers : [];
  const names = ever.map(tgEsc).slice(0, 12);
  const more = ever.length - names.length;
  const wasPlaying = g.status === 'playing';
  const lines = [
    `\u{1F5D1} <b>${tgEsc(g.name || 'Mafia xonasi')}</b> — xona o'chirildi`,
    '',
    `\u{1F4CB} Sabab: ${tgEsc(reason)}`,
    `\u{1F4CA} Holati: ${wasPlaying ? "o'yin ketayotgan edi" : 'kutish (boshlanmagan)'}`,
    `\u{1F465} Yopilganda xonada: <b>${inRoom}/${max}</b>`,
  ];
  if (ever.length) {
    lines.push(`\u{1F464} Qatnashganlar (${ever.length}): ${names.join(', ')}${more > 0 ? ` va yana ${more} ta` : ''}`);
  } else {
    lines.push('\u{1F464} Xonaga hech kim kirmagan');
  }
  if (wasPlaying && g.round) lines.push(`\u{1F504} Raund: ${g.round}`);
  lines.push(`\u{1F551} Ochilgan: ${tgTime(g.createdAt)}`);
  lines.push(`\u{1F551} Yopilgan: ${tgTime(Date.now())}`);
  return lines.join('\n');
}

// xona o'chdi (bo'sh qoldi / egasi yopdi / admin yopdi) — e'lon "o'chirildi" holatiga o'tadi
async function tgRoomCancel(gameId, g, reason) {
  if (!tgGroupOn()) return;
  const t = tgEditTimers.get(gameId);
  if (t) { clearTimeout(t.timer); tgEditTimers.delete(gameId); }
  if (!g || !g.tgMessageId) return;
  await tgApi('editMessageText', {
    chat_id: TG_GROUP_CHAT_ID, message_id: g.tgMessageId,
    text: tgRoomClosedText(g, reason), parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
  });
}

async function approveDevice(deviceId) {
  if (deviceId) await redis.set(`admin:approved:${deviceId}`, '1', 'EX', 7200).catch(() => {}); // 2 soat
}
// eskirgan so'rovlarni tozalash
setInterval(() => { const now = Date.now(); for (const [k, v] of accessReqs) if (now - v.t > 600000) accessReqs.delete(k); }, 300000).unref?.();

// /control kirishida — Telegram'ga so'rov yuboradi
app.post('/api/access-request', limitAuth, async (req, res) => {
  try {
    const deviceId = String(req.headers['x-device-id'] || req.body?.deviceId || '').slice(0, 60);
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 220);
    if (!TG_ADMIN_BOT_TOKEN || !TG_ADMIN_CHAT_ID) return res.json({ requestId: null, disabled: true });
    // dedup: shu qurilma+IP yaqinda pending bo'lsa qayta yubormaymiz (spam oldini olish)
    for (const [rid, r] of accessReqs) {
      if (r.deviceId === deviceId && r.ip === ip && r.status === 'pending' && Date.now() - r.t < 120000) {
        return res.json({ requestId: rid });
      }
    }
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const rec = { deviceId, ip, ua, status: 'pending', t: Date.now() };
    accessReqs.set(requestId, rec);
    // Hamma qiymat hujumchi nazoratida (sarlavhalardan keladi) — parse_mode:'HTML'
    // bo'lgani uchun ESKEYP SHART, aks holda admin xabarini soxtalashtirish mumkin.
    const text = `🔐 <b>Admin panelga kirish so'rovi</b>\n\n`
      + `🌐 IP: <code>${tgEsc(ip)}</code>\n`
      + `📱 Qurilma: <code>${tgEsc((deviceId || '—').slice(0, 16))}</code>\n`
      + `🧭 <code>${tgEsc(ua)}</code>\n`
      + `🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
    tgApi('sendMessage', {
      chat_id: TG_ADMIN_CHAT_ID, text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Ruxsat berish', callback_data: `ok:${requestId}` },
        { text: '❌ Rad etish', callback_data: `no:${requestId}` },
      ]] },
    }).catch(() => {});
    res.json({ requestId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// frontend holatni so'rab turadi
app.get('/api/access-status', (req, res) => {
  const r = accessReqs.get(String(req.query.requestId || ''));
  res.json({ status: r ? r.status : 'unknown' });
});

// Telegram tugmalarini qabul qilish (long-polling)
let tgOffset = 0;
async function tgPoll() {
  if (!TG_ADMIN_BOT_TOKEN) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_ADMIN_BOT_TOKEN}/getUpdates?timeout=30&offset=${tgOffset}`);
    const j = await r.json().catch(() => null);
    if (j?.ok && Array.isArray(j.result)) {
      for (const u of j.result) {
        tgOffset = u.update_id + 1;

        // Shaxsiy chatda /start (yoki oddiy xabar) — saytga va guruhga yo'naltiramiz.
        // Guruh/kanal xabarlariga javob bermaymiz: bot guruhda admin, spam qilmasin.
        const m = u.message;
        if (m?.chat?.type === 'private' && typeof m.text === 'string') {
          if (/^\/(start|help)\b/i.test(m.text.trim()) || !m.text.startsWith('/')) {
            await tgStart(m).catch(() => {});
          }
          continue;
        }

        const cb = u.callback_query;
        if (cb?.data) {
          const [action, rid] = String(cb.data).split(':');
          const rec = accessReqs.get(rid);
          let note = 'Eskirgan yoki yopilgan so\'rov';
          if (rec && rec.status === 'pending') {
            if (action === 'ok') { rec.status = 'approved'; await approveDevice(rec.deviceId); note = '✅ Ruxsat berildi (2 soat)'; }
            else if (action === 'no') { rec.status = 'denied'; note = '❌ Rad etildi'; }
          }
          await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: note });
          if (cb.message) await tgApi('editMessageText', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            text: `${cb.message.text}\n\n— <b>${note}</b>`, parse_mode: 'HTML',
          });
        }
      }
    }
  } catch {}
  setTimeout(tgPoll, 800);
}

// Ref-manba nomini tozalash: faqat qisqa, xavfsiz belgi. Noma'lum bo'lsa 'direct'.
const REF_KNOWN = ['tgbot', 'tggroup', 'direct'];
function normRef(v) {
  const s = String(v || '').trim().toLowerCase().slice(0, 24);
  if (!s) return 'direct';
  if (REF_KNOWN.includes(s)) return s;
  return /^[a-z0-9_-]{1,24}$/.test(s) ? s : 'direct';
}

// ==================== SETTINGS ====================

const DEFAULT_SETTINGS = {
  durations: {
    day_discussion: 120,
    day_results:    8,
    night:          35,
    night_mafia:    25,
    night_komissar: 20,
    night_doctor:   20,
    night_sheriff:  20,
    night_escort:   20,
    night_advokat:  20,
    night_qotil:    20,
    night_daydi:    20,
    night_skip:     3,   // rol yo'q bo'lsa "...siz" qisqa o'tish
    night_results:  8,
  },
  defaultRoles: { sheriffCount: 1, doctorCount: 1, mafiaRatio: 0.3 },
  minPlayers: 5,   // 3-4 kishida o'yin birinchi ovozdayoq tugaydi — tun mexanikasi ishlamaydi
  maxRooms: 50,
  allowPasswordAuth: false,   // parol bilan register/login o'chiq — faqat Google (anti-bot)
  maxSignupsPerIpHour: 8,     // bir IP'dan soatiga yangi akkaunt chegarasi (proxy bo'lmasa)
};

async function getSettings() {
  try {
    const r = await redis.get('settings:global');
    if (r) return { ...DEFAULT_SETTINGS, ...JSON.parse(r) };
  } catch {}
  return DEFAULT_SETTINGS;
}
async function saveSettings(s) {
  await redis.set('settings:global', JSON.stringify(s));
}

// foydalanuvchining kunlik xona limiti — admin tomonidan alohida belgilangan bo'lsa o'shani,
// aks holda umumiy sozlamadagi qiymatni qaytaradi
async function userDailyLimit(userId, settings) {
  const def = (settings || await getSettings()).dailyRoomLimit || 2;
  try {
    const v = await redis.hget('roomlimits', String(userId));
    if (v != null && v !== '') return Math.max(0, parseInt(v));
  } catch {}
  return def;
}

// ==================== AUTH HELPERS ====================

// qurilma ID hash'i (token o'g'irlanishidan himoya — token shu qurilmaga bog'lanadi)
function deviceHash(id) {
  if (!id) return null;
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}
function reqDeviceId(req) {
  return req.headers['x-device-id'] || req.body?.deviceId || null;
}

function signToken(user, deviceId) {
  const payload = { userId: user.id, username: user.username, isAdmin: user.isAdmin };
  const dvc = deviceHash(deviceId);
  if (dvc) payload.dvc = dvc; // tokenni shu qurilmaga bog'laymiz
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// ==================== BAN KESHI ====================
// JWT 30 kun yashaydi va o'z-o'zidan bekor bo'lmaydi. Bloklangan foydalanuvchi
// eski tokeni bilan hamma narsadan foydalanaverardi. Har so'rovda bazaga bormaslik
// uchun bloklanganlar ro'yxatini Redis to'plamida saqlaymiz.
const BAN_SET = 'banned:users';
async function isBanned(userId) {
  if (!userId || !isRealUser(userId)) return false;
  try {
    return (await redis.sismember(BAN_SET, String(userId))) === 1;
  } catch {
    // Redis uzilgan — jimgina "bloklanmagan" deb o'tkazib yubormaymiz, bazadan so'raymiz
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true } });
      return u?.isBanned === true;
    } catch { return false; }
  }
}
async function setBanned(userId, banned) {
  try {
    if (banned) await redis.sadd(BAN_SET, String(userId));
    else await redis.srem(BAN_SET, String(userId));
  } catch {}
}
// Server ishga tushganda keshni bazadan tiklaymiz (restartda ban yo'qolmasin)
async function loadBans() {
  try {
    const rows = await prisma.user.findMany({ where: { isBanned: true }, select: { id: true } });
    if (rows.length) await redis.sadd(BAN_SET, ...rows.map(r => r.id));
    console.log(`🚫 ${rows.length} ta bloklangan hisob keshga yuklandi`);
  } catch (e) { console.error('loadBans:', e.message); }
}
// Bloklangan foydalanuvchining barcha ochiq socketlarini uzamiz
function kickUserSockets(userId, reason) {
  // socketData faqat O'YINGA KIRGAN socketlarni biladi — handshake'dagi token
  // bo'yicha ham qidiramiz, aks holda lobbyda turgan sessiya uzilmay qolardi.
  for (const [, s] of io.sockets.sockets) {
    const byGame = socketData.get(s.id)?.userId;
    const byAuth = s.data?.auth?.userId;
    if (byGame !== userId && byAuth !== userId) continue;
    try { s.emit('game_closed', { code: 'banned', message: reason }); s.disconnect(true); } catch {}
  }
}

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Avtorizatsiya kerak' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token yaroqsiz', code: 'token_invalid' });
  }
  // qurilma bog'lash: token qurilmaga bog'langan bo'lsa — mos kelishi shart
  if (payload.dvc) {
    const dev = reqDeviceId(req);
    if (!dev || deviceHash(dev) !== payload.dvc) {
      return res.status(401).json({ error: 'Qurilma mos emas — sessiya bekor qilindi', code: 'device_mismatch' });
    }
  }
  if (await isBanned(payload.userId)) {
    return res.status(403).json({ error: 'Siz bloklangansiz', code: 'banned' });
  }
  req.user = payload;
  next();
}

async function adminMiddleware(req, res, next) {
  if (!req.user?.userId) return res.status(401).json({ error: 'Avtorizatsiya kerak' });
  // DB — admin huquqining HAQIQIY manbasi. Token eskirgan bo'lishi mumkin
  // (foydalanuvchi hozirgina admin qilingan yoki adminlikdan olingan bo'lishi mumkin),
  // shuning uchun tokenga emas, bazadagi joriy qiymatga tayanamiz.
  // try/catch SHART: Express 4 async middleware xatosini ushlamaydi va DB uzilsa
  // so'rov javobsiz osilib qolardi.
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!u?.isAdmin) return res.status(403).json({ error: 'Faqat admin' });
    next();
  } catch (e) {
    console.error('adminMiddleware:', e.message);
    res.status(503).json({ error: 'Baza hozir mavjud emas' });
  }
}

// ==================== AUTH ROUTES ====================

app.post('/api/register', limitAuth, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.allowPasswordAuth) return res.status(403).json({ error: 'Ro\'yxatdan o\'tish faqat Google orqali' });
    let { username, password } = req.body;
    username = (username || '').trim();
    if (username.length < 2) return res.status(400).json({ error: 'Username kamida 2 belgi' });
    if (!password || password.length < 3) return res.status(400).json({ error: 'Parol kamida 3 belgi' });

    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) return res.status(409).json({ error: 'Bu username band' });

    // birinchi foydalanuvchi avtomatik admin
    const userCount = await prisma.user.count();
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        username, password: hash,
        email: `${username.toLowerCase()}@mafia.local`,
        isAdmin: userCount === 0,
        items: DEFAULT_ITEMS,
        stats: { create: {} }
      }
    });
    res.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin, items: normItems(user.items), token: signToken(user, reqDeviceId(req)) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Bu username band' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', limitAuth, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.allowPasswordAuth) return res.status(403).json({ error: 'Kirish faqat Google orqali' });
    let { username, password } = req.body;
    username = (username || '').trim();
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (user.isBanned) return res.status(403).json({ error: 'Siz bloklangansiz' });
    const ok = await bcrypt.compare(password || '', user.password);
    if (!ok) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeen: new Date() } }).catch(() => {});
    res.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin, token: signToken(user, reqDeviceId(req)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== GOOGLE SIGN-IN ====================
// "Sign in with Google" tugmasi yuborgan ID token (credential) ni tekshiradi,
// gmail/ism/rasm oladi, foydalanuvchini yaratadi yoki topadi va token qaytaradi.

async function uniqueUsername(base) {
  let candidate = (base || 'player')
    .normalize('NFKD').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'player';
  let username = candidate;
  // band bo'lsa raqam qo'shib ketamiz
  for (let i = 0; i < 50; i++) {
    const taken = await prisma.user.findUnique({ where: { username } });
    if (!taken) return username;
    username = `${candidate}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return `${candidate}${Date.now().toString().slice(-6)}`;
}

app.post('/api/auth/google', limitAuth, async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential yo\'q' });
    // Reklama manbasi: bot/guruh havolasidagi ?ref= frontendda saqlanib, shu yerga keladi.
    // Faqat YANGI akkauntga yoziladi — keyin o'zgarmaydi.
    const refSource = normRef(req.body.ref);

    // ID tokenni Google bilan tekshirish
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Google token yaroqsiz' });
    }

    const email = (payload?.email || '').toLowerCase();
    if (!email || payload.email_verified === false) {
      return res.status(400).json({ error: 'Gmail tasdiqlanmagan' });
    }
    const fullName = payload.name || payload.given_name || email.split('@')[0];
    const picture = payload.picture || null;

    // email bo'yicha mavjud foydalanuvchini topamiz
    let user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      if (user.isBanned) return res.status(403).json({ error: 'Siz bloklangansiz' });
      user = await prisma.user.update({
        where: { id: user.id },
        data: { avatar: picture, lastSeen: new Date() }
      });
    } else {
      // yangi akkaunt — bitta IP'dan soatiga ortiqcha akkaunt ochishni cheklaymiz (proxy bo'lmasa)
      const s = await getSettings();
      if (!signupAllowed(clientIp(req), s.maxSignupsPerIpHour || 8)) {
        return res.status(429).json({ error: 'Bu qurilmadan juda ko\'p yangi akkaunt. Keyinroq urinib ko\'ring.' });
      }
      const userCount = await prisma.user.count();
      const username = await uniqueUsername(fullName.replace(/\s+/g, '') || email.split('@')[0]);
      const randomPass = await bcrypt.hash(Math.random().toString(36) + Date.now(), BCRYPT_ROUNDS);
      user = await prisma.user.create({
        data: {
          username,
          email,
          password: randomPass,
          avatar: picture,
          refSource,
          isAdmin: userCount === 0,
          items: DEFAULT_ITEMS,
          stats: { create: {} }
        }
      });
    }

    res.json({
      userId: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      avatar: user.avatar || null,
      items: normItems(user.items),
      token: signToken(user, reqDeviceId(req))
    });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Bu hisob allaqachon mavjud' });
    res.status(500).json({ error: e.message });
  }
});

// ALOHIDA ADMIN PANEL LOGIN (faqat admin huquqiga ega foydalanuvchilar)
// Admin paroli — eng qimmatli nishon, shuning uchun oddiy login'dan ancha qattiq
// chegara (40/min emas, 5/min): parolni taxminlab topishga urinish amalda imkonsiz.
const limitAdminLogin = rateLimiter({
  windowMs: 60000, max: 5,
  message: 'Juda ko\'p urinish. Bir daqiqadan keyin qayta urinib ko\'ring.',
});
app.post('/api/admin/login', limitAdminLogin, async (req, res) => {
  try {
    let { username, password } = req.body;
    username = (username || '').trim();
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin huquqi yo\'q' });
    if (user.isBanned) return res.status(403).json({ error: 'Hisob bloklangan' });
    const ok = await bcrypt.compare(password || '', user.password);
    if (!ok) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeen: new Date() } }).catch(() => {});
    res.json({ userId: user.id, username: user.username, isAdmin: true, token: signToken(user, reqDeviceId(req)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// joriy foydalanuvchi profili + stats
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { stats: true }
    });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    // mavjud foydalanuvchilarga starter to'plamni bir marta beramiz
    let items = u.items;
    if (items == null) {
      items = DEFAULT_ITEMS;
      await prisma.user.update({ where: { id: u.id }, data: { items } }).catch(() => {});
    }
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const settings = await getSettings();
    const dailyLimit = await userDailyLimit(u.id, settings);
    const roomsToday = await prisma.game.count({ where: { hostId: u.id, createdAt: { gte: startOfDay } } });
    // kunlik bonus bugun olinganmi?
    const bonusReady = !u.lastBonusAt || new Date(u.lastBonusAt) < startOfDay;
    res.json({
      userId: u.id, username: u.username, isAdmin: u.isAdmin, isBanned: u.isBanned,
      avatar: u.avatar || null,
      items: normItems(items),
      coins: u.coins ?? 0,
      bonusReady,
      shopPrices: ECONOMY.prices,
      dailyBonus: ECONOMY.dailyBonus,
      dailyLimit, roomsToday, roomsLeft: Math.max(0, dailyLimit - roomsToday),
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: RATING_START, xp: 0 }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🛒 do'kon — tangaga item sotib olish
app.post('/api/shop/buy', authMiddleware, limitByUser(40), async (req, res) => {
  try {
    const { item } = req.body;
    if (!ITEM_KEYS.includes(item)) return res.status(400).json({ error: 'Noma\'lum buyum' });
    const price = ECONOMY.prices[item];
    const userId = req.user.userId;
    // Bir foydalanuvchining xaridlarini navbatga qo'yamiz: aks holda ikkita parallel
    // so'rov bir xil balansni ko'rib, tangadan ko'p buyum olish mumkin edi.
    const out = await withLock(`user:${userId}`, async () => {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u) return { err: 404, msg: 'Topilmadi' };
      if ((u.coins ?? 0) < price) return { err: 400, msg: 'Tanga yetarli emas' };
      const items = normItems(u.items);
      items[item] = (items[item] || 0) + 1;
      const updated = await prisma.user.update({
        where: { id: u.id },
        data: { coins: { decrement: price }, items }
      });
      return { coins: updated.coins, items: normItems(updated.items) };
    });
    if (out.err) return res.status(out.err).json({ error: out.msg });
    await logActivity(userId, 'shop_buy', { item, amount: -price, detail: `Do'kondan ${item} sotib olindi` });
    res.json({ ok: true, coins: out.coins, items: out.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🎁 kunlik bonus — kuniga bir marta
app.post('/api/daily-bonus', authMiddleware, limitByUser(20), async (req, res) => {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    // Shart bilan yangilash — parallel ikkita so'rov ikki marta bonus bera olmaydi.
    const claimed = await prisma.user.updateMany({
      where: {
        id: req.user.userId,
        OR: [{ lastBonusAt: null }, { lastBonusAt: { lt: startOfDay } }],
      },
      data: { coins: { increment: ECONOMY.dailyBonus }, lastBonusAt: new Date() },
    });
    if (claimed.count === 0) {
      const exists = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: 'Topilmadi' });
      return res.status(429).json({ error: 'Bugungi bonus allaqachon olingan' });
    }
    const fresh = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { coins: true } });
    await logActivity(req.user.userId, 'coin_bonus', { amount: ECONOMY.dailyBonus, detail: 'Kunlik bonus' });
    res.json({ ok: true, coins: fresh?.coins ?? 0, bonus: ECONOMY.dailyBonus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 📜 o'yin tarixi (oxirgi 20 ta)
app.get('/api/me/history', authMiddleware, async (req, res) => {
  try {
    const list = await prisma.gameHistory.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }, take: 20
    });
    res.json(list.map(h => ({ role: h.role, won: h.won, winner: h.winner, coins: h.coins, createdAt: h.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 👤 profilni tahrirlash — nikname va rasm. Bo'sh nikname mumkin emas.
app.put('/api/me/profile', authMiddleware, limitByUser(15), async (req, res) => {
  try {
    let { username, avatar } = req.body;
    const data = {};
    if (username !== undefined) {
      username = String(username || '').trim();
      if (username.length < 2) return res.status(400).json({ error: 'Nikname kamida 2 belgi bo\'lishi kerak' });
      if (username.length > 20) return res.status(400).json({ error: 'Nikname 20 belgidan oshmasin' });
      const taken = await prisma.user.findFirst({ where: { username, NOT: { id: req.user.userId } } });
      if (taken) return res.status(409).json({ error: 'Bu nikname band' });
      data.username = username;
    }
    if (avatar !== undefined) {
      if (avatar === null || avatar === '') data.avatar = null;
      else {
        const s = String(avatar);
        // Avatar har bir o'yinchiga game_state bilan tarqaladi — shuning uchun kichik
        // bo'lishi SHART. Frontend rasmni 256px JPEG ga siqadi (~10–25KB), 60KB yetarli.
        const isData = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
        // Tashqi URL sifatida FAQAT Google profil rasmlari qabul qilinadi
        // (boshqa xost avatar orqali foydalanuvchi IP'sini yig'ish kanali bo'lardi).
        const isUrl = /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\/[^\s"'<>]*$/i.test(s) && s.length <= 600;
        if (!isData && !isUrl) return res.status(400).json({ error: 'Rasm formati noto\'g\'ri' });
        if (s.length > 60000) return res.status(400).json({ error: 'Rasm juda katta (max ~45KB)' });
        data.avatar = s;
      }
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'O\'zgartirish yo\'q' });
    const u = await prisma.user.update({ where: { id: req.user.userId }, data });
    // username token ichida — yangi token qaytaramiz
    res.json({ userId: u.id, username: u.username, avatar: u.avatar || null, isAdmin: u.isAdmin, token: signToken(u, reqDeviceId(req)) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Bu nikname band' });
    res.status(500).json({ error: e.message });
  }
});

// reyting jadvali (public) — pagination
app.get('/api/leaderboard', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
    const total = await prisma.userStats.count();
    const rows = await prisma.userStats.findMany({
      orderBy: [{ rating: 'desc' }, { gamesWon: 'desc' }],
      skip: (page - 1) * limit, take: limit,
      include: { user: { select: { username: true } } }   // avatar yo'q — payload yengil
    });
    res.json({
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      // Liga va daraja SERVERDA hisoblanadi: chegaralar bitta joyda
      // (progression.js) turishi kerak, aks holda frontend bilan
      // bir-biriga mos kelmay qoladi.
      players: rows.map((s, i) => ({
        rank: (page - 1) * limit + i + 1,
        username: s.user.username, rating: s.rating,
        gamesPlayed: s.gamesPlayed, gamesWon: s.gamesWon, winRate: s.winRate,
        xp: s.xp || 0, level: levelFromXp(s.xp || 0), tier: tierOf(s.rating),
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liga chegaralari (public). /reyting sahifasidagi jadval shundan chiziladi —
// chegaralar frontendda TAKRORLANMASIN, aks holda biri o'zgarganda ikkinchisi
// jimgina noto'g'ri ko'rsatib turardi.
app.get('/api/tiers', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ start: RATING_START, tiers: TIERS });
});

// joriy foydalanuvchining reytingdagi o'rni
app.get('/api/me/rank', authMiddleware, async (req, res) => {
  try {
    const s = await prisma.userStats.findUnique({ where: { userId: req.user.userId } });
    const rating = s?.rating ?? 1000;
    // mendan yuqori reytingli o'yinchilar soni + 1 = mening o'rnim
    const higher = await prisma.userStats.count({ where: { rating: { gt: rating } } });
    const total = await prisma.userStats.count();
    // DIQQAT: levelProgress ham, tierProgress ham `left` va `percent`
    // qaytaradi. Ikkovini bitta obyektga yoysak biri ikkinchisini bosib
    // ketadi va interfeys "keyingi darajagacha" o'rniga liga ochkosini
    // ko'rsatib qo'yadi. Shuning uchun nomlari ATAYLAB ajratilgan.
    const lv = levelProgress(s?.xp ?? 0);
    const tr = tierProgress(rating);
    res.json({
      rank: higher + 1, total, rating,
      gamesPlayed: s?.gamesPlayed ?? 0, gamesWon: s?.gamesWon ?? 0, winRate: s?.winRate ?? 0,
      // daraja
      level: lv.level, xp: lv.xp, into: lv.into, need: lv.need,
      xpLeft: lv.left, percent: lv.percent,
      // liga
      tier: tr.tier, next: tr.next, tierPercent: tr.percent, tierLeft: tr.left,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== GAME REST ROUTES ====================

// Oddiy holat — watchdog va nginx uchun. Batafsil raqamlar faqat admin kaliti bilan:
// ochiq ko'rsatilsa hujumchi himoya chegaralarini o'lchab olardi.
app.get('/health', (req, res) => {
  const base = { status: 'ok' };
  const key = req.query.key || req.headers['x-admin-key'];
  if (!ADMIN_ACCESS_KEY || key !== ADMIN_ACCESS_KEY) return res.json(base);
  const mem = process.memoryUsage();
  res.json({
    ...base,
    uptimeSec: Math.round(process.uptime()),
    sockets: { ochiq: io.engine.clientsCount, chegara: MAX_TOTAL_SOCKETS, ipLar: ipConns.size },
    ramMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    // rad etilgan ulanishlar (server ishga tushgandan beri)
    radEtilgan: {
      tokensiz: shield.noAuth,          // SOCKET_REQUIRE_AUTH
      ipChegarasi: shield.perIp,        // MAX_CONN_PER_IP
      tezUlanish: shield.handshake,     // MAX_HANDSHAKE_PER_IP
      serverToldi: shield.total,        // MAX_TOTAL_SOCKETS
      bekorTurgan: shield.idle,         // IDLE_SOCKET_MS
    },
  });
});

// 🟢 Presence (live users) — har qurilma 15s'da bir marta "men shu yerdaman" deydi.
// Auth qilganlar va qilmaganlar alohida hisoblanadi (qurilma ID bo'yicha).
app.post('/api/presence', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) return res.json({ ok: true });
    let authed = false;
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) { try { jwt.verify(token, JWT_SECRET); authed = true; } catch {} }
    const now = Date.now();
    if (authed) { await redis.zadd('presence:auth', now, deviceId); await redis.zrem('presence:anon', deviceId); }
    else { await redis.zadd('presence:anon', now, deviceId); await redis.zrem('presence:auth', deviceId); }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ==================== OCHIQ STATISTIKA (landing sahifasi uchun) ====================
// Kirmagan mehmon ham ko'radi, shuning uchun faqat zararsiz umumiy raqamlar.
// Natija 10 soniya Redis'da keshlanadi — ochiq endpoint bazani charchatmasin.
app.get('/api/stats', async (_, res) => {
  try {
    const cached = await redis.get('cache:pubstats').catch(() => null);
    if (cached) return res.json(JSON.parse(cached));

    const cut = Date.now() - 30000; // oxirgi 30 s da ko'ringan qurilma = onlayn
    await redis.zremrangebyscore('presence:auth', '-inf', cut).catch(() => {});
    await redis.zremrangebyscore('presence:anon', '-inf', cut).catch(() => {});

    const [players, gamesPlayed, activeGames, onAuth, onAnon] = await Promise.all([
      prisma.user.count(),
      prisma.game.count({ where: { status: 'finished' } }),
      prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } }),
      redis.zcard('presence:auth').catch(() => 0),
      redis.zcard('presence:anon').catch(() => 0),
    ]);
    // Haqiqiy onlayn ustiga bazaviy egri chiziq qo'shiladi — real o'yinchilar
    // kelganda raqam ular bilan birga o'sadi.
    // Haqiqiy faollik har doim USTIGA qo'shiladi: yangi hisob ro'yxatdan
    // o'tsa umumiy son bittaga ko'payadi, odam kirsa onlayn bittaga ko'payadi.
    const t = Date.now();
    const data = {
      players: players + fakePlayersBase(t, FAKE_ONLINE),
      gamesPlayed: gamesPlayed + fakeGamesPlayed(t, FAKE_ONLINE),
      activeGames: activeGames + fakeRooms(t, FAKE_ONLINE).length,
      online: onAuth + onAnon + fakeOnlineBase(t, FAKE_ONLINE),
      onlineAuthed: onAuth,
    };
    await redis.set('cache:pubstats', JSON.stringify(data), 'EX', 10).catch(() => {});
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// hydrate: redis yo'q bo'lsa postgres dan tiklash (faqat waiting xonalar uchun)
async function getG(gameId) {
  const r = await redis.get(`game:${gameId}`);
  if (r) return JSON.parse(r);
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return null;
  if (game.status === 'waiting') {
    const settings = await getSettings();
    // DIQQAT: roleConfig Postgres'da saqlanmaydi (faqat Redis'da) — Redis yo'qolsa
    // host tanlagan rol tarkibi tiklanmaydi va avto-balansga tushadi.
    const state = {
      ...game, players: [], phase: 'waiting',
      vsBots: String(game.name || '').startsWith('🤖'),   // bot xonasini nomidan tanib olamiz
      dayVotes: {}, nightActions: {}, round: 0,
      durations: settings.durations, log: []
    };
    if (game.isPrivate) console.warn(`⚠️  ${gameId}: Redis holati yo'qolgan — roleConfig tiklanmadi`);
    await saveG(gameId, state);
    return state;
  }
  // playing/finished holati yo'qolgan (Redis TTL tugagan / tozalangan) — tugatilgan
  // deb hisoblaymiz. Bazadagi yozuvni ham yopamiz, aks holda "arvoh" o'yinlar
  // aktiv bo'lib qolib maxRooms chegarasini to'ldirib tashlardi.
  if (game.status === 'playing') {
    prisma.game.update({ where: { id: gameId }, data: { status: 'finished', endedAt: new Date() } }).catch(() => {});
  }
  return null;
}
async function saveG(gameId, g) {
  await redis.set(`game:${gameId}`, JSON.stringify(g), 'EX', 86400);
}

// barcha aktiv xonalar ro'yxati
app.get('/api/games', async (_, res) => {
  try {
    // qisqa keshlash: ko'p klient poll qilsa ham og'ir ish 3s da bir marta bajariladi
    const cached = await redis.get('cache:games').catch(() => null);
    if (cached) return res.json(JSON.parse(cached));

    const games = await prisma.game.findMany({
      where: { status: { in: ['waiting', 'playing'] }, isPrivate: false },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = await Promise.all(games.map(async g => {
      const raw = await redis.get(`game:${g.id}`);
      const state = raw ? JSON.parse(raw) : null;
      // o'yin ketyapti lekin holati yo'q — eskirgan, ko'rsatmaymiz
      if (!state && g.status === 'playing') return null;
      return {
        id: g.id, name: g.name, status: g.status,
        totalPlayers: g.totalPlayers, mafiaCount: g.mafiaCount,
        sheriffCount: g.sheriffCount, doctorCount: g.doctorCount, civilCount: g.civilCount,
        hostId: g.hostId, createdAt: g.createdAt,
        phase: state?.phase || 'waiting',
        players: (state?.players || []).map(p => ({ userId: p.userId, username: p.username, isAlive: p.isAlive }))
      };
    }));
    // Lobbi bo'sh ko'rinmasin: soxta xonalar qo'shiladi. Ularning HAMMASI
    // to'lgan yoki jangda — ya'ni qo'shilib bo'lmaydi (frontend bunday
    // xonaning tugmasini o'zi bloklaydi). Sabab: soxta xona ID si haqiqiy
    // emas, unga kirmoqchi bo'lgan odam "Xona topilmadi" xatosini ko'rardi.
    // Haqiqiy xonalar tepada turadi — odamlar bir-birini topa olsin.
    const real = enriched.filter(Boolean);
    const list = [...real, ...fakeRooms(Date.now(), FAKE_ONLINE)];
    await redis.set('cache:games', JSON.stringify(list), 'EX', 3).catch(() => {});
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// yangi xona yaratish (ko'p xona ruxsat etilgan)
app.post('/api/games', authMiddleware, limitByUser(30), async (req, res) => {
  try {
    const settings = await getSettings();
    const activeCount = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
    if (activeCount >= (settings.maxRooms || 50)) {
      return res.status(429).json({ error: 'Xonalar limiti to\'ldi. Keyinroq urinib ko\'ring.' });
    }

    // KUNLIK LIMIT: har bir foydalanuvchi kuniga maksimum 2 ta xona yaratadi
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await prisma.game.count({ where: { hostId: req.user.userId, createdAt: { gte: startOfDay } } });
    const DAILY_LIMIT = await userDailyLimit(req.user.userId, settings);
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({ error: `Kuniga maksimum ${DAILY_LIMIT} ta xona yaratish mumkin. Mavjud xonaga qo'shiling.` });
    }

    let { name, totalPlayers, mafiaCount, sheriffCount, doctorCount, isPrivate, roles } = req.body;
    totalPlayers = Math.max(5, Math.min(20, parseInt(totalPlayers) || 8));

    // host qo'lda rol tanlagan bo'lsa — tekshirib olamiz
    const roleConfig = normalizeRoleConfig(roles, totalPlayers);

    if (roleConfig) {
      // DB ustunlari (lobby kartochkalarida ko'rsatish uchun) roleConfig'dan kelib chiqadi
      mafiaCount   = SELECTABLE_ROLES.filter(r => sideOf(r) === 'mafia').reduce((a, r) => a + (roleConfig[r] || 0), 0);
      doctorCount  = roleConfig.doctor || 0;
      sheriffCount = roleConfig.komissar || 0;
    } else {
      mafiaCount   = Math.max(1, Math.min(totalPlayers - 2, parseInt(mafiaCount) || Math.ceil(totalPlayers * settings.defaultRoles.mafiaRatio)));
      sheriffCount = Math.max(0, parseInt(sheriffCount ?? settings.defaultRoles.sheriffCount));
      doctorCount  = Math.max(0, parseInt(doctorCount ?? settings.defaultRoles.doctorCount));
    }
    const civilCount = roleConfig ? (roleConfig.civil || 0) : Math.max(0, totalPlayers - mafiaCount - sheriffCount - doctorCount);

    const game = await prisma.game.create({
      data: {
        name: (name || '').trim().slice(0, 40) || `${req.user.username} xonasi`,
        status: 'waiting', hostId: req.user.userId, isPrivate: !!isPrivate,
        totalPlayers, maxPlayers: 20, minPlayers: settings.minPlayers || 5,
        mafiaCount, sheriffCount, doctorCount, civilCount
      }
    });
    // ---- Xonani to'ldiruvchi botlar ----
    // Yangi platformada bo'sh xona o'yinchini quvadi: u kirib, kimnidir kutib
    // o'tiradi va chiqib ketadi. Shuning uchun OCHIQ xona sig'imining bir qismi
    // darhol to'ldiriladi. Yopiq xonaga bot qo'shilmaydi — u do'stlar uchun
    // ochiladi va lobbi ro'yxatida ham ko'rinmaydi, ya'ni "sayt jonli" ko'rinishiga
    // hissa qo'shmaydi.
    //
    // Xona egasi istalgan botni (yoki odamni) chiqarib yuborishi mumkin —
    // socket hodisasi 'kick_player'.
    const fillRatio = clamp01(parseFloat(process.env.BOT_FILL_RATIO || '0.7'));
    const wantBots = (process.env.BOT_FILL === '0' || isPrivate)
      ? 0
      // host uchun kamida bitta joy qoldiramiz
      : Math.max(0, Math.min(totalPlayers - 1, Math.round(totalPlayers * fillRatio)));
    const fillers = wantBots > 0 ? makeFillerBots(game.id, wantBots, [req.user.username]) : [];

    const state = {
      ...game, players: [], phase: 'waiting', roleConfig: roleConfig || null,
      dayVotes: {}, nightActions: {}, round: 0, durations: settings.durations, log: [],
      botEvents: [], kicked: {},
    };
    await saveG(game.id, state);
    // Botlar bittalab, 2-9 soniya oralig'ida qo'shiladi
    if (fillers.length) scheduleBotJoins(game.id, fillers);
    scheduleEmptyCheck(game.id); // 2 daqiqa ichida ODAM kirmasa o'chadi
    tgRoomAnnounce(game.id).catch(() => {}); // Telegram guruhiga e'lon (ochiq xonalar)
    res.json(game);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🤖 BOTLAR BILAN O'YIN — xona ochmasdan, barcha rollardan, tez o'yin
app.post('/api/games/bots', authMiddleware, limitByUser(30), async (req, res) => {
  try {
    const settings = await getSettings();
    // Bot o'yinlari ham resurs yeydi — umumiy xona chegarasi va kunlik limit
    // bu yerda ham amal qiladi (ilgari ikkalasini ham chetlab o'tardi).
    const activeCount = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
    if (activeCount >= (settings.maxRooms || 50)) {
      return res.status(429).json({ error: 'Xonalar limiti to\'ldi. Keyinroq urinib ko\'ring.' });
    }
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const botsToday = await prisma.game.count({
      where: { hostId: req.user.userId, createdAt: { gte: dayStart }, isPrivate: true, name: { startsWith: '🤖' } },
    });
    const BOT_DAILY_LIMIT = settings.dailyBotLimit || 30;
    if (botsToday >= BOT_DAILY_LIMIT) {
      return res.status(429).json({ error: `Kuniga maksimum ${BOT_DAILY_LIMIT} ta bot o'yini` });
    }

    const roleConfig = allRolesConfig();
    const totalPlayers = Object.values(roleConfig).reduce((a, c) => a + c, 0); // 12
    const mafiaCount = SELECTABLE_ROLES.filter(r => sideOf(r) === 'mafia').reduce((a, r) => a + (roleConfig[r] || 0), 0);

    const game = await prisma.game.create({
      data: {
        name: `🤖 ${req.user.username} — botlar`,
        status: 'waiting', hostId: req.user.userId, isPrivate: true,
        totalPlayers, maxPlayers: 20, minPlayers: 2,
        mafiaCount, sheriffCount: roleConfig.komissar || 0, doctorCount: roleConfig.doctor || 0,
        civilCount: roleConfig.civil || 0
      }
    });
    // botlar (foydalanuvchi keyin socket orqali qo'shiladi)
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const bots = [];
    for (let i = 0; i < totalPlayers - 1; i++) {
      bots.push({
        socketId: 'bot-' + i, userId: 'bot-' + game.id.slice(0, 4) + '-' + i,
        username: '🤖 ' + (names[i] || ('Bot' + (i + 1))),
        avatar: null, role: null, isAlive: true, connected: true, isHost: false, isBot: true, joinedAt: Date.now()
      });
    }
    const state = {
      ...game, players: bots, phase: 'waiting', roleConfig, vsBots: true,
      dayVotes: {}, nightActions: {}, round: 0, durations: settings.durations, log: []
    };
    await saveG(game.id, state);
    // zaxira: foydalanuvchi 60s ichida kirmasa (boshlanmasa) o'chiramiz
    botDeleteTimers.set(game.id, setTimeout(async () => {
      botDeleteTimers.delete(game.id);
      const cur = await getG(game.id).catch(() => null);
      if (cur && cur.status === 'waiting') {
        await redis.del(`game:${game.id}`, `chat:${game.id}`).catch(() => {});
        await prisma.game.delete({ where: { id: game.id } }).catch(() => {});
      }
    }, 60000));
    res.json({ id: game.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// foydalanuvchining o'z xonalari (yopiqlar ham ko'rinadi)
app.get('/api/my-games', authMiddleware, async (req, res) => {
  try {
    const games = await prisma.game.findMany({
      where: { hostId: req.user.userId, status: { in: ['waiting', 'playing'] } },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = await Promise.all(games.map(async g => {
      const raw = await redis.get(`game:${g.id}`);
      const state = raw ? JSON.parse(raw) : null;
      if (!state && g.status === 'playing') return null;
      return {
        id: g.id, name: g.name, status: g.status, isPrivate: g.isPrivate,
        totalPlayers: g.totalPlayers, mafiaCount: g.mafiaCount,
        sheriffCount: g.sheriffCount, doctorCount: g.doctorCount, civilCount: g.civilCount,
        hostId: g.hostId, createdAt: g.createdAt,
        phase: state?.phase || 'waiting',
        players: (state?.players || []).map(p => ({ userId: p.userId, username: p.username, isAlive: p.isAlive }))
      };
    }));
    res.json(enriched.filter(Boolean));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// foydalanuvchi FAQAT o'z xonasini o'chira oladi
app.delete('/api/games/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Xona topilmadi' });
    if (game.hostId !== req.user.userId) return res.status(403).json({ error: 'Faqat o\'z xonangizni o\'chira olasiz' });
    io.to(`game:${id}`).emit('game_closed', { code: 'hostClosed', message: 'Xona egasi xonani yopdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    // guruhdagi e'lonni "o'chirildi" holatiga keltiramiz (redis o'chishidan OLDIN o'qiymiz)
    const hostG = await getG(id);
    tgRoomCancel(id, hostG, 'xona egasi yopdi').catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    await prisma.game.delete({ where: { id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const g = await getG(req.params.id);
    if (!g) return res.status(404).json({ error: 'Xona topilmadi yoki tugagan' });
    res.json(publicGame(g));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== AVATAR RASMLARI ====================
// Xonani to'ldiruvchi o'yinchilarning profil rasmi. Avatar SVG sifatida
// generatsiya qilinadi (identicon uslubi) va BIR YIL keshlanadi — brauzer
// uni bir marta oladi.
//
// Nega data URI emas: u ~1.5 KB va har `game_state` xabari bilan qayta-qayta
// ketardi. Nega tashqi xizmat emas: CSP'ga yangi manba kerak bo'lardi va
// o'sha xizmat o'chsa avatarlar yo'qolardi.
//
// Auth talab qilinmaydi: rasm maxfiy emas, va `<img>` tegi sarlavha yubormaydi.
app.get('/api/avatar/:seed', (req, res) => {
  const seed = String(req.params.seed || '').slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
  if (!seed) return res.status(400).end();
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(botAvatar(seed));
});

// ==================== ICE SERVERLAR (ovozli chat) ====================
// TURN sirlari serverda turadi; frontend shu endpointdan oladi.
// Cloudflare TURN ulash uchun .env ga: CF_TURN_KEY_ID va CF_TURN_API_TOKEN
const ICE_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
let iceCache = { at: 0, servers: null };
// TURN credentiallari pullik resurs — faqat tizimga kirgan foydalanuvchiga beriladi
// (ilgari ochiq edi va istalgan odam relay sifatida ishlata olardi)
// --- O'Z TURN serverimiz (coturn, `use-auth-secret` rejimi) ---
// TURN NIMA UCHUN KERAK: STUN faqat NAT ni "teshish" mumkin bo'lganda yordam beradi.
// Simmetrik NAT va CGNAT ortida (mobil operatorlar — O'zbekistonda odatiy hol)
// to'g'ridan-to'g'ri kanal QURILMAYDI va ovoz umuman ulanmaydi. TURN bunday
// juftlikda trafikni server orqali uzatadi.
//
// Credential VAQTINCHALIK: coturn REST API sxemasi bo'yicha
//   username = <tugash vaqti unix>:<userId>,  password = base64(HMAC-SHA1(sir, username))
// Sir faqat serverda va coturn'da turadi, mijozga chiqmaydi. Shu sababli
// o'g'irlangan credential 12 soatdan keyin o'zi o'ladi va kim olganini bilib
// olish mumkin (username ichida userId bor).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_TTL = parseInt(process.env.TURN_TTL || '43200');   // 12 soat
function coturnServers(userId) {
  if (!TURN_SECRET || !TURN_HOST) return null;
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${userId || 'anon'}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: `turn:${TURN_HOST}:3478?transport=udp`, username, credential },
    { urls: `turn:${TURN_HOST}:3478?transport=tcp`, username, credential },
    // 5349/TLS — faqat TCP/443 chiqadigan qattiq tarmoqlar uchun zaxira yo'l
    { urls: `turns:${TURN_HOST}:5349?transport=tcp`, username, credential },
  ];
}

app.get('/api/ice', authMiddleware, limitByUser(30), async (req, res) => {
  try {
    // 1) O'z coturn'imiz bo'lsa — birinchi navbatda u (tashqi xizmatga bog'liq emas)
    const own = coturnServers(req.user?.userId);
    if (own) return res.json({ iceServers: [...ICE_STUN, ...own] });

    // 2) Aks holda Cloudflare TURN (agar kalitlar berilgan bo'lsa)
    const keyId = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN;
    if (!keyId || !token) return res.json({ iceServers: ICE_STUN });
    // Cloudflare vaqtinchalik credential beradi (ttl 24h) — 6 soat keshda ushlaymiz
    if (iceCache.servers && Date.now() - iceCache.at < 6 * 3600 * 1000) return res.json({ iceServers: iceCache.servers });
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) throw new Error(`CF TURN ${r.status}`);
    const d = await r.json();
    const turn = Array.isArray(d.iceServers) ? d.iceServers : (d.iceServers ? [d.iceServers] : []);
    iceCache = { at: Date.now(), servers: [...ICE_STUN, ...turn] };
    res.json({ iceServers: iceCache.servers });
  } catch (e) {
    console.error('ICE/TURN xato:', e.message);
    res.json({ iceServers: ICE_STUN });
  }
});

// ==================== ADMIN ROUTES ====================

// 🟢 hozir saytda turgan qurilmalar soni (auth qilgan / qilmagan alohida)
app.get('/api/admin/live', authMiddleware, adminMiddleware, async (_, res) => {
  try {
    const cut = Date.now() - 30000; // oxirgi 30s ichida "ko'ringan" qurilmalar = onlayn
    await redis.zremrangebyscore('presence:auth', '-inf', cut).catch(() => {});
    await redis.zremrangebyscore('presence:anon', '-inf', cut).catch(() => {});
    const [authed, anon] = await Promise.all([
      redis.zcard('presence:auth').catch(() => 0),
      redis.zcard('presence:anon').catch(() => 0),
    ]);
    res.json({ authed, anon, total: authed + anon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (_, res) => {
  try {
    const [users, banned, admins, totalGames, activeGames, finishedGames] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { isAdmin: true } }),
      prisma.game.count(),
      prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } }),
      prisma.game.count({ where: { status: 'finished' } }),
    ]);
    const mafiaWins = await prisma.game.count({ where: { winner: 'mafia' } });
    const civilWins = await prisma.game.count({ where: { winner: 'civil' } });

    // Qayerdan kelgan: ro'yxatdan o'tishda yozilgan refSource bo'yicha
    const bySource = await prisma.user.groupBy({ by: ['refSource'], _count: { _all: true } });
    const sources = {};
    for (const row of bySource) sources[row.refSource || 'direct'] = row._count._all;
    // Botni ochgan unikal Telegram foydalanuvchilari (saytga o'tmaganlar ham kiradi)
    const tgStarted = await redis.scard('tg:started').catch(() => 0);
    // Oxirgi 7 kunda bot orqali kelganlar
    const weekAgo = new Date(Date.now() - 7 * 864e5);
    const tgbotWeek = await prisma.user.count({ where: { refSource: 'tgbot', createdAt: { gte: weekAgo } } });

    res.json({
      users, banned, admins, totalGames, activeGames, finishedGames, mafiaWins, civilWins,
      sources, tgStarted, tgbotWeek,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 20));
    const q = String(req.query.q || '').trim();
    const where = q ? { OR: [{ username: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {};

    const total = await prisma.user.count({ where });
    const users = await prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit, take: limit,
      include: { stats: true }
    });
    const settings = await getSettings();
    const defaultRoomLimit = settings.dailyRoomLimit || 2;
    const overrides = (await redis.hgetall('roomlimits').catch(() => ({}))) || {};
    res.json({
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      users: users.map(u => ({
        id: u.id, username: u.username, email: u.email,
        avatar: u.avatar || null,
        isAdmin: u.isAdmin, isBanned: u.isBanned,
        createdAt: u.createdAt, lastSeen: u.lastSeen,
        items: normItems(u.items),
        coins: u.coins ?? 0,
        roomLimit: overrides[u.id] != null ? parseInt(overrides[u.id]) : null, // null = default ishlatiladi
        defaultRoomLimit,
        stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: RATING_START, xp: 0 }
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const updated = await prisma.user.update({ where: { id: u.id }, data: { isBanned: !u.isBanned } });
    await setBanned(u.id, updated.isBanned);
    // ban darhol kuchga kirsin — ochiq sessiyalarni uzamiz
    if (updated.isBanned) kickUserSockets(u.id, 'Hisobingiz bloklandi');
    res.json({ id: updated.id, isBanned: updated.isBanned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/admin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const updated = await prisma.user.update({ where: { id: u.id }, data: { isAdmin: !u.isAdmin } });
    res.json({ id: updated.id, isAdmin: updated.isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// admin foydalanuvchiga shaxsiy kunlik xona limitini belgilaydi: { limit }
// limit null/bo'sh bo'lsa — override o'chiriladi (umumiy default ishlatiladi)
app.post('/api/admin/users/:id/room-limit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const { limit } = req.body;
    if (limit === null || limit === undefined || limit === '') {
      await redis.hdel('roomlimits', u.id);
      return res.json({ id: u.id, roomLimit: null });
    }
    const n = parseInt(limit);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'Limit 0–1000 oralig\'ida bo\'lishi kerak' });
    await redis.hset('roomlimits', u.id, String(n));
    res.json({ id: u.id, roomLimit: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// admin foydalanuvchiga buyum beradi/oladi: { item, qty }  (qty manfiy bo'lishi mumkin)
app.post('/api/admin/users/:id/give', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { item, qty } = req.body;
    if (!ITEM_KEYS.includes(item)) return res.status(400).json({ error: 'Noma\'lum buyum' });
    const n = parseInt(qty);
    if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: 'Miqdor noto\'g\'ri' });
    const items = await adjustUserItems(req.params.id, { [item]: n });
    if (!items) return res.status(404).json({ error: 'Topilmadi' });
    await logActivity(req.params.id, 'admin_grant', { item, amount: n, detail: `Admin ${n > 0 ? 'berdi' : 'oldi'}: ${item} ${Math.abs(n)}` });
    res.json({ id: req.params.id, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 👤 bitta foydalanuvchining TO'LIQ ma'lumoti (admin batafsil sahifasi)
app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id }, include: { stats: true } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const [activities, history] = await Promise.all([
      prisma.activity.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.gameHistory.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    // qisqa xulosa: item bo'yicha sotib olish/ishlatish/admin, tanga kirim/chiqim
    const summary = {
      coinsEarned: 0, coinsSpent: 0,
      bought: { shield: 0, lupa: 0, life: 0 },
      used: { shield: 0, lupa: 0, life: 0 },
      granted: { shield: 0, lupa: 0, life: 0 },
    };
    for (const a of activities) {
      if (a.amount > 0 && (a.type === 'coin_earn' || a.type === 'coin_bonus')) summary.coinsEarned += a.amount;
      if (a.type === 'shop_buy') { summary.coinsSpent += Math.abs(a.amount); if (a.item && summary.bought[a.item] != null) summary.bought[a.item]++; }
      if (a.type === 'item_use' && a.item && summary.used[a.item] != null) summary.used[a.item]++;
      if (a.type === 'admin_grant' && a.item && summary.granted[a.item] != null) summary.granted[a.item] += a.amount;
    }
    const overrides = (await redis.hgetall('roomlimits').catch(() => ({}))) || {};
    res.json({
      id: u.id, username: u.username, email: u.email, avatar: u.avatar || null,
      isAdmin: u.isAdmin, isBanned: u.isBanned, createdAt: u.createdAt, lastSeen: u.lastSeen,
      coins: u.coins ?? 0, lastBonusAt: u.lastBonusAt,
      items: normItems(u.items),
      roomLimit: overrides[u.id] != null ? parseInt(overrides[u.id]) : null,
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: RATING_START, xp: 0 },
      summary,
      activities: activities.map(a => ({ type: a.type, item: a.item, amount: a.amount, detail: a.detail, gameId: a.gameId, createdAt: a.createdAt })),
      history: history.map(h => ({ role: h.role, won: h.won, winner: h.winner, coins: h.coins, createdAt: h.createdAt })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'O\'zingizni o\'chira olmaysiz' });
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/games', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 20));
    const statusFilter = ['waiting', 'playing', 'finished'].includes(req.query.status) ? req.query.status : null;
    const where = statusFilter ? { status: statusFilter } : {};

    const total = await prisma.game.count({ where });
    const games = await prisma.game.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit });
    const enriched = await Promise.all(games.map(async g => {
      const raw = await redis.get(`game:${g.id}`);
      const state = raw ? JSON.parse(raw) : null;
      return {
        id: g.id, name: g.name, status: g.status, winner: g.winner,
        totalPlayers: g.totalPlayers, createdAt: g.createdAt, startedAt: g.startedAt, endedAt: g.endedAt,
        hasState: !!state, livePlayers: state?.players?.length || 0, phase: state?.phase || null
      };
    }));
    res.json({ total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), games: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// xonani majburan to'xtatish
app.post('/api/admin/games/:id/stop', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.game.update({ where: { id }, data: { status: 'finished', endedAt: new Date() } }).catch(() => {});
    io.to(`game:${id}`).emit('game_closed', { code: 'adminStopped', message: 'Admin tomonidan xona yopildi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    // guruhdagi e'lonni olib tashlaymiz (redis o'chishidan OLDIN o'qiymiz)
    const stopG = await getG(id);
    tgRoomCancel(id, stopG, 'admin xonani yopdi').catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// xonani butunlay o'chirish
app.delete('/api/admin/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    io.to(`game:${id}`).emit('game_closed', { code: 'adminDeleted', message: 'Admin xonani o\'chirdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    const delG = await getG(id);
    tgRoomCancel(id, delG, "admin xonani o'chirdi").catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    await prisma.game.delete({ where: { id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// eskirgan/stale xonalarni tozalash (redis holati yo'q bo'lganlarni tugatish)
app.post('/api/admin/cleanup', authMiddleware, adminMiddleware, async (_, res) => {
  try {
    const games = await prisma.game.findMany({ where: { status: { in: ['waiting', 'playing'] } } });
    let cleaned = 0;
    for (const g of games) {
      const raw = await redis.get(`game:${g.id}`);
      if (!raw) {
        await prisma.game.update({ where: { id: g.id }, data: { status: 'finished', endedAt: new Date() } });
        cleaned++;
      }
    }
    res.json({ cleaned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', authMiddleware, adminMiddleware, async (_, res) => {
  res.json(await getSettings());
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cur = await getSettings();
    const next = {
      ...cur,
      ...req.body,
      durations: { ...cur.durations, ...(req.body.durations || {}) },
      defaultRoles: { ...cur.defaultRoles, ...(req.body.defaultRoles || {}) },
    };
    await saveSettings(next);
    res.json(next);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== GAME ENGINE ====================

const timers = new Map();

// ==================== BO'SH XONA AVTO-O'CHIRISH ====================
// Xona yaratilgach yoki barcha o'yinchilar chiqib ketib 0 ga tushganda 2 daqiqa kutiladi.
// Shu vaqt ichida hech kim kirmasa — xona o'chiriladi. Hatto 1 kishi kirsa — bekor qilinadi.
const EMPTY_ROOM_MS = 120000;
const emptyTimers = new Map();
function scheduleEmptyCheck(gameId) {
  if (emptyTimers.has(gameId)) clearTimeout(emptyTimers.get(gameId));
  emptyTimers.set(gameId, setTimeout(() => withLock(gameId, () => deleteIfEmpty(gameId)), EMPTY_ROOM_MS));
}
function cancelEmptyCheck(gameId) {
  if (emptyTimers.has(gameId)) { clearTimeout(emptyTimers.get(gameId)); emptyTimers.delete(gameId); }
}
// ==================== TASHLAB KETILGAN O'YIN ====================
// Ketayotgan o'yinda BARCHA odamlar uzilib qolsa, taymerlar bo'yicha o'yin o'z-o'zidan
// aylanaverib server resursini yeydi. 3 daqiqa ichida hech kim qaytmasa — yopamiz.
const ABANDON_MS = 180000;
const abandonTimers = new Map();
function cancelAbandonCheck(gameId) {
  if (abandonTimers.has(gameId)) { clearTimeout(abandonTimers.get(gameId)); abandonTimers.delete(gameId); }
}
function scheduleAbandonCheck(gameId) {
  cancelAbandonCheck(gameId);
  abandonTimers.set(gameId, setTimeout(() => withLock(gameId, async () => {
    abandonTimers.delete(gameId);
    const g = await getG(gameId);
    if (!g || g.status !== 'playing') return;
    if (g.players.some(p => !p.isBot && p.connected !== false)) return; // kimdir qaytib keldi
    if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
    io.to(`game:${gameId}`).emit('game_closed', { code: 'abandoned', message: 'O\'yinchilar uzilib qolgani uchun o\'yin yopildi' });
    await prisma.game.update({ where: { id: gameId }, data: { status: 'finished', endedAt: new Date() } }).catch(() => {});
    tgRoomCancel(gameId, g, 'barcha o\'yinchilar uzilib qoldi').catch(() => {});
    await redis.del(`game:${gameId}`, `chat:${gameId}`).catch(() => {});
  }), ABANDON_MS));
}

async function deleteIfEmpty(gameId) {
  emptyTimers.delete(gameId);
  cancelBotJoins(gameId);
  const g = await getG(gameId);
  if (!g) return;
  // faqat hali boshlanmagan (waiting) va HAQIQIY odam yo'q xonalar o'chiriladi.
  // Botlar hisoblanmaydi: aks holda to'ldiruvchi botlar bor xona hech qachon
  // o'chmasdi va lobbi tashlab ketilgan xonalar bilan to'lib ketardi.
  // Botlarning o'zaro o'yini ATAYLAB odamsiz: uni o'chirib yubormaymiz,
  // aks holda botlar to'lgunicha xona yopilib ketardi.
  if (g.botOnly && g.status === 'waiting') return;
  const humansInRoom = (g.players || []).filter(p => !isBot(p)).length;
  if (g.status === 'waiting' && humansInRoom === 0) {
    if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
    io.to(`game:${gameId}`).emit('game_closed', { code: 'emptyRoom', message: 'Xona bo\'sh qolgani uchun yopildi' });
    tgRoomCancel(gameId, g, 'hech kim kirmagani uchun avtomatik yopildi').catch(() => {});
    await redis.del(`game:${gameId}`, `chat:${gameId}`).catch(() => {});
    await prisma.game.delete({ where: { id: gameId } }).catch(() => {});
  }
}

// ==================== PER-GAME LOCK ====================
// Bir xona holatini bir vaqtda o'zgartirishdan saqlaydi (race condition oldini oladi)
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  const tail = next.catch(() => {});
  chains.set(key, tail);
  // Zanjir tugagach va yangi ish qo'shilmagan bo'lsa kalitni o'chiramiz —
  // aks holda Map har bir o'yin/foydalanuvchi uchun abadiy o'sib borardi.
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

// light=true — avatarsiz (phase_change juda tez-tez ketadi; 20 ta base64 avatar
// har fazada qayta yuborilsa bu megabaytlab ortiqcha trafik). Mijoz avatarni
// game_state dan bir marta oladi va o'zida saqlaydi.
// DIQQAT: `isBot` mijozga YUBORILMAYDI va bot userId'i maskalanadi.
// Xonani to'ldiruvchi botlar oddiy o'yinchi sifatida ko'rinishi kerak —
// aks holda "sayt jonli" taassuroti buziladi. Server ichida `p.isBot`
// o'z joyida qoladi (o'yin mantig'i shunga tayanadi).
function publicPlayers(players, { light = false } = {}) {
  return players.map(p => {
    const o = {
      socketId: p.socketId,
      userId: p.publicId || p.userId,
      username: p.username,
      isAlive: p.isAlive,
      connected: p.connected !== false,
      isHost: p.isHost === true,
      role: p.isAlive ? null : p.role,
    };
    if (!light) o.avatar = p.avatar || null;
    return o;
  });
}

// O'yin tugagach barcha rollar ochiladi — lekin faqat ko'rsatish uchun kerakli
// maydonlar (items/roleData/shieldActive kabi ichki holat yuborilmaydi).
// O'yin tugagach hamma rol ochiladi. `isBot` bu yerda ham yuborilmaydi:
// natija jadvalida "bot" ustuni chiqsa, butun o'yin soxta ekani bilinadi.
function revealPlayers(players) {
  return (players || []).map(p => ({
    socketId: p.socketId,
    userId: p.publicId || p.userId,
    username: p.username,
    avatar: p.avatar || null,
    isAlive: p.isAlive,
    isHost: p.isHost === true,
    role: p.role,
    team: sideOf(p.role),
  }));
}

// Mijozga yuboriladigan XAVFSIZ o'yin holati.
// `{ ...g }` ni to'g'ridan-to'g'ri yuborish mumkin emas: nightActions ichida
// mafiya socketId'lari (mafiaVotes), nightCheck ichida komissar tekshiruvi turadi —
// ular fosh bo'lsa o'yinning butun siri yo'qoladi. Shu sababli faqat oq ro'yxat.
function publicGame(g) {
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    status: g.status,
    hostId: g.hostId,
    isPrivate: g.isPrivate,
    vsBots: g.vsBots === true,
    totalPlayers: g.totalPlayers,
    maxPlayers: g.maxPlayers,
    minPlayers: g.minPlayers,
    mafiaCount: g.mafiaCount,
    sheriffCount: g.sheriffCount,
    doctorCount: g.doctorCount,
    civilCount: g.civilCount,
    phase: g.phase,
    phaseEndsAt: g.phaseEndsAt,
    round: g.round || 0,
    nightPresent: g.nightPresent,
    roleSetup: g.roleSetup || null,   // qaysi rollar o'yinda (ochiq ma'lumot)
    winner: g.status === 'finished' ? g.winner : null,
    createdAt: g.createdAt,
    startedAt: g.startedAt,
    log: g.log || [],
    players: publicPlayers(g.players || []),
  };
}

// Qayta ulangan o'yinchiga uning KO'RISHGA HAQLI xabarlarini qaytaramiz.
// public — hammaga; mafia — faqat mafiya tomoniga; dead — faqat o'liklarga.
async function sendChatHistory(socket, gameId, player) {
  try {
    const raw = await redis.lrange(`chat:${gameId}`, -150, -1);
    if (!raw?.length) return;
    const mafia = sideOf(player.role) === 'mafia';
    const dead = player.isAlive === false;
    const messages = raw.map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(m => m && (m.channel === 'public' || (m.channel === 'mafia' && mafia) || (m.channel === 'dead' && dead)));
    if (messages.length) socket.emit('chat_history', { messages });
  } catch {}
}

// Reconnect'da o'yinchining socketId'i o'zgaradi. Ovozlar va tungi harakatlar esa
// socketId bo'yicha saqlanadi — ko'chirmasak, eski ovoz "arvoh" bo'lib qoladi va
// o'yinchi IKKI ovozga ega bo'ladi (yoki mafiya konsensusi hech qachon yig'ilmaydi).
function remapSocketId(g, oldSid, newSid) {
  if (!oldSid || !newSid || oldSid === newSid) return;
  const move = (obj) => {
    if (!obj) return;
    if (obj[oldSid] !== undefined) { obj[newSid] = obj[oldSid]; delete obj[oldSid]; }
    for (const k of Object.keys(obj)) if (obj[k] === oldSid) obj[k] = newSid;
  };
  move(g.dayVotes);
  if (g.revenge) {   // 🧞‍♂️ Afsungar reconnect qilsa qasos huquqi yo'qolmasin
    if (g.revenge.by === oldSid) g.revenge.by = newSid;
    if (g.revenge.target === oldSid) g.revenge.target = newSid;
  }
  const na = g.nightActions;
  if (na) {
    move(na.mafiaVotes);
    for (const key of ['komissar', 'doctor', 'escort', 'lawyer', 'killer', 'daydi', 'afsungar']) {
      const a = na[key];
      if (!a) continue;
      if (a.by === oldSid) a.by = newSid;
      if (a.target === oldSid) a.target = newSid;
    }
  }
  if (g.lastWordSid === oldSid) g.lastWordSid = newSid;
  // Daydi guvohligi kunduzi yetkaziladi — socketId ko'chirilmasa jimgina yo'qolardi
  if (g.nightWitness && g.nightWitness.to === oldSid) g.nightWitness.to = newSid;
}

// Qayta ulangan o'yinchiga UNGA TEGISHLI kutilayotgan harakatni qaytaramiz.
// Busiz sahifani yangilagan Afsungar qasos ola olmasdi, chiqarilgan o'yinchi esa
// oxirgi so'zini yoza olmasdi — server huquqni saqlab turgan bo'lsa ham.
function resendPending(socket, g) {
  if (g.phase !== 'day_results') return;
  if (g.revenge && g.revenge.by === socket.id && !g.revenge.target) {
    socket.emit('your_revenge', {
      targets: g.players.filter(x => x.isAlive && x.socketId !== socket.id)
        .map(x => ({ socketId: x.socketId, username: x.username })),
    });
  }
  if (g.lastWordSid === socket.id) socket.emit('your_last_word', {});
}


// 👮 Serjant — Komissar o'lgan bo'lsa uning o'rnini egallaydi.
// Komissar TUNDA ham, KUNDUZI ovoz bilan ham o'lishi mumkin — shuning uchun
// ikkala yakunda ham chaqiriladi (ilgari faqat tunda ishlagan).
function promoteSergeant(g) {
  if (g.players.some(p => p.isAlive && p.role === 'komissar')) return;
  const sgt = g.players.find(p => p.isAlive && p.role === 'sergeant');
  if (!sgt) return;
  sgt.role = 'komissar';
  sgt.roleData = sgt.roleData || {};
  logSecret(g, '👮🏻‍♂️', `Serjant ${sgt.username} Komissar bo'ldi`, 'sergeantPromoted', { name: sgt.username });
  io.to(sgt.socketId).emit('your_role', { role: 'komissar', promoted: true });
}

// Mafiya tarkibi o'zgarishi mumkin (Bo'ri mafiyaga aylanadi, do'st bot o'rnini egallaydi,
// reconnect'da socketId yangilanadi) — shuning uchun jamoani bitta joydan sinxronlaymiz.
function syncMafiaTeam(g) {
  const mates = g.players
    .filter(p => sideOf(p.role) === 'mafia')
    .map(p => ({ socketId: p.socketId, username: p.username, role: p.role, isAlive: p.isAlive !== false }));
  for (const m of g.players) {
    if (m.isBot === true || sideOf(m.role) !== 'mafia' || m.connected === false) continue;
    io.to(m.socketId).emit('mafia_team', { mates });
  }
}

// Tunda o'ldirilgan o'yinchini bot tarixiga yozadi: o'ldirilgan odam MAFIYA
// EMAS (mafiya o'zini o'ldirmaydi), shuning uchun unga ovoz berganlar shubha
// tortadi. `deaths` ro'yxati tungi natija hisoblangach chaqiriladi.
function botEventDeaths(g, deaths) {
  for (const d of deaths || []) {
    const sid = d?.sid || d;
    if (sid) botEvent(g, { type: 'killed', round: g.round || 0, target: sid });
  }
}

// ==================== BOT UCHUN O'YIN TARIXI ====================
// Botlar qaror qabul qilish uchun "kim kimga ovoz berdi, chetlatilgan odam
// aslida kim edi" ma'lumotiga tayanadi (bot-ai.js dagi buildSuspicion).
// Bu OCHIQ ma'lumot — botga o'yinchilar bilmagan narsa berilmaydi.
const BOT_EVENTS_MAX = 300;
function botEvent(g, ev) {
  if (!g.botEvents) g.botEvents = [];
  g.botEvents.push(ev);
  if (g.botEvents.length > BOT_EVENTS_MAX) g.botEvents.shift();
}

// OCHIQ voqealar jurnali — o'yin davomida hammaga ko'rinadi.
// Bu yerga faqat shahar baribir biladigan narsalar yoziladi (o'limlar, ovoz natijasi).
// `code` + `args` — mijoz matnni O'Z TILIDA yig'adi (game.log.<code>).
// `text` zaxira bo'lib qoladi: eski mijoz yoki lug'atda kalit yo'q bo'lsa ishlatiladi.
// Rol/sabab args'ga KALIT sifatida tushadi (masalan role: 'komissar'), tayyor matn emas —
// aks holda ru/en interfeysda o'zbekcha nom qolib ketardi.
function logEvent(g, icon, text, code, args) {
  if (!g.log) g.log = [];
  g.log.push({ round: g.round || 0, icon, text, code, args, t: Date.now() });
  if (g.log.length > 120) g.log.shift();
}

// MAXFIY jurnal — o'yin TUGAGANDAN keyingina ochiladi.
// "Doktor X nikiga bordi", "Kezuvchi Y ni band qildi", "Serjant Komissar bo'ldi" kabi
// yozuvlar ochiq jurnalga tushsa, rollar bir kechada fosh bo'lib o'yin ma'nosini yo'qotardi.
function logSecret(g, icon, text, code, args) {
  if (!g.secretLog) g.secretLog = [];
  g.secretLog.push({ round: g.round || 0, icon, text, code, args, t: Date.now(), secret: true });
  if (g.secretLog.length > 160) g.secretLog.shift();
}

// o'yin oxirida ikkala jurnal vaqt bo'yicha birlashtiriladi
function fullLog(g) {
  return [...(g.log || []), ...(g.secretLog || [])].sort((a, b) => (a.t || 0) - (b.t || 0));
}

// ==================== BUYUMLAR (ITEMS) ====================
// shield = qalqon (kechasi mafiyadan himoya), lupa = rolni bilish, life = qo'shimcha jon
const ITEM_KEYS = ['shield', 'lupa', 'life'];
const DEFAULT_ITEMS = { shield: 1, lupa: 1, life: 1 }; // yangi user ozginadan oladi

// 🪙 Tanga iqtisodi (do'kon narxlari, mukofotlar, kunlik bonus)
const ECONOMY = {
  winReward: 50,
  loseReward: 15,
  dailyBonus: 30,
  prices: { shield: 60, lupa: 50, life: 100 },
};
function normItems(it) {
  const out = { shield: 0, lupa: 0, life: 0 };
  if (it) for (const k of ITEM_KEYS) out[k] = Math.max(0, parseInt(it[k]) || 0);
  return out;
}
// foydalanuvchi faoliyatini jurnalga yozadi (admin batafsil sahifasi uchun)
async function logActivity(userId, type, data = {}) {
  if (!isRealUser(userId)) return;
  try {
    await prisma.activity.create({
      data: { userId, type, item: data.item || null, amount: data.amount || 0, detail: data.detail || null, gameId: data.gameId || null }
    });
  } catch {}
}

// haqiqiy (DB'dagi) foydalanuvchimi? guest va bot — yo'q
function isRealUser(userId) {
  return userId && !String(userId).startsWith('guest-') && !String(userId).startsWith('bot-');
}
async function loadUserItems(userId) {
  if (!isRealUser(userId)) return { shield: 0, lupa: 0, life: 0 };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { items: true } }).catch(() => null);
  return normItems(u?.items);
}
// items — JSON ustun, ya'ni o'qib-o'zgartirib-yozish kerak. Bu atomik emas:
// ikkita parallel so'rov bir xil eski qiymatni o'qib, biri ikkinchisini bosib ketardi
// (2 ta qalqon ishlatilsa faqat bittasi ayirilardi). Shuning uchun foydalanuvchi
// bo'yicha navbatga qo'yamiz.
async function adjustUserItems(userId, deltas) {
  if (!isRealUser(userId)) return null;
  return withLock(`user:${userId}`, async () => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { items: true } }).catch(() => null);
    if (!u) return null;
    const items = normItems(u.items);
    for (const [k, v] of Object.entries(deltas)) if (ITEM_KEYS.includes(k)) items[k] = Math.max(0, (items[k] || 0) + v);
    await prisma.user.update({ where: { id: userId }, data: { items } }).catch(() => {});
    return items;
  });
}


function dur(g, phase) {
  return (g.durations && g.durations[phase]) || DEFAULT_SETTINGS.durations[phase];
}


async function startPhase(gameId, phase) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;

  const d = dur(g, phase);
  const endsAt = Date.now() + d * 1000;
  g.phase = phase;
  g.phaseEndsAt = endsAt;

  if (phase === 'day_discussion') {
    g.dayVotes = {};
    g.round = (g.round || 0) + 1;
    g.status = 'playing';
  } else if (phase === 'night') {
    g.nightActions = {};
  }

  await saveG(gameId, g);
  io.to(`game:${gameId}`).emit('phase_change', {
    phase, endsAt, duration: d, round: g.round, players: publicPlayers(g.players, { light: true }), log: g.log
  });

  // kunduz boshlandi — komissarning kechagi tekshiruv natijasini endi yuboramiz
  if (phase === 'day_discussion' && (g.nightCheck || g.nightWitness)) {
    if (g.nightCheck) {
      const recipients = g.players.filter(p => p.isAlive && (p.role === 'komissar' || p.role === 'sergeant'));
      for (const r of recipients) io.to(r.socketId).emit('sheriff_result', g.nightCheck);
      delete g.nightCheck;
    }
    // 🧙‍♂️ Daydi guvohligi — faqat o'ziga
    if (g.nightWitness) {
      const w = g.nightWitness;
      const daydi = g.players.find(p => p.socketId === w.to && p.isAlive);
      if (daydi) io.to(daydi.socketId).emit('witness_result', { host: w.host, killer: w.killer, cause: w.cause, label: w.label });
      delete g.nightWitness;
    }
    await saveG(gameId, g);
  }

  if (timers.has(gameId)) clearTimeout(timers.get(gameId));
  // withLock: taymer va socket hodisasi (oxirgi ovoz) bir vaqtda kelsa, faza ikki marta
  // yakunlanib qolmasin.
  //
  // Qo'shimcha vaqt (grace): o'yinchining harakati taymer nolga yetgan paytda
  // yo'lda bo'lishi mumkin. Mijoz `endsAt` ni ko'rsatadi (taymer halol nolga
  // tushadi), server esa eng sekin ishtirokchining pingi qadar kechroq yopadi
  // — aks holda sekin ulanishli odam har safar harakatsiz qolardi.
  const grace = graceFor(g);
  timers.set(gameId, setTimeout(() => withLock(gameId, () => onPhaseEnd(gameId, phase)), d * 1000 + grace));

  // Kunduzi botlar ovoz beradi — har birining o'z vaqtida (bot-ai.js).
  //
  // DIQQAT: shart ILGARI `g.vsBots` edi, ya'ni faqat "Botlar bilan o'ynash"
  // rejimida ishlardi. Xonani to'ldiruvchi botlar va botlarning o'zaro
  // o'yinlari `vsBots: false` — natijada ular kunduzi UMUMAN ovoz bermasdi
  // va o'yin faqat taymer bilan aylanardi (jonli saytda ko'rilgan:
  // `dayVotes: 0`, hech kim chetlatilmaydi).
  if (phase === 'day_discussion' && (g.players || []).some(isBot)) scheduleBotDay(gameId, g);
}

async function onPhaseEnd(gameId, phase) {
  const g = await getG(gameId);
  if (!g) return;
  // Idempotentlik: taymer va oxirgi ovoz bir vaqtda kelishi mumkin — faza allaqachon
  // almashgan bo'lsa ikkinchi marta yakunlamaymiz (aks holda ikki kishi chiqarilardi).
  if (g.status === 'finished' || g.phase !== phase) return;

  if (phase === 'day_discussion') {
    const counts = {};
    Object.values(g.dayVotes || {}).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    let eliminated = null, maxV = 0, tie = false;
    for (const [id, cnt] of Object.entries(counts)) {
      if (cnt > maxV) { maxV = cnt; eliminated = id; tie = false; }
      else if (cnt === maxV) tie = true;
    }
    if (tie) eliminated = null;
    // "skip" (hech kim) eng ko'p ovoz olgan bo'lsa — hech kim chiqarilmaydi
    const skipped = eliminated === 'skip';
    if (skipped) eliminated = null;

    let msg, result = { eliminated: null, role: null };
    let revengeWindow = false;   // 🧞‍♂️ Afsungar qasos nishonini tanlashi uchun qo'shimcha vaqt
    if (eliminated) {
      const p = g.players.find(p => p.socketId === eliminated || p.userId === eliminated);
      if (p && p.isAlive) {
        if ((p.items?.life || 0) > 0) {
          // qo'shimcha jon — chiqarilishdan saqlaydi
          p.items.life--;
          await adjustUserItems(p.userId, { life: -1 });
          io.to(p.socketId).emit('your_items', { items: p.items });
          msg = `☀️ ${p.username} chiqarilmoqchi edi, lekin qo'shimcha joni bilan omon qoldi!`;
          result = { eliminated: null, role: null, saved: true, reason: 'lifeSaved', name: p.username };
          logEvent(g, '❤️', `${p.username} qo'shimcha jon bilan ovozdan omon qoldi!`, 'lifeSavedVote', { name: p.username });
        } else {
          p.isAlive = false;
          // Botlar uchun eng qimmatli ma'lumot: chetlatilgan odam mafiya edimi.
          // Shundan keyin ular unga ovoz berganlarni boshqacha baholaydi.
          botEvent(g, { type: 'lynched', round: g.round || 0, target: p.socketId, wasMafia: sideOf(p.role) === 'mafia' });
          msg = `☀️ ${p.username} ovoz bilan o'ldirildi — ${roleName(p.role)}`;
          result = { eliminated: p.username, role: p.role, reason: 'votedOut', name: p.username };
          logEvent(g, '⚖️', `${p.username} ovoz bilan chiqarildi — u ${roleName(p.role)} edi`, 'votedOut', { name: p.username, role: p.role });
          // 🗣️ Oxirgi so'z — chiqarilgan o'yinchi day_results davomida bitta ochiq xabar yozadi
          g.lastWordSid = p.socketId;
          io.to(p.socketId).emit('your_last_word', {});
          // 🧞‍♂️ Afsungar ovozda o'ldirilsa — qurbonni O'ZI tanlaydi (ROLES.md).
          // Tanlov day_results davomida beriladi; tanlamasa hech kim o'lmaydi.
          if (p.role === 'afsungar' && g.players.some(x => x.isAlive && x.socketId !== p.socketId)) {
            g.revenge = { by: p.socketId, username: p.username, target: null };
            revengeWindow = true;
            io.to(p.socketId).emit('your_revenge', {
              targets: g.players.filter(x => x.isAlive && x.socketId !== p.socketId)
                .map(x => ({ socketId: x.socketId, username: x.username })),
            });
            msg += ' · 🧞‍♂️ Afsungar qasos olmoqchi...';
            logEvent(g, '🧞‍♂️', `Afsungar ${p.username} qasos nishonini tanlamoqda`, 'revengePicking', { name: p.username });
          }
        }
      }
    } else {
      msg = skipped ? '☀️ Shahar hech kimni chiqarmaslikka qaror qildi'
        : tie ? '☀️ Ovozlar teng — hech kim o\'lmadi'
        : '☀️ Hech kim ovoz bermadi';
      result = { eliminated: null, role: null, reason: skipped ? 'voteSkipped' : tie ? 'voteTie' : 'voteNone' };
      logEvent(g, '🤝', skipped ? 'Ovoz o\'tkazib yuborildi — hech kim chiqarilmadi' : tie ? 'Ovozlar teng — hech kim chiqarilmadi' : 'Hech kim ovoz bermadi', skipped ? 'voteSkipped' : tie ? 'voteTie' : 'voteNone');
    }

    g.dayVotes = {};
    promoteSergeant(g);          // Komissar ovoz bilan chiqarilgan bo'lsa — Serjant o'rnini oladi
    g.phase = 'day_results';
    // Afsungar qasos tanlashi kerak bo'lsa, natija fazasi uzaytiriladi
    const d = revengeWindow ? Math.max(dur(g, 'day_results'), 15) : dur(g, 'day_results');
    g.phaseEndsAt = Date.now() + d * 1000;
    await saveG(gameId, g);

    // Qasos oynasi ochiq bo'lsa g'alabani hali hisoblamaymiz — qasos natijani o'zgartirishi mumkin
    if (!revengeWindow) {
      const winner = checkWin(g);
      if (winner) return endGame(gameId, winner);
    }

    io.to(`game:${gameId}`).emit('phase_change', {
      phase: 'day_results', endsAt: g.phaseEndsAt, duration: d, round: g.round,
      players: publicPlayers(g.players, { light: true }), message: msg, result, log: g.log
    });
    if (timers.has(gameId)) clearTimeout(timers.get(gameId));
    timers.set(gameId, setTimeout(() => withLock(gameId, () => startNight(gameId)), d * 1000));

  } else if (phase === 'night') {
    await processNight(gameId);
  }
}

async function processNight(gameId) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;
  // Bir kecha faqat BIR MARTA hisoblanadi (ikki marta kirish o'limlarni takrorlardi)
  if (g.nightResolvedRound === g.round) return;
  g.nightResolvedRound = g.round;
  const na = g.nightActions || {};
  const find = (sid) => g.players.find(p => p.socketId === sid);
  const nameOf = (sid) => find(sid)?.username || '—';
  const aliveT = (sid) => { const p = find(sid); return p && p.isAlive ? p : null; };

  logEvent(g, '🌙', `${g.round}-kecha tushdi`, 'nightFell', { n: g.round });
  const deaths = []; // {sid, cause}

  // 1) 💃 Kezuvchi bloki (Komissarni bloklay olmaydi)
  const blocked = new Set();
  if (na.escort?.target) {
    const t = find(na.escort.target);
    if (t && t.role !== 'komissar') { blocked.add(t.socketId); logSecret(g, '💃', `Kezuvchi ${t.username}ni band qildi`, 'escortBlocked', { name: t.username }); }
  }
  const notBlocked = (by) => by && !blocked.has(by);

  // 2) 👨‍💼 Advokat himoyasi (mafiyani Komissardan yashiradi)
  const lawyerProtect = (na.lawyer && notBlocked(na.lawyer.by)) ? na.lawyer.target : null;

  // 3) 🤵 Mafiya o'ldirish nishoni — mafialar KELISHISHI shart.
  // Barcha tirik (bloklanmagan) mafiya bir XIL nishonga ovoz bersa — o'sha o'ladi.
  // Kelisha olmasalar (ovozlar bo'linsa) — hech kim o'lmaydi.
  let mafiaKill = null, mafiaKillerSid = null;
  {
    const votes = na.mafiaVotes || {};
    // Tanlov mantiqi rules.js da (sof va testlangan): kelishuv → Don qarori →
    // ko'pchilik → hech kim. Bloklangan/uzilgan mafiya ovozga qatnashmaydi.
    const pick = chooseMafiaTarget(g.players, votes, blocked);
    mafiaKill = pick.target;
    mafiaKillerSid = pick.by;
    const LOG = {
      donDecided: 'Mafiya kelisha olmadi — Don yakuniy qarorni qabul qildi',
      mafiaMajority: 'Mafiya ko\'pchilik ovozi bilan nishon tanladi',
      mafiaNoDeal: 'Mafiya kelisha olmadi — bu kecha hech kimni o\'ldirmadi',
    };
    if (pick.reason) logSecret(g, pick.reason === 'donDecided' ? '🤵🏻' : '🤝', LOG[pick.reason], pick.reason);
  }
  if (mafiaKill) deaths.push({ sid: mafiaKill, cause: 'mafia', by: mafiaKillerSid });

  // 4) 🔪 Qotil o'ldirish
  if (na.killer && notBlocked(na.killer.by)) {
    const t = aliveT(na.killer.target);
    if (t && sideOf(t.role) !== 'killer') deaths.push({ sid: t.socketId, cause: 'killer', by: na.killer.by });
  }

  // 5) 🕵️ Komissar — tekshirish yoki otish
  if (na.komissar && notBlocked(na.komissar.by)) {
    const kom = find(na.komissar.by);
    const t = find(na.komissar.target);
    if (t) {
      if (na.komissar.type === 'shoot') {
        deaths.push({ sid: t.socketId, cause: 'komissar', by: na.komissar.by });
        logSecret(g, '🔫', `Komissar ${t.username}ga o'q uzdi`, 'komissarShot', { name: t.username });
      } else {
        const seenMafia = sideOf(t.role) === 'mafia' && lawyerProtect !== t.socketId;
        if (kom) { kom.roleData = kom.roleData || {}; kom.roleData.checked = true; }
        // Bot komissar natijani XOTIRASIGA yozadi va ertasi kuni shunga
        // qarab ovoz beradi. Busiz u har tuni tekshirib, natijani unutardi.
        if (kom && isBot(kom)) {
          kom.mem = kom.mem || {};
          kom.mem.checked = { ...(kom.mem.checked || {}), [t.socketId]: seenMafia ? 'mafia' : 'town' };
          // Komissar bot natijani BOSHQA botlar uchun ham e'lon qiladi —
          // haqiqiy o'yindagi "ochilish". Bu o'yinning eng muhim mexanikasi:
          // usiz komissar bir ovozli ozchilik bo'lib qoladi va shahar deyarli
          // hech qachon yutmaydi (bot-sim.test.mjs da o'lchangan).
          // `round + 1` — natija ERTASI KUNI ma'lum bo'ladi, hozir emas.
          botEvent(g, {
            type: seenMafia ? 'claim' : 'clear',
            round: (g.round || 0) + 1,
            from: kom.socketId, target: t.socketId,
          });
        }
        // natija KUNDUZI (day_discussion boshlanganda) komissar/serjantga yuboriladi
        g.nightCheck = { username: t.username, isMafia: seenMafia };
        logSecret(g, '🔵', `Komissar ${t.username}ni tekshirdi — ${seenMafia ? 'MAFIYA' : 'tinch'}`, seenMafia ? 'checkMafia' : 'checkTown', { name: t.username });
      }
    }
  }

  // Kecha kimga hujum bo'lganini eslab qolamiz: doktor boti ertasi kuni
  // shu odamni himoya qilishga harakat qiladi (haqiqiy o'yinchi ham shunday).
  g.lastNightTargets = [
    na.killer?.target || null,
    ...Object.values(na.mafiaVotes || {}),
  ].filter(Boolean);

  // 6) 👨🏻‍⚕️ Doktor davolash nishoni
  const healTarget = (na.doctor && notBlocked(na.doctor.by)) ? na.doctor.target : null;
  // O'zini davolash huquqi HAQIQATAN sodir bo'lganda sarflanadi (bloklangan bo'lsa emas)
  if (healTarget && na.doctor.by === healTarget) {
    const doc = find(na.doctor.by);
    if (doc) { doc.roleData = doc.roleData || {}; doc.roleData.selfHeal = true; }
  }
  if (healTarget) logSecret(g, '💚', `Doktor ${nameOf(healTarget)}nikiga bordi`, 'doctorVisited', { name: nameOf(healTarget) });

  // 7) 🧙 Daydi guvohligi
  if (na.daydi && notBlocked(na.daydi.by)) logSecret(g, '🧙‍♂️', `Daydi ${nameOf(na.daydi.target)} oldiga bordi`, 'daydiVisited', { name: nameOf(na.daydi.target) });

  // ===== O'limlarni hal qilamiz =====
  // killed: { name, cause } — tongda "kim kimni o'ldirgani" e'lon qilinadi
  // 🧞‍♂️ Afsungar tunda o'ldirilsa kimni olib ketishini oldindan aniqlaymiz —
  // sof funksiya `by` maydoniga tayanadi, shuning uchun uni to'ldirib beramiz.
  for (const d of deaths) {
    const t = find(d.sid);
    if (!t || t.role !== 'afsungar' || d.by) continue;
    if (d.cause === 'killer') d.by = na.killer?.by || null;
    else if (d.cause === 'komissar') d.by = na.komissar?.by || null;
    else if (d.cause === 'mafia') {
      const don = g.players.find(p => p.isAlive && p.role === 'don')
        || g.players.find(p => p.isAlive && sideOf(p.role) === 'mafia');
      d.by = don?.socketId || null;
    }
  }

  // Qalqon → doktor → qo'shimcha jon → Bo'ri → o'lim → Afsungar qasosi:
  // butun tartib rules.js dagi sof (va testlangan) funksiyada. Bu yerda faqat
  // natijani QO'LLAYMIZ: holat, jurnal, buyum hisobi va socket xabarlari.
  const res = resolveNightDeaths(g.players, deaths, { healTarget });
  // Botlar uchun: tunda o'ldirilgan odam MAFIYA EMAS — unga ovoz berganlar
  // shubha tortadi (bot-ai.js dagi buildSuspicion 4-qoidasi).
  botEventDeaths(g, res.events.filter(e => e.type === 'death'));
  const killed = [], killedNames = [], savedNames = [];

  for (const ev of res.events) {
    const t = find(ev.sid);
    if (!t) continue;
    switch (ev.type) {
      case 'shield':
        savedNames.push(t.username);
        logEvent(g, '🛡️', `${t.username} qalqon bilan omon qoldi`, 'shieldSaved', { name: t.username });
        break;
      case 'heal':
        savedNames.push(t.username);
        logEvent(g, '✅', `${t.username}ga hujum bo'ldi, lekin u omon qoldi`, 'attackSurvived', { name: t.username });
        logSecret(g, '💚', `Doktor ${t.username}ni qutqardi`, 'doctorSaved', { name: t.username });
        break;
      case 'life':
        if (t.items) t.items.life = Math.max(0, (t.items.life || 0) - 1);
        await adjustUserItems(t.userId, { life: -1 });
        io.to(t.socketId).emit('your_items', { items: t.items });
        savedNames.push(t.username);
        logEvent(g, '❤️', `${t.username} qo'shimcha jon bilan tirik qoldi`, 'lifeSaved', { name: t.username });
        break;
      case 'reborn': {
        t.role = ev.role;
        const code = ev.cause === 'mafia' ? 'wolfToMafia' : ev.role === 'sergeant' ? 'wolfToSergeant' : 'wolfToCivil';
        logSecret(g, '🐺', `Bo'ri ${t.username} ${roleName(ev.role)}ga aylandi`, code, { name: t.username });
        io.to(t.socketId).emit('your_role', { role: ev.role, reborn: true });
        break;
      }
      case 'death':
        t.isAlive = false;
        killedNames.push(t.username);
        killed.push({ name: t.username, cause: ev.cause, sid: ev.sid, by: ev.by });
        logEvent(g, '💀', `${killerLabel(ev.cause)} ${t.username}ni o'ldirdi — u ${roleName(ev.role)} edi`,
          'killedBy', { name: t.username, role: ev.role, cause: ev.cause });
        break;
    }
  }

  // 🧙‍♂️ Daydi guvohligi — borgan uyida qotillik bo'lsa, kimning qilganini ko'radi.
  // Natija kunduzi (nightCheck bilan birga) yuboriladi, tunda emas — aks holda
  // xabar kelgan payti Daydi kimligini fosh qilardi.
  if (na.daydi && notBlocked(na.daydi.by)) {
    const daydi = find(na.daydi.by);
    const host = find(na.daydi.target);
    if (daydi && daydi.isAlive && host) {
      const ev = killed.find(k => k.sid === host.socketId);
      // Mafiya JAMOA bo'lib o'ldiradi — `by` faqat javobgar sifatida tanlangan
      // (Don yoki birinchi mafiya). Uning ismini ko'rsatish tasodifiy o'yinchini
      // fosh qilardi, shuning uchun mafiya holatida faqat "Mafiya" yorlig'i beriladi.
      const killerP = ev && ev.by && ev.cause !== 'mafia' ? find(ev.by) : null;
      g.nightWitness = {
        to: daydi.socketId,
        host: host.username,
        killer: killerP ? killerP.username : null,
        cause: ev ? ev.cause : null,
        label: ev ? killerLabel(ev.cause) : null,
      };
    }
  }

  promoteSergeant(g);
  syncMafiaTeam(g);   // Bo'ri mafiyaga aylangan bo'lishi mumkin — jamoani yangilaymiz

  g.players.forEach(p => { p.shieldActive = false; });

  let msg;
  if (killed.length) msg = '🌅 ' + killed.map(k => `${killerLabel(k.cause)} ${k.name}ni o'ldirdi`).join(' · ');
  else if (savedNames.length) msg = '🌅 Hujum bo\'ldi, lekin qutqarildi';
  else { msg = '🌅 Kecha tinch o\'tdi'; logEvent(g, '🕊️', 'Kecha tinch o\'tdi', 'quietNight'); }
  // reason + strukturali ma'lumot — mijoz xabarni O'Z TILIDA yig'adi (msg zaxira bo'lib qoladi)
  const result = {
    killed: killedNames[0] || null, killedAll: killedNames, killedInfo: killed,
    saved: savedNames.length > 0, savedNames,
    reason: killed.length ? 'killed' : savedNames.length ? 'savedNight' : 'quietNight',
  };

  // Holatni night_results ga O'TKAZAMIZ. Busiz Redis'da faza hamon 'night_daydi'
  // bo'lib qolardi va Daydi shu 8 soniyada yana harakat yuborib butun tunni QAYTA
  // hisoblattira olardi (qalqon/qo'shimcha jon bilan omon qolganlar o'lardi).
  g.phase = 'night_results';
  g.nightStep = NIGHT_STEPS.length;
  g.phaseEndsAt = Date.now() + dur(g, 'night_results') * 1000;
  await saveG(gameId, g);
  const winner = checkWin(g);
  if (winner) return endGame(gameId, winner);

  io.to(`game:${gameId}`).emit('phase_change', {
    phase: 'night_results', endsAt: g.phaseEndsAt,
    duration: dur(g, 'night_results'), round: g.round,
    players: publicPlayers(g.players, { light: true }), message: msg, result, log: g.log
  });
  if (timers.has(gameId)) clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(() => withLock(gameId, () => startPhase(gameId, 'day_discussion')), dur(g, 'night_results') * 1000));
}

// ===== Ketma-ket tunni boshlash =====
async function startNight(gameId) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;

  // 🧞‍♂️ Afsungar qasosi: kunduzi chiqarilgan Afsungar tanlagan o'yinchi endi o'ladi.
  // Tanlamagan bo'lsa — hech kim o'lmaydi (tasodifiy qurbon adolatsiz bo'lardi).
  if (g.revenge) {
    const { target, username } = g.revenge;
    delete g.revenge;
    const v = target ? g.players.find(p => p.socketId === target && p.isAlive) : null;
    if (v) {
      // Qo'shimcha jon kunduzgi ovozda ham ishlaydi (ROLES.md) — qasosda ham shunday
      if ((v.items?.life || 0) > 0) {
        v.items.life--;
        await adjustUserItems(v.userId, { life: -1 });
        io.to(v.socketId).emit('your_items', { items: v.items });
        logEvent(g, '❤️', `${v.username} qo'shimcha jon bilan tirik qoldi`, 'lifeSaved', { name: v.username });
        await saveG(gameId, g);
        // qasos "so'ndi" — tun odatdagidek davom etadi
        g.nightActions = {};
        g.nightStep = -1;
        delete g.lastWordSid;
        await saveG(gameId, g);
        return startNightStep(gameId, 0);
      }
      v.isAlive = false;
      logEvent(g, '🧞‍♂️', `Afsungar ${username} qasos oldi — ${v.username} ham o'ldi (${roleName(v.role)})`, 'afsungarRevenge', { name: username, victim: v.username, role: v.role });
      promoteSergeant(g);
      io.to(`game:${gameId}`).emit('phase_change', {
        phase: 'day_results', endsAt: Date.now() + 4000, duration: 4, round: g.round,
        players: publicPlayers(g.players, { light: true }), log: g.log,
        message: `🧞‍♂️ Afsungar ${v.username}ni o'zi bilan olib ketdi!`,
        result: { eliminated: v.username, role: v.role, revenge: true },
      });
    } else {
      logEvent(g, '🧞‍♂️', `Afsungar ${username} qasos olmadi`, 'afsungarNoRevenge', { name: username });
    }
    await saveG(gameId, g);
    const winner = checkWin(g);
    if (winner) return endGame(gameId, winner);
    if (v) { // qasos e'loni ko'rinishi uchun kichik pauza
      if (timers.has(gameId)) clearTimeout(timers.get(gameId));
      timers.set(gameId, setTimeout(() => withLock(gameId, () => startNight(gameId)), 4000));
      return;
    }
  }

  g.nightActions = {};
  g.nightStep = -1;
  delete g.lastWordSid;
  logEvent(g, '🌙', `${g.round}-kecha tushdi — shahar uxlaydi`, 'nightFellSleep', { n: g.round });
  await saveG(gameId, g);
  await startNightStep(gameId, 0);
}

// idx-bosqichni boshlaydi (kerak bo'lsa rolsiz bosqichni qisqa o'tkazadi)
async function startNightStep(gameId, idx) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;
  if (idx >= NIGHT_STEPS.length) return processNight(gameId);

  const step = NIGHT_STEPS[idx];
  const present = stepHasActor(g, step);
  const d = present ? dur(g, step.dur) : (dur(g, 'night_skip') || 3);
  const endsAt = Date.now() + d * 1000;

  g.phase = step.phase;
  g.nightStep = idx;
  g.nightPresent = present;
  g.phaseEndsAt = endsAt;
  await saveG(gameId, g);

  io.to(`game:${gameId}`).emit('phase_change', {
    phase: step.phase, endsAt, duration: d, round: g.round,
    players: publicPlayers(g.players, { light: true }), log: g.log,
    present, stepNoun: step.noun,
  });

  if (timers.has(gameId)) clearTimeout(timers.get(gameId));

  // Xonada bot bo'lsa — ular tungi harakatni bajaradi. Shart ilgari
  // `g.vsBots` edi va to'ldiruvchi botlar kechasi ham harakatsiz qolardi.
  if ((g.players || []).some(isBot)) {
    // Botlar kechikish bilan harakat qiladi (bot-ai.js).
    // Agar bu bosqich roli foydalanuvchida bo'lsa — vaqt chegarasi yo'q (u bajarmaguncha kutamiz).
    const actors = g.players.filter(p => p.isAlive && step.roles.includes(p.role));
    // uzilib qolgan odam aktyor sanalmasin — aks holda uni abadiy kutardik
    const humanActor = present && actors.some(p => !isBot(p) && p.connected !== false);
    if (present) scheduleBotNightStep(gameId, idx);
    // Taymer HAR DOIM qo'yiladi. Ilgari roli odamda bo'lsa taymer umuman qo'yilmasdi va
    // u harakat qilmasa (yoki uzilib qolsa) o'yin abadiy muzlab qolardi.
    const fb = humanActor ? (d * 1000) : (present ? 7000 : d * 1000);
    timers.set(gameId, setTimeout(() => withLock(gameId, () => endNightStep(gameId, idx)), fb));
  } else {
    timers.set(gameId, setTimeout(() => withLock(gameId, () => endNightStep(gameId, idx)), d * 1000));
  }
}

// bosqichni yakunlab keyingisiga o'tadi (vaqt tugaganda yoki rol harakat qilganda)
async function endNightStep(gameId, idx) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;
  if (g.nightStep !== idx) return; // allaqachon o'tib bo'lingan
  if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
  await startNightStep(gameId, idx + 1);
}

// ==================== BOTLAR BILAN O'YIN ====================
const botDeleteTimers = new Map();
// Xonaga qo'shilishni kutayotgan botlarning taymerlari (gameId -> [Timeout])
const botJoinTimers = new Map();

// Botlar xonaga BIRDAN emas, bittalab qo'shiladi: 2-9 soniya oralig'ida.
// Xona egasi "odamlar kelayotganini" ko'radi — bir zumda to'lgan xona
// darhol soxta ekanini bildirardi.
function scheduleBotJoins(gameId, bots) {
  cancelBotJoins(gameId);
  const timers = [];
  let delay = 0;
  for (const bot of bots) {
    delay += 2000 + crypto.randomInt(7000);   // 2-9 s
    timers.push(setTimeout(() => withLock(gameId, async () => {
      const g = await getG(gameId);
      // O'yin boshlangan, xona o'chirilgan yoki to'lgan bo'lsa — qo'shmaymiz.
      // Xona egasi bu botni allaqachon chiqarib yuborgan bo'lishi ham mumkin.
      if (!g || g.status !== 'waiting') return;
      if ((g.players || []).length >= g.totalPlayers) return;
      if (g.players.some(p => p.userId === bot.userId)) return;
      if (g.kicked?.[bot.userId]) return;
      bot.joinedAt = Date.now();
      g.players.push(bot);
      await saveG(gameId, g);
      logEvent(g, '👋', `${bot.username} o'yinga qo'shildi`, 'playerJoined', { name: bot.username });
      io.to(`game:${gameId}`).emit('game_state', publicGame(g));
    }), delay));
  }
  botJoinTimers.set(gameId, timers);
}
function cancelBotJoins(gameId) {
  for (const t of botJoinTimers.get(gameId) || []) clearTimeout(t);
  botJoinTimers.delete(gameId);
}

// ==================== BOTLARNING O'ZARO O'YINLARI ====================
// Sayt faol ko'rinishi uchun kuniga 10-15 marta FAQAT BOTLAR o'ynaydigan
// o'yin o'tkaziladi. Bu soxta xonadan ko'ra ishonchliroq: o'yin haqiqatan
// o'ynaladi (ovoz berish, tungi harakatlar, natija), lobbida jonli "jangda"
// xonasi turadi, Telegram guruhiga e'lon ketadi va "o'ynalgan o'yinlar"
// hisobi haqiqatdan o'sadi.
//
// Statistika buzilmaydi: `isRealUser()` bot userId'ini rad etadi, ya'ni
// reyting jadvaliga ham, o'yin tarixiga ham yozuv tushmaydi.
//
// O'chirish: BOT_GAMES=0
const BOT_GAMES_ON = process.env.BOT_GAMES !== '0' && process.env.BOT_FILL !== '0';
const BOT_GAME_CHECK_MS = 5 * 60 * 1000;   // har 5 daqiqada jadvalni tekshiramiz

async function startBotGame() {
  const settings = await getSettings();
  // Umumiy xona chegarasi bot o'yinlariga ham amal qiladi
  const active = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
  if (active >= (settings.maxRooms || 50)) return null;

  const totalPlayers = 8 + crypto.randomInt(5);          // 8-12 o'yinchi
  const mafiaCount = Math.max(1, Math.round(totalPlayers * 0.3));
  const bots = makeFillerBots('seed' + Date.now().toString(36), totalPlayers, []);
  const host = bots[0];
  host.isHost = true;

  const game = await prisma.game.create({
    data: {
      // Xona nomi o'yinchi yozganday ko'rinadi
      name: `${host.username} xonasi`,
      status: 'waiting', hostId: host.userId, isPrivate: false,
      totalPlayers, maxPlayers: 20, minPlayers: Math.min(5, totalPlayers),
      mafiaCount, sheriffCount: 1, doctorCount: 1,
      civilCount: Math.max(0, totalPlayers - mafiaCount - 2),
    },
  });

  const state = {
    ...game, players: [host], phase: 'waiting', roleConfig: null,
    dayVotes: {}, nightActions: {}, round: 0, durations: settings.durations,
    log: [], botEvents: [], kicked: {},
    botOnly: true,          // odamsiz o'yin: bo'sh xona tekshiruvidan himoyalangan
  };
  await saveG(game.id, state);

  // Qolgan botlar bittalab kiradi (2-9 s), oxirgisidan keyin o'yin boshlanadi
  const rest = bots.slice(1);
  scheduleBotJoins(game.id, rest);
  // Kutish vaqtining yuqori chegarasi: 9 s * bot soni + zaxira
  const startAfter = rest.length * 9000 + 6000;
  setTimeout(() => withLock(game.id, async () => {
    const g = await getG(game.id);
    if (!g || g.status !== 'waiting') return;
    // Odam qo'shilib qolgan bo'lsa ham o'yin boshlanadi — u ham o'ynaydi
    if ((g.players || []).length >= (g.minPlayers || 5)) await beginGame(game.id);
  }), startAfter);

  // Telegram guruhiga e'lon — xuddi odam xona ochgandek
  tgRoomAnnounce(game.id).catch(() => {});
  console.log(`🎲 bot o'yini: ${game.id} (${totalPlayers} o'yinchi, host ${host.username})`);
  return game.id;
}

// Jadval bo'yicha tekshirish. Boshlangan slotlar Redis'da belgilanadi —
// server qayta ishga tushsa ham o'yin ikki marta boshlanmaydi.
async function botGameTick() {
  if (!BOT_GAMES_ON) return;
  try {
    const dayKey = 'botgames:' + new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const done = await redis.smembers(dayKey).catch(() => []);
    const slot = dueBotGameSlot(Date.now(), done.map(Number));
    if (slot < 0) return;
    // Slotni AVVAL band qilamiz: ikkita tekshiruv bir vaqtda kelsa ham
    // o'yin bitta bo'ladi.
    const added = await redis.sadd(dayKey, String(slot)).catch(() => 0);
    if (!added) return;
    await redis.expire(dayKey, 3 * 86400).catch(() => {});
    await startBotGame();
  } catch (e) {
    console.error('botGameTick:', e.message);
  }
}
function isBot(p) { return p && p.isBot === true; }
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7);
function botDelayMs() { return 2000 + Math.floor(Math.random() * 2500); } // 2.0–4.5s
function pickRandom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

// barcha rollardan bittadan (botlar bilan o'ynash) — 11 maxsus + 1 civil = 12 o'yinchi
function allRolesConfig() {
  const cfg = {};
  for (const r of SELECTABLE_ROLES) cfg[r] = 1;
  cfg.civil = 1;
  return cfg;
}

// o'yinni boshlash (start_game va botlar avto-boshlash uchun umumiy)
async function beginGame(gameId) {
  const g = await getG(gameId);
  if (!g || g.status !== 'waiting') return;
  cancelEmptyCheck(gameId);
  cancelBotJoins(gameId);   // qolgan botlar endi qo'shilmaydi
  g.players = assignRoles(g.players, g.roleConfig);
  g.status = 'playing';
  g.round = 0; g.nightActions = {}; g.dayVotes = {}; g.log = []; g.secretLog = [];
  // Qaysi rollar o'yinda ekani HAMMAGA ochiq (klassik mafiyada host e'lon qilganidek).
  // Busiz ham tungi bosqichlarning tezligidan bilinardi — ochiq qilib adolatli qilamiz.
  g.roleSetup = g.players.reduce((acc, p) => { acc[p.role] = (acc[p.role] || 0) + 1; return acc; }, {});
  for (const p of g.players) { p.items = await loadUserItems(p.userId); p.shieldActive = false; }
  logEvent(g, '🎭', 'O\'yin boshlandi — rollar tarqatildi', 'gameStarted');
  await saveG(gameId, g);
  prisma.game.update({ where: { id: gameId }, data: { status: 'playing', startedAt: new Date() } }).catch(() => {});
  tgRoomTouch(gameId); // guruhdagi e'lon: "o'yin boshlandi"
  g.players.forEach(p => {
    if (isBot(p)) return; // botlarga socket xabari yuborilmaydi
    io.to(p.socketId).emit('your_role', { role: p.role });
    io.to(p.socketId).emit('your_items', { items: p.items });
  });
  syncMafiaTeam(g);
  io.to(`game:${gameId}`).emit('game_starting', { roleSetup: g.roleSetup });
  io.to(`game:${gameId}`).emit('game_state', publicGame(g));
  timers.set(gameId, setTimeout(() => withLock(gameId, () => startPhase(gameId, 'day_discussion')), 5000));
}

// tungi bosqichda botlar harakatini rejalashtiradi (2–4.5s kechikish bilan)
function scheduleBotNightStep(gameId, idx) {
  setTimeout(() => withLock(gameId, () => runBotNightStep(gameId, idx)), botDelayMs());
}
// Bot uchun qaror konteksti. Botga FAQAT o'yinchi ko'radigan ma'lumot beriladi
// (ochiq tarix + o'z roli + mafiya sheriklari), shuning uchun u "aldamaydi".
function botCtx(g, bot) {
  const alive = g.players.filter(p => p.isAlive);
  const mates = sideOf(bot.role) === 'mafia'
    ? g.players.filter(p => sideOf(p.role) === 'mafia').map(p => p.socketId)
    : [];
  if (!bot.persona) bot.persona = makePersona(bot.userId || bot.socketId);
  if (!bot.mem) bot.mem = {};
  return {
    me: { socketId: bot.socketId, role: bot.role },
    role: bot.role,
    alive: alive.map(p => ({ socketId: p.socketId, username: p.username })),
    mates,
    iAmMafia: sideOf(bot.role) === 'mafia',
    checked: bot.mem.checked || {},
    memory: bot.mem,
    suspicion: buildSuspicion(g.botEvents || [], g.players),
    voteWeight: buildVoteWeight(g.botEvents || []),
    killedTargets: g.lastNightTargets || [],
    // "Men komissarman" degan botlar — doktor ularni himoya qilishga urinadi
    claimers: (g.botEvents || []).filter(e => e.type === 'claim').map(e => e.from),
    votes: g.dayVotes || {},
    round: g.round || 0,
    persona: bot.persona,
  };
}

async function runBotNightStep(gameId, idx) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished' || g.nightStep !== idx) return;
  const step = NIGHT_STEPS[idx];
  const na = g.nightActions = g.nightActions || {};
  const alive = g.players.filter(p => p.isAlive);
  const actors = alive.filter(p => step.roles.includes(p.role));
  const botActors = actors.filter(isBot);
  const humanActor = actors.some(p => !isBot(p));

  if (step.phase === 'night_mafia') {
    if (humanActor) return; // human mafia — botlar uni kutadi (u ovoz berganda nusxalanadi)
    // Mafiya botlar BIRGALIKDA bitta nishonni tanlaydi (haqiqiy jamoa kabi):
    // birinchi bot qaror qiladi, qolganlari qo'shiladi.
    const lead = botActors[0];
    if (!lead) return;
    const t = chooseNightTarget(botCtx(g, lead));
    if (t) { na.mafiaVotes = na.mafiaVotes || {}; for (const b of botActors) na.mafiaVotes[b.socketId] = t; }
  } else {
    const bot = botActors[0];
    if (humanActor || !bot) return; // user navbati — kutamiz
    const target = chooseNightTarget(botCtx(g, bot));
    if (!target) { await saveG(gameId, g); if (nightStepComplete(g, step)) await endNightStep(gameId, idx); return; }
    bot.mem = bot.mem || {};
    switch (bot.role) {
      case 'komissar':
      case 'sergeant':
        na.komissar = { by: bot.socketId, type: 'check', target };
        // Tekshirilganlar ro'yxati — keyingi tunlarda takrorlamaslik uchun
        bot.mem.checkedSids = [...(bot.mem.checkedSids || []), target];
        break;
      case 'doctor':
        na.doctor = { by: bot.socketId, target };
        bot.mem.healedLast = target;   // ketma-ket bir odamni davolamaslik
        break;
      case 'escort':
        na.escort = { by: bot.socketId, target };
        bot.mem.blockedLast = target;
        break;
      case 'advokat': na.lawyer = { by: bot.socketId, target }; break;
      case 'qotil':   na.killer = { by: bot.socketId, target }; break;
      case 'daydi':   na.daydi  = { by: bot.socketId, target }; break;
    }
  }
  await saveG(gameId, g);
  if (nightStepComplete(g, step)) await endNightStep(gameId, idx);
}

// kunduzgi ovozda bitta bot ovoz beradi (har biri alohida kechikish bilan)
async function botDayVoteOne(gameId, botSid) {
  const g = await getG(gameId);
  if (!g || g.phase !== 'day_discussion') return;
  const bot = g.players.find(p => p.socketId === botSid);
  if (!isBot(bot) || !bot.isAlive || g.dayVotes[botSid]) return;
  // Qaror bot-ai.js da: shubha ballari, mafiya sheriklari, komissar
  // tekshiruvi va botning xarakteri hisobga olinadi.
  const choice = chooseDayVote(botCtx(g, bot));
  // null = "AFK" bot: bu safar umuman ovoz bermaydi (haqiqiy o'yinchilar ham
  // shunday qiladi). Faza taymeri baribir o'yinni davom ettiradi.
  if (choice === null) return;
  g.dayVotes[botSid] = choice;
  botEvent(g, { type: 'vote', round: g.round || 0, from: botSid, to: choice });
  await saveG(gameId, g);
  const counts = {}; Object.values(g.dayVotes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const aliveCount = g.players.filter(p => p.isAlive).length;
  const activeVoters = g.players.filter(p => p.isAlive && p.connected !== false).length;
  const voted = Object.keys(g.dayVotes).length;
  io.to(`game:${gameId}`).emit('vote_update', { counts, totalVoters: voted, aliveCount, activeVoters, votes: g.dayVotes });
  if (voted >= Math.max(1, activeVoters)) {
    if (timers.has(gameId)) clearTimeout(timers.get(gameId));
    withLock(gameId, () => onPhaseEnd(gameId, 'day_discussion'));
  }
}
// Botlar bir vaqtda ovoz bermaydi: har birining "tezligi" bor. Tez bot
// fazaning boshida, sekin bot oxiriga yaqin ovoz beradi — ilgari hammasi
// 2-4.5 soniyada birdan ovoz berib, bot ekanini oshkor qilardi.
function scheduleBotDay(gameId, g) {
  const dur = (g.durations?.day_discussion || 60) * 1000;
  for (const bot of g.players.filter(p => p.isAlive && isBot(p))) {
    if (!bot.persona) bot.persona = makePersona(bot.userId || bot.socketId);
    const delay = voteDelayMs(bot.persona, dur);
    setTimeout(() => withLock(gameId, () => botDayVoteOne(gameId, bot.socketId)), delay);
  }
}

async function recordStats(g, winner) {
  if (g.vsBots) return; // botlar bilan o'yin reyting/tangaga ta'sir qilmaydi (farm oldini olish)

  // Elo uchun raqiblarning O'RTACHA reytingi kerak, shuning uchun avval
  // hamma ishtirokchining joriy holatini BITTA so'rovda olamiz. Ilgari har
  // o'yinchi uchun alohida upsert+findUnique+update qilinardi — 12 kishilik
  // xonada 36 ta so'rov; endi 1 ta o'qish va har kishiga 1 ta yozish.
  const real = g.players.filter((p) => isRealUser(p.userId));
  if (!real.length) return;

  const ids = real.map((p) => p.userId);
  let statsById = new Map();
  try {
    const rows = await prisma.userStats.findMany({ where: { userId: { in: ids } } });
    statsById = new Map(rows.map((r) => [r.userId, r]));
  } catch {}

  const ratingOf = (id) => statsById.get(id)?.rating ?? RATING_START;
  const totalRating = ids.reduce((s, id) => s + ratingOf(id), 0);

  for (const p of real) {
    const won = isWinner(p.role, winner, p.isAlive);
    const reward = won ? ECONOMY.winReward : ECONOMY.loseReward;
    const prev = statsById.get(p.userId);
    const rating = prev?.rating ?? RATING_START;
    const gamesPlayed = prev?.gamesPlayed ?? 0;

    // Raqib kuchi = QOLGANLARNING o'rtachasi (o'zini qo'shmaymiz — aks holda
    // o'yinchi qisman o'zi bilan o'ynagan bo'lib chiqadi va delta kichrayadi).
    const others = ids.length - 1;
    const opponent = others > 0 ? (totalRating - rating) / others : RATING_START;

    const delta = eloDelta({ rating, opponent, won, gamesPlayed });
    const nextRating = applyElo(rating, delta);
    const gainedXp = xpForGame({ won, survived: !!p.isAlive, rounds: g.round || 0 });
    const nextXp = (prev?.xp ?? 0) + gainedXp;

    const nextPlayed = gamesPlayed + 1;
    const nextWon = (prev?.gamesWon ?? 0) + (won ? 1 : 0);

    try {
      await prisma.userStats.upsert({
        where: { userId: p.userId },
        create: {
          userId: p.userId, gamesPlayed: 1, gamesWon: won ? 1 : 0,
          winRate: won ? 100 : 0, rating: nextRating, xp: gainedXp,
        },
        update: {
          gamesPlayed: nextPlayed, gamesWon: nextWon, rating: nextRating, xp: nextXp,
          winRate: Math.round((nextWon / nextPlayed) * 1000) / 10,
        },
      });

      // Daraja oshgan bo'lsa o'yinchiga alohida xabar — bu eng kuchli
      // qaytish sababi, natija oynasida ko'rinib turishi kerak.
      const before = levelFromXp(prev?.xp ?? 0);
      const after = levelFromXp(nextXp);
      if (p.socketId) {
        io.to(p.socketId).emit('progress_update', {
          xp: nextXp, gainedXp, level: after, levelUp: after > before,
          rating: nextRating, ratingDelta: delta, tier: tierOf(nextRating),
        });
      }
      // 🪙 tanga mukofoti + o'yin tarixi
      await prisma.user.update({ where: { id: p.userId }, data: { coins: { increment: reward } } });
      await prisma.gameHistory.create({
        data: { userId: p.userId, gameId: g.id, role: p.role || 'civil', won, winner: winner || '', coins: reward }
      });
      await logActivity(p.userId, 'coin_earn', { amount: reward, gameId: g.id, detail: `${won ? 'G\'alaba' : 'Mag\'lubiyat'} — ${roleName(p.role)}` });
      // tirik klientga yangi tanga balansini yuboramiz
      const fresh = await prisma.user.findUnique({ where: { id: p.userId }, select: { coins: true } }).catch(() => null);
      if (fresh && p.socketId) io.to(p.socketId).emit('coins_update', { coins: fresh.coins, reward });
    } catch {}
  }
}

function winnerMessage(w) {
  return {
    mafia: '🔫 Mafiya g\'alaba qildi!',
    town: '🎉 Tinch aholi g\'alaba qildi!',
    civil: '🎉 Tinch aholi g\'alaba qildi!',
    killer: '🔪 Qotil g\'alaba qildi!',
    wolf: '🐺 Bo\'ri g\'alaba qildi!',
    draw: '🤝 Durang — hech kim omon qolmadi',
  }[w] || 'O\'yin tugadi';
}

async function endGame(gameId, winner) {
  const g = await getG(gameId);
  // Idempotent: ikki marta chaqirilsa tanga/reyting/tarix ikki barobar yozilardi
  if (!g || g.status === 'finished') return;
  g.status = 'finished';
  g.winner = winner;
  g.endedAt = Date.now();
  await saveG(gameId, g);
  prisma.game.update({ where: { id: gameId }, data: { status: 'finished', winner, endedAt: new Date() } }).catch(() => {});
  await recordStats(g, winner);
  tgRoomFinish(gameId).catch(() => {}); // guruhdagi e'lonni yakunlash
  io.to(`game:${gameId}`).emit('game_over', {
    winner, players: revealPlayers(g.players), log: fullLog(g),
    message: winnerMessage(winner)
  });
  if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
  cancelAbandonCheck(gameId);
  cancelEmptyCheck(gameId);
  setTimeout(() => redis.del(`game:${gameId}`, `chat:${gameId}`).catch(() => {}), 60000);
}

// ==================== SOCKET.IO ====================

const socketData = new Map();

// ==================== PING (ulanish sifati) ====================
// Ping SERVERDA o'lchanadi, mijoz o'zi xabar qilmaydi: past ping "yaxshi
// ulanish" belgisi bo'lgani uchun uni soxtalashtirishga sabab bor edi.
//
// O'lchov socket.io ack'i orqali: serverdan probe ketadi, mijoz javob
// qaytaradi, orada o'tgan vaqt — to'liq aylanma (RTT).
const PING_MS = new Map();   // socketId -> so'nggi RTT (ms)
const PING_EVERY = 3000;
const PING_TIMEOUT = 2500;   // javob kelmasa oldingi qiymat saqlanadi

// So'nggi namunalar oynasi. Ko'rsatiladigan qiymat — oynadagi ENG KICHIK namuna.
//
// Nega minimum, o'rtacha emas: o'lchovga tarmoq kechikishidan tashqari server
// va brauzerning band bo'lishi ham qo'shiladi (o'yin taxtasi chizilayotganda
// javob kechikadi). Bu qo'shimchalar faqat QO'SHILADI — hech qachon
// ayirilmaydi. Shuning uchun minimum haqiqiy tarmoq kechikishiga eng yaqin
// baho, o'rtacha esa bitta tasodifiy sakrashdan butunlay ko'tarilib ketadi.
// (Sinovda ketma-ket namunalar: 78, 191, 78, 82, 104, 73 — 191 aynan shunday
// sakrash edi va ekranda "ping ko'tarilib ketdi" bo'lib ko'rinardi.)
const PING_HIST = new Map();  // socketId -> so'nggi namunalar
const PING_WINDOW = 5;

function probePing(socket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      socket.timeout(PING_TIMEOUT).emit('ping_probe', (err) => {
        if (err) return resolve(null);  // javob kelmadi — eski qiymatni buzmaymiz
        const ms = Math.min(9999, Date.now() - t0);
        const hist = PING_HIST.get(socket.id) || [];
        hist.push(ms);
        if (hist.length > PING_WINDOW) hist.shift();
        PING_HIST.set(socket.id, hist);
        PING_MS.set(socket.id, Math.min(...hist));
        resolve(ms);
      });
    } catch { resolve(null); }
  });
}

// DIQQAT: avval HAMMA probe javobini kutamiz, keyin tarqatamiz.
// Ilgari probe yuborilib, o'sha zahoti PING_MS o'qilardi — ya'ni har doim
// OLDINGI siklning qiymati ketardi: birinchi ping ~10 soniyadan keyin
// ko'rinardi va ko'rsatilgan son doim bir sikl eskirgan bo'lardi.
let pingBusy = false;
async function pingCycle() {
  if (pingBusy) return;  // sekin tarmoqda sikllar ustma-ust tushmasin
  pingBusy = true;
  try {
    // Faqat O'YINDAGI socketlar — lobbida turganning pingi kerak emas.
    const targets = [];
    for (const [sid, d] of socketData) {
      if (!d?.gameId) continue;
      const s = io.sockets.sockets.get(sid);
      if (!s) { PING_MS.delete(sid); PING_HIST.delete(sid); continue; }
      targets.push([sid, d.gameId, s]);
    }
    if (!targets.length) return;

    await Promise.all(targets.map(([, , s]) => probePing(s)));

    // DIQQAT: `ping` maydonining shakli O'ZGARMAYDI (socketId -> son).
    // Transport ALOHIDA maydonda yuboriladi — eski mijoz yangi serverga
    // ulanganda ping ko'rsatkichi ishlashda davom etsin.
    const byGame = new Map();
    const trByGame = new Map();
    for (const [sid, gameId, s] of targets) {
      const v = PING_MS.get(sid);
      if (v === undefined) continue;
      if (!byGame.has(gameId)) { byGame.set(gameId, {}); trByGame.set(gameId, {}); }
      byGame.get(gameId)[sid] = v;
      // WebSocket o'rniga long-polling'ga tushib qolgan mijozda har xabar
      // to'liq HTTP so'rov bo'ladi va ping tabiiy ravishda bir necha barobar
      // yomon chiqadi. Ba'zi korporativ/mobil tarmoqlar WebSocket'ni bloklaydi
      // va socket.io jimgina pollingda qoladi — buni ko'rsatmasak, sababni
      // tarmoqdan qidirib vaqt yo'qotiladi.
      trByGame.get(gameId)[sid] = s.conn?.transport?.name || '?';
    }
    // Botlar uchun SOXTA ping. Busiz botda ping ustuni bo'sh qolardi va
    // "pingsiz o'yinchi" — bu bot degan eng aniq belgi bo'lardi.
    // Qiymat har o'lchashda biroz tebranadi (fakePing), xuddi haqiqiy tarmoq kabi.
    for (const [gameId, map] of byGame) {
      const g = await getG(gameId).catch(() => null);
      if (g) {
        for (const p of g.players || []) {
          if (!isBot(p) || p.isAlive === false) continue;
          if (!p.persona) p.persona = makePersona(p.userId || p.socketId);
          map[p.socketId] = fakePing(p.persona);
          trByGame.get(gameId)[p.socketId] = 'websocket';
        }
      }
      io.to(`game:${gameId}`).emit('ping_update', { ping: map, transport: trByGame.get(gameId) });
    }
  } finally {
    pingBusy = false;
  }
}

const pingTimer = setInterval(pingCycle, PING_EVERY);
pingTimer.unref?.();

// Botlarning o'zaro o'yinlari — jadval bo'yicha (presence.js)
if (BOT_GAMES_ON) {
  const botGameTimer = setInterval(() => { botGameTick().catch(() => {}); }, BOT_GAME_CHECK_MS);
  botGameTimer.unref?.();
  // Ishga tushgandan 30 s keyin birinchi tekshiruv (Redis ulanishini kutamiz)
  setTimeout(() => { botGameTick().catch(() => {}); }, 30000);
}

// Xonaga kirgan odam ping ko'rinishini kutib o'tirmasin — darhol bir sikl.
function pingSoon() { setTimeout(() => { pingCycle().catch(() => {}); }, 400); }

// Faza yopilganda sekin ulanishli o'yinchining harakati yo'lda qolib
// ketmasin: eng sekin ishtirokchining pingi qadar (lekin ko'pi bilan 1.5 s)
// qo'shimcha vaqt beriladi. Cheklov ATAYLAB qattiq — aks holda bitta yomon
// ulanish butun xonani kutib turishga majbur qilardi.
const GRACE_MAX = 1500;
function graceFor(g) {
  if (!g?.players) return 0;
  let worst = 0;
  for (const p of g.players) {
    if (!p.isAlive || !p.socketId) continue;
    const v = PING_MS.get(p.socketId);
    if (v && v > worst) worst = v;
  }
  return Math.min(GRACE_MAX, worst);
}

// ==================== OVOZLI CHAT (WebRTC signaling) ====================
// Server faqat signaling qiladi (SDP/ICE almashinuvi). Audio brauzerlar orasida P2P oqadi.
const voicePeers = new Map(); // gameId -> Set(socketId)
function voiceLeave(gameId, socketId) {
  const set = voicePeers.get(gameId);
  if (set) { set.delete(socketId); if (!set.size) voicePeers.delete(gameId); }
}

// ==================== DO'ST BOT-O'YINIGA QO'SHILISH ====================
const pendingJoins = new Map(); // requestId -> { requesterSocketId, requesterUserId, requesterUsername, requesterAvatar, gameId }

// username bo'yicha o'sha foydalanuvchining aktiv botlar o'yinini topadi
async function findBotGameByHost(hostUsername) {
  const host = await prisma.user.findUnique({ where: { username: hostUsername } }).catch(() => null);
  if (!host) return null;
  const games = await prisma.game.findMany({
    where: { hostId: host.id, status: { in: ['waiting', 'playing'] } },
    orderBy: { createdAt: 'desc' }
  });
  for (const gm of games) {
    const g = await getG(gm.id).catch(() => null);
    if (g && g.vsBots) return { gameId: gm.id, g, host };
  }
  return null;
}

// ==================== SOCKET HIMOYASI ====================
const ipConns = new Map();           // ip -> ochiq ulanishlar soni
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP || '30');   // saxiy (CGNAT uchun)

// --- Socket flood himoyasi (env orqali sozlanadi, kod o'zgartirmasdan) ---
// Butun serverdagi ochiq socketlar chegarasi. Node xotirasini himoya qiladi:
// har socket ~10-40 KB, 3000 ta ~ 100 MB. Chegaradan oshsa YANGI ulanish rad etiladi,
// mavjud o'yinlar buzilmaydi.
const MAX_TOTAL_SOCKETS = parseInt(process.env.MAX_TOTAL_SOCKETS || '3000');
// Bitta IP dan 10 soniyada nechta TOKENLI ulanish urinishi (ochiq ulanishlar soni emas).
// Faqat auth'dan o'tganlar hisoblanadi — pastdagi io.use() izohiga qarang.
// Backend restartida bitta CGNAT IP ostidagi o'nlab mijoz bir vaqtda qayta ulanadi,
// shuning uchun saxiy: 60/10s = 6/s.
const MAX_HANDSHAKE_PER_IP = parseInt(process.env.MAX_HANDSHAKE_PER_IP || '60');
const HANDSHAKE_WINDOW_MS = 10000;
// Socket faqat tizimga kirgan foydalanuvchiga kerak (o'yinga kirish, chat, ovoz —
// hammasi auth talab qiladi). Shu sababli tokensiz ulanish UMUMAN qabul qilinmaydi:
// bot avval Google orqali ro'yxatdan o'tmasa, socketni ocha olmaydi.
// Biror narsa buzilsa: .env da SOCKET_REQUIRE_AUTH=0 qilib pm2 restart — kod tegilmaydi.
const SOCKET_REQUIRE_AUTH = process.env.SOCKET_REQUIRE_AUTH !== '0';
// Ulangan, lekin o'yinga kirmagan socket qancha yashaydi (lurker/zombi tozalash)
const IDLE_SOCKET_MS = parseInt(process.env.IDLE_SOCKET_MS || '120000');

const handshakes = new Map();        // ip -> { t, c }
// hisoblagichlar cheksiz o'smasin
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of handshakes) if (now - h.t > HANDSHAKE_WINDOW_MS * 3) handshakes.delete(ip);
  for (const [ip, n] of ipConns) if (n <= 0) ipConns.delete(ip);
}, 60000).unref?.();

// rad etilgan ulanishlar statistikasi — /health orqali ko'rinadi
const shield = { noAuth: 0, perIp: 0, handshake: 0, total: 0, idle: 0 };
function socketIp(socket) {
  const h = socket.handshake.headers || {};
  // clientIp() bilan bir xil qoida: sarlavhaga faqat proxy ortida ishonamiz
  const direct = String(socket.handshake.address || '').replace('::ffff:', '');
  if (direct && isPublicIp(direct)) return direct;
  return h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || direct || 'unknown';
}
function clearIdle(socket) {
  if (socket?.data?.idleTimer) { clearTimeout(socket.data.idleTimer); socket.data.idleTimer = null; }
}
// har socket uchun: umumiy flood + event bo'yicha cheklov. Ruxsat bo'lsa true.
function guard(socket, key, max, windowMs) {
  const d = socket.data; const now = Date.now();
  // umumiy flood (sekundiga) — chegaradan oshsa socketni uzamiz
  // umumiy flood chegarasi — WebRTC ulanish portlashlarini (ICE) hisobga olib saxiy (200/s).
  // Haqiqiy hujum minglab/s yuboradi; 200/s zaif serverga zarar bermaydi, ovoz setup'ni esa o'ldirmaydi.
  const f = d.flood || (d.flood = { t: now, c: 0 });
  if (now - f.t >= 1000) { f.t = now; f.c = 0; }
  if (++f.c > 200) { try { socket.disconnect(true); } catch {} return false; }
  // event bo'yicha (jim tashlanadi — amplifikatsiya bermaymiz)
  const rl = d.rl || (d.rl = {});
  let b = rl[key];
  if (!b || now - b.t >= windowMs) { b = { t: now, c: 0 }; rl[key] = b; }
  return ++b.c <= max;
}

// Ulanish qabul qilinishidan oldingi to'rt qatlamli filtr.
// Tartib ARZONdan QIMMATga: avval umumiy chegara, keyin IP, keyin JWT tekshiruvi.
io.use((socket, next) => {
  const ip = socketIp(socket);
  socket.data.ip = ip;

  // (1) Server bo'yicha umumiy chegara — xotirani himoya qiladi
  if (io.engine.clientsCount >= MAX_TOTAL_SOCKETS) {
    shield.total++;
    return next(new Error('server_busy'));
  }

  // (2) Token tekshiruvi — ATAYLAB tezlik chegarasidan OLDIN.
  // JWT tekshiruvi HMAC bo'lib mikrosoniyalar oladi (DB ga bormaydi), ya'ni arzon.
  // Tokensiz bot shu yerda tugaydi va IP ning "ulanish tezligi" byudjetini
  // ISROF QILMAYDI — aks holda bir CGNAT IP ostidagi bot flood'i o'sha IP dagi
  // real o'yinchilarni ham bloklab qo'yardi (2026-09-15 sinovida aynan shunday bo'ldi).
  try {
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        const p = jwt.verify(token, JWT_SECRET);
        // qurilmaga bog'langan token — qurilma mos kelsagina ishonamiz
        if (p.dvc) {
          const dev = socket.handshake.auth?.deviceId;
          if (dev && deviceHash(dev) === p.dvc) socket.data.auth = p;
          // mos kelmasa — auth o'rnatilmaydi (boshqa nomidan kira olmaydi)
        } else socket.data.auth = p;
      } catch {}
    }
  } catch {}
  if (SOCKET_REQUIRE_AUTH && !socket.data.auth) {
    shield.noAuth++;
    return next(new Error('unauthorized'));
  }

  // (3) Bitta IP dan ulanish TEZLIGI — endi faqat TOKENLI urinishlar hisoblanadi.
  // Ya'ni haqiqiy hisobdan qayta-qayta ulanib uzayotgan mijoz/skript to'xtaydi.
  if (isPublicIp(ip)) {
    const now = Date.now();
    let h = handshakes.get(ip);
    if (!h || now - h.t >= HANDSHAKE_WINDOW_MS) { h = { t: now, c: 0 }; handshakes.set(ip, h); }
    if (++h.c > MAX_HANDSHAKE_PER_IP) {
      shield.handshake++;
      return next(new Error('too_many_attempts'));
    }
  }

  // (4) Bitta IP dan OCHIQ ulanishlar soni
  if (isPublicIp(ip)) {
    const n = (ipConns.get(ip) || 0) + 1;
    if (n > MAX_CONN_PER_IP) { shield.perIp++; return next(new Error('too_many_connections')); }
    ipConns.set(ip, n);
  }
  next();
});

io.on('connection', (socket) => {
  console.log(`✅ ${socket.id}`);
  // Ulangan, lekin hech qaysi o'yinga kirmagan socketni tozalaymiz:
  // bot ulanib jim turib xotira egallashi mumkin emas.
  socket.data.idleTimer = setTimeout(() => {
    if (!socketData.has(socket.id)) { shield.idle++; try { socket.disconnect(true); } catch {} }
  }, IDLE_SOCKET_MS);
  socket.data.idleTimer.unref?.();

  socket.on('join_game', ({ gameId, userId, username } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'join', 10, 5000)) return;
      // faqat haqiqiy (Google-tasdiqlangan) foydalanuvchilar — anonim/guest flood yo'q
      if (!socket.data.auth) { socket.emit('game_error', { code: 'authRequired', message: 'Avtorizatsiya kerak — qaytadan kiring' }); return; }
      userId = socket.data.auth.userId;
      username = socket.data.auth.username;
      // bloklangan foydalanuvchi (Redis keshidan — bazaga bormaymiz)
      if (await isBanned(userId)) { socket.emit('game_error', { code: 'banned', message: 'Siz bloklangansiz' }); return; }
      // xona egasi chiqarib yuborgan odam qaytib kira olmaydi (xona tugaguncha)
      {
        const pre = await getG(gameId);
        if (pre?.kicked?.[userId]) {
          socket.emit('game_error', { code: 'kicked', message: 'Sizni bu xonadan chiqarib yuborgan' });
          return;
        }
      }

      const key = `game:${gameId}`;
      const g = await getG(gameId);
      if (!g) { socket.emit('game_error', { code: 'notFound', message: 'O\'yin topilmadi yoki tugagan' }); return; }
      if (!g.players) g.players = [];
      // botlar o'yiniga qaytib kelindi — o'chirish taymerini bekor qilamiz
      if (botDeleteTimers.has(gameId)) { clearTimeout(botDeleteTimers.get(gameId)); botDeleteTimers.delete(gameId); }

      // FAQAT userId bo'yicha — username bo'yicha moslashtirish begona o'rinni
      // (va u bilan birga rolni) egallash imkonini berardi
      const matchPlayer = () => g.players.find(p => userId && p.userId === userId);

      if (g.status === 'playing' || g.status === 'finished') {
        const existing = matchPlayer();
        if (existing) {
          cancelAbandonCheck(gameId);                     // o'yinchi qaytib keldi
          remapSocketId(g, existing.socketId, socket.id); // ovoz/harakatlarni yangi socketga ko'chiramiz
          existing.socketId = socket.id;
          existing.connected = true;
          clearIdle(socket); pingSoon(); socketData.set(socket.id, { userId, username: existing.username, gameId });
          socket.join(key);
          await saveG(gameId, g);
          socket.emit('game_state', publicGame(g));
          socket.emit('your_role', { role: existing.role });
          socket.emit('your_items', { items: existing.items || { shield: 0, lupa: 0, life: 0 } });
          await sendChatHistory(socket, gameId, existing);   // muhokama yo'qolmasin
          // reconnectda ham mafiyaga sheriklarini qayta yuboramiz (socketId yangilangan bo'lishi mumkin)
          // socketId yangilangani uchun butun mafiya jamoasiga yangi ro'yxat kerak
          if (sideOf(existing.role) === 'mafia') syncMafiaTeam(g);
          if (g.phaseEndsAt && g.status === 'playing') {
            const step = nightStepByPhase(g.phase);
            socket.emit('phase_change', {
              phase: g.phase, endsAt: g.phaseEndsAt,
              duration: (step ? dur(g, step.dur) : dur(g, g.phase)) || 0, round: g.round,
              players: publicPlayers(g.players, { light: true }),
              present: step ? (g.nightPresent !== false) : undefined,
              stepNoun: step ? step.noun : undefined,
            });
            resendPending(socket, g);   // qasos / oxirgi so'z huquqi yo'qolmasin
          }
          if (g.status === 'finished') {
            socket.emit('game_over', {
              winner: g.winner, players: revealPlayers(g.players), log: fullLog(g),
              message: winnerMessage(g.winner)
            });
          }
          io.to(key).emit('game_state', publicGame(g));
          return;
        }
        socket.emit('game_error', { code: 'alreadyStarted', message: 'O\'yin boshlangan — kira olmaysiz' });
        return;
      }

      // LOBBY
      cancelEmptyCheck(gameId); // kimdir kirdi — bo'sh-xona taymerini bekor qilamiz
      const existing = matchPlayer();
      if (existing) {
        remapSocketId(g, existing.socketId, socket.id);
        existing.socketId = socket.id;
        existing.connected = true;
        clearIdle(socket); pingSoon(); socketData.set(socket.id, { userId, username: existing.username, gameId });
        socket.join(key);
        await saveG(gameId, g);
        socket.emit('game_state', publicGame(g));
        io.to(key).emit('game_state', publicGame(g));
        return;
      }

      // Xona sig'imi — ilgari tekshirilmagan: 8 kishilik xonaga 20 kishi kirsa
      // rol taqsimoti (roleConfig 8 ga mo'ljallangan) butunlay buzilardi.
      const cap = g.totalPlayers || g.maxPlayers || 20;
      if (g.players.length >= cap) {
        socket.emit('game_error', { code: 'roomFull', message: 'Xona to\'lgan' });
        return;
      }

      const isHost = g.hostId && g.hostId === userId;
      let avatar = null;
      if (userId && !String(userId).startsWith('guest-')) {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { avatar: true } }).catch(() => null);
        avatar = u?.avatar || null;
      }
      const player = {
        socketId: socket.id,
        userId: userId || 'guest-' + socket.id.slice(0, 6),
        username: username || 'O\'yinchi-' + socket.id.slice(0, 4),
        avatar,
        role: null, isAlive: true, connected: true, isHost, joinedAt: Date.now()
      };
      g.players.push(player);
      // xonada bo'lib o'tganlar ro'yxati — chiqib ketsa ham qoladi (Telegram e'loni uchun)
      if (!Array.isArray(g.everPlayers)) g.everPlayers = [];
      if (!g.everPlayers.includes(player.username)) g.everPlayers.push(player.username);
      await saveG(gameId, g);
      clearIdle(socket); pingSoon(); socketData.set(socket.id, { userId: player.userId, username: player.username, gameId });
      socket.join(key);

      io.to(key).emit('game_state', publicGame(g));
      io.to(key).emit('player_joined', { username: player.username, total: g.players.length });
      tgRoomTouch(gameId); // guruhdagi e'londa o'yinchilar sonini yangilash

      // 🤖 botlar o'yini — foydalanuvchi kirishi bilan avtomatik boshlanadi
      if (g.vsBots && g.status === 'waiting') {
        setTimeout(() => withLock(gameId, () => beginGame(gameId)), 700);
      }
    } catch (e) {
      console.error('join_game:', e);
      socket.emit('game_error', { message: e.message });
    }
  }));

  socket.on('start_game', ({ gameId } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'start', 5, 5000)) return;
      const g = await getG(gameId);
      if (!g) return;
      const settings = await getSettings();
      const min = settings.minPlayers || 5;
      if (g.players.length < min) { socket.emit('game_error', { code: 'needPlayers', n: min, message: `Kamida ${min} o'yinchi` }); return; }
      // A'zolik SHART: ilgari `starter` topilmasa shart butunlay o'tkazib yuborilardi,
      // ya'ni xonaga kirmagan istalgan foydalanuvchi begona o'yinni boshlab yubora olardi.
      const starter = g.players.find(p => p.socketId === socket.id);
      if (!starter) { socket.emit('game_error', { code: 'notInRoom', message: 'Siz bu xonada emassiz' }); return; }
      if (g.hostId && starter.userId !== g.hostId && !starter.isHost) {
        socket.emit('game_error', { code: 'hostOnly', message: 'Faqat xona egasi boshlay oladi' }); return;
      }
      await beginGame(gameId);
    } catch (e) { console.error('start_game:', e); }
  }));

  socket.on('day_vote', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'vote', 20, 5000)) return;
      const g = await getG(gameId);
      if (!g || g.phase !== 'day_discussion') return;
      const voter = g.players.find(p => p.socketId === socket.id);
      if (!voter || !voter.isAlive) return;
      // 'skip' = hech kimni chiqarmaslik. Aks holda — tirik o'yinchi bo'lishi shart.
      if (targetSocketId !== 'skip') {
        const tgt = g.players.find(p => p.socketId === targetSocketId);
        if (!tgt || !tgt.isAlive) return;
      }
      g.dayVotes[socket.id] = targetSocketId;
      botEvent(g, { type: 'vote', round: g.round || 0, from: socket.id, to: targetSocketId });
      await saveG(gameId, g);

      const counts = {};
      Object.values(g.dayVotes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const aliveCount = g.players.filter(p => p.isAlive).length;
      // Uzilib qolgan o'yinchi ovoz bera olmaydi — uni kutib butun xonani ushlab
      // turmaymiz, faqat ULANGAN tiriklar hisoblanadi
      const activeVoters = g.players.filter(p => p.isAlive && p.connected !== false).length;
      const voted = Object.keys(g.dayVotes).length;
      io.to(`game:${gameId}`).emit('vote_update', { counts, totalVoters: voted, aliveCount, activeVoters, votes: g.dayVotes });
      socket.emit('action_confirmed', { code: targetSocketId === 'skip' ? 'voteSkip' : 'voteCast', message: targetSocketId === 'skip' ? '⏭ O\'tkazib yuborildi' : '✅ Ovoz berildi' });

      if (voted >= Math.max(1, activeVoters)) {
        if (timers.has(gameId)) clearTimeout(timers.get(gameId));
        // await qilmaymiz: biz hozir shu o'yin qulfi ichidamiz — navbatga qo'yamiz
        withLock(gameId, () => onPhaseEnd(gameId, 'day_discussion'));
      }
    } catch (e) { console.error('day_vote:', e); }
  }));

  socket.on('night_action', ({ gameId, targetSocketId, actionType } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'night', 25, 5000)) return;
      const g = await getG(gameId);
      if (!g) return;
      const step = nightStepByPhase(g.phase);
      if (!step) return; // hozir tungi harakat fazasi emas
      const player = g.players.find(p => p.socketId === socket.id);
      if (!player || !player.isAlive) return;
      // faqat shu bosqich roli harakat qila oladi
      if (!step.roles.includes(player.role)) { socket.emit('game_error', { code: 'notYourTurn', message: '⏳ Hozir sizning navbatingiz emas' }); return; }
      if (!g.nightActions) g.nightActions = {};
      const na = g.nightActions;
      const target = g.players.find(p => p.socketId === targetSocketId);
      const targetAlive = target && target.isAlive;

      switch (player.role) {
        case 'don':
        case 'mafia': {
          if (!targetAlive || sideOf(target.role) === 'mafia') { socket.emit('game_error', { code: 'noMafiaTarget', message: '❌ Mafiyaga ovoz berib bo\'lmaydi' }); return; }
          if (!na.mafiaVotes) na.mafiaVotes = {};
          na.mafiaVotes[socket.id] = targetSocketId;
          // BOTLAR REJIMI: bot mafiyalar foydalanuvchini qo'llab-quvvatlaydi (bir xil nishon)
          if (g.vsBots) {
            for (const b of g.players.filter(p => p.isAlive && isBot(p) && sideOf(p.role) === 'mafia')) na.mafiaVotes[b.socketId] = targetSocketId;
          }
          socket.emit('action_confirmed', { code: 'mafiaVote', name: target.username, message: `🔫 Ovozingiz: ${target.username}` });
          // mafiya sheriklarga joriy ovozlarni ko'rsatamiz (kelishish uchun)
          const mafiaVotesView = {};
          for (const m of g.players.filter(p => p.isAlive && MAFIA_VOTERS.includes(p.role))) {
            const tgtSid = na.mafiaVotes[m.socketId];
            const tgt = tgtSid ? g.players.find(p => p.socketId === tgtSid) : null;
            mafiaVotesView[m.username] = tgt ? tgt.username : null;
          }
          for (const m of g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia')) {
            io.to(m.socketId).emit('mafia_vote_update', { votes: mafiaVotesView });
          }
          break;
        }
        case 'komissar': {
          // O'zini tekshirish/otish ma'nosiz va halokatli — Komissar o'zini
          // otib o'ldira olardi (o'q to'xtatib bo'lmaydigan turda)
          if (!targetAlive || targetSocketId === socket.id) return;
          const type = actionType === 'shoot' ? 'shoot' : 'check';
          // Birinchi tunda otish taqiqlanadi (ROLES.md) — bir kechada faqat bitta
          // harakat bo'lgani uchun "avval tekshirdim" istisnosi mantiqan mumkin emas.
          if (type === 'shoot' && (g.round || 1) <= 1) {
            socket.emit('game_error', { code: 'firstNightCheck', message: '❌ Birinchi tun: avval tekshiring, otib bo\'lmaydi' }); return;
          }
          na.komissar = { by: socket.id, type, target: targetSocketId };
          socket.emit('action_confirmed', { code: type === 'shoot' ? 'komShoot' : 'komCheck', name: target.username, message: type === 'shoot' ? `🔫 ${target.username}ga otish` : `🔍 ${target.username}ni tekshirish` });
          break;
        }
        case 'doctor': {
          if (!targetAlive) return;
          // Huquqni shu yerda SARFLAMAYMIZ — faqat tekshiramiz. Aks holda o'yinchi
          // fikrini o'zgartirsa yoki Kezuvchi bloklasa, yagona imkoniyat behuda ketardi.
          if (targetSocketId === socket.id && player.roleData?.selfHeal) {
            socket.emit('game_error', { code: 'selfHealOnce', message: '❌ O\'zingizni faqat bir marta davolaysiz' }); return;
          }
          na.doctor = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { code: 'heal', name: target.username, message: `💚 ${target.username} davolanadi` });
          break;
        }
        case 'escort': {
          if (!targetAlive || targetSocketId === socket.id) return;
          // MUHIM: Komissar tanlansa ALOHIDA xato qaytarmaymiz. Ilgari shunday edi va
          // Kezuvchi har bir o'yinchini navbat bilan bosib, javob farqidan Komissarni
          // 100% aniqlab olardi. Endi tanlov jimgina qabul qilinadi — blok esa
          // processNight'dagi `t.role !== 'komissar'` sharti bilan kuchga kirmaydi.
          na.escort = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { code: 'escort', name: target.username, message: `💃 ${target.username} band qilindi` });
          break;
        }
        case 'advokat': {
          if (!targetAlive) return;
          na.lawyer = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { code: 'protect', name: target.username, message: `👨‍💼 ${target.username} himoyalanadi` });
          break;
        }
        case 'qotil': {
          if (!targetAlive || targetSocketId === socket.id) return;
          na.killer = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { code: 'killTarget', name: target.username, message: `🔪 ${target.username} nishonda` });
          break;
        }
        case 'daydi': {
          if (!targetAlive || targetSocketId === socket.id) return;
          na.daydi = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { code: 'visit', name: target.username, message: `🧙‍♂️ ${target.username} oldiga bording` });
          break;
        }
        default:
          return;
      }

      await saveG(gameId, g);
      // bosqich tugagan bo'lsa (rol harakat qildi / mafiya kelishdi) — keyingisiga o'tamiz
      if (nightStepComplete(g, step)) {
        await endNightStep(gameId, g.nightStep);
      }
    } catch (e) { console.error('night_action:', e); }
  }));

  // 🧞‍♂️ Afsungar qasosi — kunduzi chiqarilgach o'zi bilan olib ketadigan o'yinchini tanlaydi
  socket.on('revenge_pick', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'revenge', 10, 5000)) return;
      const g = await getG(gameId);
      if (!g || !g.revenge || g.revenge.by !== socket.id || g.phase !== 'day_results') return;
      const t = g.players.find(p => p.socketId === targetSocketId && p.isAlive);
      if (!t || t.socketId === socket.id) return;
      g.revenge.target = targetSocketId;
      await saveG(gameId, g);
      socket.emit('action_confirmed', { code: 'revengePicked', name: t.username, message: `🧞‍♂️ ${t.username} siz bilan ketadi` });
    } catch (e) { console.error('revenge_pick:', e); }
  }));

  socket.on('use_item', ({ gameId, item, targetSocketId } = {}) => withLock(gameId, async () => {
    try {
      if (!guard(socket, 'item', 10, 5000)) return;
      const g = await getG(gameId);
      if (!g || g.status !== 'playing') return;
      const p = g.players.find(x => x.socketId === socket.id);
      if (!p || !p.isAlive) return;
      if (!p.items) p.items = { shield: 0, lupa: 0, life: 0 };
      if ((p.items[item] || 0) <= 0) { socket.emit('item_result', { item, ok: false, code: 'noItem', message: '❌ Bu buyum sizda yo\'q' }); return; }

      if (item === 'shield') {
        p.items.shield--;
        p.shieldActive = true;
        await adjustUserItems(p.userId, { shield: -1 });
        await logActivity(p.userId, 'item_use', { item: 'shield', amount: -1, gameId, detail: `${g.round}-kechada qalqon yoqildi` });
        socket.emit('item_result', { item, ok: true, code: 'shieldOn', message: '🛡️ Qalqon yoqildi — bu kecha mafiyadan himoyalangansiz' });
      } else if (item === 'lupa') {
        const t = g.players.find(x => x.socketId === targetSocketId);
        if (!t || !t.isAlive || t.socketId === socket.id) {
          socket.emit('item_result', { item, ok: false, code: 'pickAlive', message: '❌ Tirik o\'yinchini tanlang' });
          return;
        }
        p.items.lupa--;
        await adjustUserItems(p.userId, { lupa: -1 });
        await logActivity(p.userId, 'item_use', { item: 'lupa', amount: -1, gameId, detail: `${t.username} tekshirildi — ${roleName(t.role)}` });
        socket.emit('item_result', { item, ok: true, code: 'lupaResult', target: t.username, role: t.role, message: `🔍 ${t.username} → ${roleName(t.role)}` });
      } else {
        socket.emit('item_result', { item, ok: false, code: 'itemAuto', message: 'Bu buyum avtomatik ishlaydi' });
        return;
      }

      await saveG(gameId, g);
      socket.emit('your_items', { items: p.items });
    } catch (e) { console.error('use_item:', e); }
  }));

  socket.on('chat_message', async ({ gameId, message } = {}) => {
    if (!guard(socket, 'chat', 6, 5000)) return; // ~1.2 xabar/sekund
    const data = socketData.get(socket.id);
    if (!data) return;
    const text = String(message || '').trim().slice(0, 300);
    if (!text) return;
    const g = await getG(gameId);
    const player = g?.players.find(p => p.socketId === socket.id);
    if (!player) return;

    // 🗣️ Oxirgi so'z — chiqarilgan o'yinchi day_results davomida bitta OCHIQ xabar yozadi.
    // Holatni o'zgartirgani uchun qulf ostida bajaramiz (aks holda bir vaqtda ketayotgan
    // faza almashinuvi eski nusxa bilan bosib yozilardi).
    if (g.lastWordSid && socket.id === g.lastWordSid && g.phase === 'day_results') {
      const ok = await withLock(gameId, async () => {
        const fresh = await getG(gameId);
        if (!fresh || fresh.lastWordSid !== socket.id || fresh.phase !== 'day_results') return false;
        delete fresh.lastWordSid;
        await saveG(gameId, fresh);
        return true;
      });
      if (ok) {
        const lw = { username: data.username, message: text, channel: 'public', isAlive: false, lastWord: true, timestamp: Date.now() };
        try {
          await redis.rpush(`chat:${gameId}`, JSON.stringify(lw));
          await redis.ltrim(`chat:${gameId}`, -200, -1);
          await redis.expire(`chat:${gameId}`, 86400);
        } catch {}
        io.to(`game:${gameId}`).emit('chat_message', lw);
        return;
      }
    }

    const isNight = String(g.phase || '').startsWith('night');
    // KANALLAR: public (kunduzgi ochiq), mafia (tunda faqat mafiya), dead (o'liklar)
    let channel;
    if (!player.isAlive) channel = 'dead';
    else if (isNight) {
      if (sideOf(player.role) === 'mafia') channel = 'mafia';
      else { socket.emit('game_error', { code: 'nightChatLocked', message: '🌙 Tunda faqat mafiya gaplasha oladi' }); return; }
    } else channel = 'public';

    const payload = { username: data.username, message: text, channel, isAlive: player.isAlive, timestamp: Date.now() };

    // Tarixni ALOHIDA Redis ro'yxatida saqlaymiz (o'yin holatiga yozsak har xabarda
    // butun holat qayta serializatsiya bo'lardi). Qayta ulanganda muhokama yo'qolmaydi.
    try {
      const ck = `chat:${gameId}`;
      await redis.rpush(ck, JSON.stringify(payload));
      await redis.ltrim(ck, -200, -1);
      await redis.expire(ck, 86400);
    } catch {}

    if (channel === 'public') {
      // hammaga (o'liklar ham ochiq muhokamani o'qiydi)
      io.to(`game:${gameId}`).emit('chat_message', payload);
    } else if (channel === 'mafia') {
      // faqat tirik mafiya tomoni
      for (const m of g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia')) io.to(m.socketId).emit('chat_message', payload);
    } else {
      // faqat o'liklar bir-biri bilan
      for (const dpl of g.players.filter(p => !p.isAlive)) io.to(dpl.socketId).emit('chat_message', payload);
    }
  });

  // ===== Do'st bot-o'yiniga qo'shilish so'rovi =====
  socket.on('request_join_bot', async ({ hostUsername, userId, username, avatar } = {}) => {
    try {
      if (!guard(socket, 'joinreq', 3, 30000)) return socket.emit('bot_join_error', { message: 'Juda tez-tez so\'rov yubordingiz' });
      // tokendan ishonchli identifikatsiya
      if (socket.data.auth) { userId = socket.data.auth.userId; username = socket.data.auth.username; }
      if (!hostUsername || !username) return socket.emit('bot_join_error', { message: 'Username kerak' });
      const found = await findBotGameByHost(String(hostUsername).trim());
      if (!found) return socket.emit('bot_join_error', { message: 'Bu foydalanuvchi hozir botlar bilan o\'ynamayapti' });
      const { gameId, g } = found;
      if (userId && g.hostId === userId) return socket.emit('bot_join_error', { message: 'Bu sizning o\'yiningiz' });
      const already = g.players.find(p => !p.isBot && (p.userId === userId || p.username === username));
      if (already) return socket.emit('join_approved', { gameId });
      if ((g.rejects?.[userId] || 0) >= 3) return socket.emit('join_rejected', { blocked: true, message: 'Siz bu o\'yinga qo\'shila olmaysiz (3 marta rad etildi)' });
      if (!g.players.some(p => p.isAlive && p.isBot)) return socket.emit('bot_join_error', { message: 'O\'yinda bo\'sh joy yo\'q' });
      const hostP = g.players.find(p => !p.isBot && p.userId === g.hostId && p.connected !== false) || g.players.find(p => !p.isBot && p.connected !== false);
      if (!hostP || !hostP.socketId) return socket.emit('bot_join_error', { message: 'O\'yin egasi hozir mavjud emas' });
      // Avatarni MIJOZDAN olmaymiz — u /api/me/profile dagi barcha tekshiruvni
      // chetlab o'tib, ~1MB satr sifatida Redis'ga yozilib butun xonaga tarqalardi.
      const ru = isRealUser(userId)
        ? await prisma.user.findUnique({ where: { id: userId }, select: { avatar: true } }).catch(() => null)
        : null;
      const safeAvatar = ru?.avatar || null;
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingJoins.set(requestId, { requesterSocketId: socket.id, requesterUserId: userId, requesterUsername: username, requesterAvatar: safeAvatar, gameId });
      io.to(hostP.socketId).emit('join_request', { requestId, requester: { userId, username, avatar: safeAvatar } });
      socket.emit('bot_join_pending', { host: hostUsername });
      setTimeout(() => {
        if (pendingJoins.has(requestId)) { pendingJoins.delete(requestId); io.to(socket.id).emit('bot_join_error', { message: 'Javob kelmadi (vaqt tugadi)' }); }
      }, 60000);
    } catch (e) { socket.emit('bot_join_error', { message: e.message }); }
  });

  socket.on('join_response', async ({ requestId, accept } = {}) => {
    if (!guard(socket, 'joinresp', 10, 5000)) return;
    const req = pendingJoins.get(requestId);
    if (!req) return;
    pendingJoins.delete(requestId);
    await withLock(req.gameId, async () => {
      const g = await getG(req.gameId);
      if (!g) { io.to(req.requesterSocketId).emit('bot_join_error', { message: 'O\'yin tugagan' }); return; }
      // javob beruvchi haqiqatan ham o'yin ichidagi odammi (xavfsizlik)
      const responder = g.players.find(p => p.socketId === socket.id && !p.isBot);
      if (!responder) return;
      if (accept) {
        const bot = pickRandom(g.players.filter(p => p.isAlive && p.isBot));
        if (!bot) { io.to(req.requesterSocketId).emit('bot_join_error', { message: 'Bo\'sh joy qolmadi' }); return; }
        // bot o'rnini do'st egallaydi (roli saqlanadi)
        bot.isBot = false;
        bot.userId = req.requesterUserId;
        bot.username = req.requesterUsername;
        bot.avatar = req.requesterAvatar;
        bot.connected = false; // socketda kirganda true bo'ladi
        bot.items = await loadUserItems(req.requesterUserId);
        bot.shieldActive = false;
        if (g.rejects) delete g.rejects[req.requesterUserId];
        logEvent(g, '🤝', `${req.requesterUsername} o'yinga qo'shildi`, 'playerJoined', { name: req.requesterUsername });
        await saveG(req.gameId, g);
        syncMafiaTeam(g); // mafiya tarkibi o'zgargan bo'lishi mumkin
        io.to(`game:${req.gameId}`).emit('game_state', publicGame(g));
        io.to(req.requesterSocketId).emit('join_approved', { gameId: req.gameId });
      } else {
        g.rejects = g.rejects || {};
        g.rejects[req.requesterUserId] = (g.rejects[req.requesterUserId] || 0) + 1;
        const blocked = g.rejects[req.requesterUserId] >= 3;
        await saveG(req.gameId, g);
        io.to(req.requesterSocketId).emit('join_rejected', { blocked, message: blocked ? 'Rad etildingiz — bu o\'yinga boshqa so\'rov yubora olmaysiz' : 'So\'rovingiz rad etildi' });
      }
    });
  });

  // ===== Xonadan chiqarish (faqat xona egasi) =====
  // Nima uchun faqat `waiting`: o'yin boshlangach o'yinchini chiqarish rollar
  // muvozanatini buzadi (mafiya chiqarilsa shahar avtomatik g'olib bo'ladi).
  // Ketayotgan o'yinda tashlab ketgan o'yinchi allaqachon boshqa mexanizm
  // bilan ishlanadi (abandon/disconnect).
  socket.on('kick_player', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
    if (!guard(socket, 'kick', 12, 10000)) return;
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;
    const g = await getG(gameId);
    if (!g) return;
    if (g.status !== 'waiting') {
      socket.emit('game_error', { code: 'kickOnlyInLobby', message: 'O\'yin boshlanganidan keyin chiqarib bo\'lmaydi' });
      return;
    }
    // Xona egasini userId bo'yicha tekshiramiz: socketId qayta ulanishda o'zgaradi
    if (g.hostId !== d.userId) {
      socket.emit('game_error', { code: 'notHost', message: 'Faqat xona egasi chiqarib yuboradi' });
      return;
    }
    const target = (g.players || []).find(p => p.socketId === targetSocketId);
    if (!target) return;
    if (target.userId === d.userId) return;   // o'zini chiqarib yubormaydi

    g.players = g.players.filter(p => p.socketId !== targetSocketId);
    // Odam qayta kirib olmasin: bu ro'yxat xona tugaguncha saqlanadi.
    // Botlar uchun kerak emas — ular o'zi qaytib kelmaydi.
    if (!isBot(target)) {
      g.kicked = g.kicked || {};
      g.kicked[target.userId] = Date.now();
    }
    await saveG(gameId, g);

    if (!isBot(target)) {
      io.to(targetSocketId).emit('game_closed', { code: 'kicked', message: 'Sizni xona egasi chiqarib yubordi' });
      const ts = io.sockets.sockets.get(targetSocketId);
      if (ts) { ts.leave(`game:${gameId}`); socketData.delete(targetSocketId); }
    }
    // Ovozli chatdan ham chiqaramiz
    voiceLeave(gameId, targetSocketId);
    io.to(`game:${gameId}`).emit('voice_peer_leave', { socketId: targetSocketId });
    io.to(`game:${gameId}`).emit('game_state', publicGame(g));
    logEvent(g, '🚪', `${target.username} xonadan chiqarildi`, 'kicked', { name: target.username });
  }));

  // ===== Ovozli chat signaling =====
  socket.on('voice_join', ({ gameId } = {}) => {
    if (!guard(socket, 'vjoin', 5, 5000)) return;
    // Faqat o'sha xonaning o'yinchisi ovozli seansga qo'shila oladi — ilgari
    // begona odam "arvoh peer" bo'lib kirib, xonadagi socketId'lar ro'yxatini olardi
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;
    const set = voicePeers.get(gameId) || new Set();
    // qo'shiluvchiga mavjud ovozli o'yinchilar ro'yxatini yuboramiz (u ularga ulanadi)
    socket.emit('voice_peers', { peers: [...set] });
    set.add(socket.id);
    voicePeers.set(gameId, set);
  });
  socket.on('voice_leave', ({ gameId } = {}) => {
    // guard + a'zolik: ilgari ikkalasi ham yo'q edi va bitta socket istalgan
    // begona xonaga cheksiz tezlikda 'voice_peer_leave' yog'dira olardi (1→N amplifikatsiya)
    if (!guard(socket, 'vleave', 10, 5000)) return;
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;
    voiceLeave(gameId, socket.id);
    socket.to(`game:${gameId}`).emit('voice_peer_leave', { socketId: socket.id });
  });
  // Yuboruvchi va qabul qiluvchi BIR XIL o'yinning ovozli seansida bo'lishi shart.
  // Busiz istalgan socketId ga signal yuborib, boshqa xonadagi o'yinchiga ulanish
  // yoki uni spamlash mumkin edi.
  function voiceAllowed(to) {
    const d = socketData.get(socket.id);
    if (!d?.gameId || typeof to !== 'string') return false;
    const set = voicePeers.get(d.gameId);
    return !!set && set.has(socket.id) && set.has(to);
  }
  // SDP/ICE ni aniq bir o'yinchiga uzatish (ICE ko'p bo'lishi mumkin — saxiy limit)
  socket.on('voice_signal', ({ to, data } = {}) => {
    if (!guard(socket, 'vsig', 600, 10000)) return; // ICE ko'p bo'lishi mumkin — saxiy
    if (!voiceAllowed(to)) return;
    // SDP/ICE dan boshqa narsa uzatmaymiz: aks holda socket 1MB gacha ixtiyoriy
    // ma'lumotni boshqa o'yinchiga relay qilish kanaliga aylanardi
    if (!data || typeof data !== 'object' || (!data.sdp && !data.ice)) return;
    if (JSON.stringify(data).length > 16000) return;
    io.to(to).emit('voice_signal', { from: socket.id, data });
  });
  // "gapiryapti" indikatori — faqat ruxsat etilgan tinglovchilarga
  socket.on('voice_talk', ({ to, on } = {}) => {
    if (!guard(socket, 'vtalk', 40, 5000)) return;
    if (!Array.isArray(to)) return;
    for (const sid of to.slice(0, 40)) {
      if (voiceAllowed(sid)) io.to(sid).emit('voice_talk', { from: socket.id, on: !!on });
    }
  });

  socket.on('disconnect', async () => {
    console.log(`❌ ${socket.id}`);
    clearIdle(socket);
    PING_MS.delete(socket.id);
    PING_HIST.delete(socket.id);
    // IP ulanish hisobini kamaytiramiz (faqat hisoblangan ommaviy IP uchun)
    const ip = socket.data?.ip;
    if (ip && isPublicIp(ip)) { const n = (ipConns.get(ip) || 1) - 1; if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n); }
    const data = socketData.get(socket.id);
    socketData.delete(socket.id);
    // ovozli chatdan chiqaramiz
    if (data?.gameId) { voiceLeave(data.gameId, socket.id); socket.to(`game:${data.gameId}`).emit('voice_peer_leave', { socketId: socket.id }); }
    if (!data?.gameId) return;
    await withLock(data.gameId, async () => {
      const g = await getG(data.gameId);
      if (!g) return;
      // 🤖 botlar o'yini: o'yinchi belgisini offline qilamiz.
      // Hech qanday ULANGAN odam qolmasa — 15s ichida qaytmasa o'yin o'chadi.
      if (g.vsBots) {
        const me = g.players.find(x => x.socketId === socket.id);
        if (me) { me.connected = false; await saveG(data.gameId, g); }
        io.to(`game:${data.gameId}`).emit('player_offline', { username: data.username });
        io.to(`game:${data.gameId}`).emit('game_state', publicGame(g));
        const anyHuman = g.players.some(x => !x.isBot && x.connected !== false);
        if (!anyHuman) {
          if (botDeleteTimers.has(data.gameId)) clearTimeout(botDeleteTimers.get(data.gameId));
          botDeleteTimers.set(data.gameId, setTimeout(async () => {
            botDeleteTimers.delete(data.gameId);
            if (timers.has(data.gameId)) { clearTimeout(timers.get(data.gameId)); timers.delete(data.gameId); }
            await redis.del(`game:${data.gameId}`, `chat:${data.gameId}`).catch(() => {});
            await prisma.game.delete({ where: { id: data.gameId } }).catch(() => {});
          }, 15000));
        }
        return;
      }
      if (g.status === 'waiting') {
        const leaver = g.players.find(p => p.socketId === socket.id);
        g.players = g.players.filter(p => p.socketId !== socket.id);
        // 👑 Xona egasi chiqib ketdi — aks holda hech kim o'yinni boshlay olmay qolardi
        if (leaver && (leaver.isHost || leaver.userId === g.hostId) && g.players.length) {
          const next = g.players[0];
          g.hostId = next.userId;
          next.isHost = true;
          io.to(next.socketId).emit('you_are_host', {});
          io.to(`game:${data.gameId}`).emit('host_changed', { username: next.username });
        }
        await saveG(data.gameId, g);
        io.to(`game:${data.gameId}`).emit('game_state', publicGame(g));
        io.to(`game:${data.gameId}`).emit('player_left', { username: data.username });
        tgRoomTouch(data.gameId); // guruhdagi e'londa sonni yangilash
        // xona bo'sh qoldi — 2 daqiqada hech kim kirmasa o'chadi
        if (g.players.length === 0) scheduleEmptyCheck(data.gameId);
      } else if (g.status === 'playing') {
        const p = g.players.find(p => p.socketId === socket.id);
        if (p) { p.connected = false; await saveG(data.gameId, g); }
        io.to(`game:${data.gameId}`).emit('player_offline', { username: data.username });
        io.to(`game:${data.gameId}`).emit('game_state', publicGame(g));
        // hech kim qolmadi — 3 daqiqadan keyin o'yin yopiladi
        if (!g.players.some(x => !x.isBot && x.connected !== false)) scheduleAbandonCheck(data.gameId);
      }
    });
  });
});

// ==================== RESTART'DAN KEYIN TIKLASH ====================
// Server qayta ishga tushganda xotiradagi taymerlar yo'qoladi — Redis'dagi
// aktiv o'yinlarni topib, ularning fazasiga qarab taymerlarni qayta o'rnatamiz.
// Shunda restart/crash bo'lsa ham ketayotgan o'yinlar muzlab qolmaydi.
async function recoverTimers() {
  try {
    // KEYS butun Redis'ni bloklaydi (umumiy serverda boshqa loyihalarga ham zarar) —
    // SCAN bilan bo'lib-bo'lib o'qiymiz.
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'game:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    let recovered = 0;
    for (const key of keys) {
      const raw = await redis.get(key).catch(() => null);
      if (!raw) continue;
      let g; try { g = JSON.parse(raw); } catch { continue; }
      if (!g || !g.id) continue;
      const gameId = g.id;

      // Boshlanmagan xonalar: restartdan keyin disconnect hodisasi kelmaydi, ya'ni
      // bo'sh-xona taymeri hech qachon qo'yilmasdi va xona abadiy ro'yxatda qolardi.
      if (g.status === 'waiting') {
        if (!(g.players || []).some(p => !p.isBot)) scheduleEmptyCheck(gameId);
        continue;
      }
      if (g.status !== 'playing') continue;

      // Restartda hamma socket uzilgan — Redis'dagi `connected: true` yolg'on.
      // Tuzatmasak, tashlab ketilgan o'yin abadiy aylanaverardi (hech kim o'lmaydi →
      // checkWin doim null → har fazada saveG TTL ni yangilaydi → zombi xona).
      let touched = false;
      for (const p of g.players || []) {
        if (!p.isBot && p.connected !== false) { p.connected = false; touched = true; }
      }
      if (touched) await saveG(gameId, g);
      scheduleAbandonCheck(gameId);   // 3 daqiqada hech kim qaytmasa yopiladi

      const remain = Math.max(0, (g.phaseEndsAt || 0) - Date.now());
      const phase = g.phase;
      const step = nightStepByPhase(phase);
      // Eski holatda nightStep bo'lmasligi mumkin — fazadan aniqlaymiz,
      // aks holda endNightStep(undefined) NIGHT_STEPS[NaN] ga urilib o'yinni muzlatardi.
      let stepIdx = Number.isInteger(g.nightStep) ? g.nightStep : NIGHT_STEPS.indexOf(step);
      if (step && stepIdx < 0) stepIdx = 0;
      // Holatni tiklaymiz: endNightStep birinchi navbatda `g.nightStep !== idx` ni
      // tekshiradi — normallashtirmasak u darhol qaytib ketib, o'yin muzlab qolardi.
      if (step && g.nightStep !== stepIdx) { g.nightStep = stepIdx; await saveG(gameId, g); }
      const fire = () => {
        if (step) return endNightStep(gameId, stepIdx);
        if (phase === 'day_discussion') return onPhaseEnd(gameId, 'day_discussion');
        if (phase === 'day_results') return startNight(gameId);
        if (phase === 'night_results') return startPhase(gameId, 'day_discussion');
        // noma'lum faza (eski format) — kunduzdan davom ettiramiz
        return startPhase(gameId, 'day_discussion');
      };
      if (timers.has(gameId)) clearTimeout(timers.get(gameId));
      timers.set(gameId, setTimeout(() => withLock(gameId, fire), remain));
      // botlar o'yini bo'lsa — joriy faza bot harakatlarini ham qayta rejalashtiramiz
      if (g.vsBots) {
        if (step) scheduleBotNightStep(gameId, stepIdx);
        else if (phase === 'day_discussion') scheduleBotDay(gameId, g);
      }
      recovered++;
    }
    if (recovered) console.log(`🔄 ${recovered} ta aktiv o'yin taymeri tiklandi`);
  } catch (e) { console.error('recoverTimers:', e.message); }
}

// ==================== START ====================

const PORT = process.env.PORT || 4000;
// Nginx ortida ishlaganda faqat localhost'ga bog'lanish kerak — aks holda port
// tashqi tarmoqqa (router port-forward/firewall teshigi orqali) ochiq qolishi mumkin.
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
if (BIND_HOST === '0.0.0.0' && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  BIND_HOST=0.0.0.0 — port tashqi tarmoqqa ochiq bo\'lishi mumkin.');
  console.warn('   Nginx ortida ishlayotgan bo\'lsangiz .env ga BIND_HOST=127.0.0.1 qo\'ying,');
  console.warn('   aks holda mijoz IP sarlavhalarini soxtalashtirib cheklovlarni chetlab o\'tadi.');
}
httpServer.listen(PORT, BIND_HOST, () => {
  console.log(`
  🎭 MAFIA PLATFORMASI - BACKEND
  ==============================
  🌐 http://localhost:${PORT}
  🏠 Ko'p xona | 👑 Admin panel | 📊 Statistika
  Ready! 🎮
  `);
  loadBans();      // bloklangan hisoblar keshini tiklaymiz
  recoverTimers(); // restart'dan keyin ketayotgan o'yinlarni davom ettiramiz
  if (TG_ADMIN_BOT_TOKEN) {
    tgApi('deleteWebhook', {}).finally(() => tgPoll()); // getUpdates uchun webhook bo'lmasligi kerak
    console.log('🤖 Telegram admin-tasdiq boti ishga tushdi');
  }
});

// ==================== OXIRGI HIMOYA QATLAMI ====================
// Bitta o'yindagi kutilmagan xato butun serverni (va barcha boshqa o'yinlarni)
// yiqitmasligi kerak. Socket.IO listener'ni process.nextTick ichida chaqiradi —
// u yerdagi xato hech qanday try/catch bilan ushlanmaydi va protsessni o'ldiradi.
// Yakka xato butun serverni (va boshqa o'yinlarni) yiqitmasligi kerak.
// LEKIN xato KETMA-KET takrorlansa protsess buzilgan holatda qolgan bo'ladi —
// u holda ataylab chiqamiz va pm2 toza qayta ishga tushiradi.
let fatalCount = 0;
setInterval(() => { fatalCount = 0; }, 60000).unref?.();
function onFatal(kind, e) {
  console.error(`❗ ${kind}:`, e?.stack || e);
  if (++fatalCount >= 10) {
    console.error('❗ Bir daqiqada 10 ta ushlanmagan xato — qayta ishga tushamiz');
    process.exit(1);   // pm2 autorestart ko'taradi
  }
}
process.on('uncaughtException', (e) => onFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => onFatal('unhandledRejection', e));

process.on('SIGTERM', () => httpServer.close(() => { prisma.$disconnect(); redis.disconnect(); }));

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
  chooseDayVote, chooseNightTarget, makeFillerBots, BOT_NAMES,
  // Botlarning gapi va tungi kechikishi — ikkalasi ham sof funksiya (testlari bor)
  nightDelayMs, botChatLine, chooseChatAct, typingMs, weightedPick,
  // Odam gapiga javob, kun boshidagi munosabat, yozish uslubi (2026-09-18)
  styleLine, mentionedPlayers, classifyChat, chooseReaction, chooseDayOpener, pickSpeakers,
} from './bot-ai.js';
import { botAvatar } from './avatar.js';
// O'yin yozuvlari (shikoyat uchun dalil) — disk chegaralari shu modulda.
// `recStore` nomi ATAYLAB: `rec` shikoyat ishlovchisidagi mahalliy o'zgaruvchi
// bilan to'qnashardi.
import * as recStore from './recordings.js';
// Onlayn ko'rsatkichi egri chizig'i — alohida modulda, testlari presence.test.mjs da
import {
  fakeOnlineBase, fakePlayersBase, fakeGamesPlayed, fakeRooms, dueBotGameSlot,
  randomRoomName, pseudoTier,
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
// O'yin tempi va vaqt chegarasi — alohida modulda, testlari pacing.test.mjs da.
// Bir marta jimgina ishlamay qolgan mantiq (startedAt holatga yozilmagan edi),
// shuning uchun endi testlar bilan qulflangan.
import { gameElapsed as pacingElapsed, phaseDuration, isTimeUp, GAME_HARD_MS } from './pacing.js';
// Matn tekshiruvi va tozalash — testlari validate.test.mjs da.
// `<` va `>` HAR QANDAY kelgan matndan olib tashlanadi (to'liq kenglikdagi
// belgilar, HTML mohiyatlari va ko'rinmas belgilar bilan qilingan
// "aylanma yo'llar" ham yopilgan).
import {
  cleanText, cleanDeep, validateNick, validateRoomName, checkChat,
  NICK_MIN, NICK_MAX,
} from './validate.js';


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
// REST xatosi. Ilgari 31 ta ishlovchi `e.message` ni to'g'ridan-to'g'ri
// mijozga qaytarardi (Prisma xatosi jadval/ustun nomlarini oshkor qiladi) va
// serverda HECH QANDAY log qolmasdi — ya'ni nosozlikni keyin topib bo'lmasdi.
function serverFail(res, e, code = 'serverError') {
  console.error('API:', e?.stack || e);
  if (res.headersSent) return;
  res.status(500).json({ code, error: 'Serverda xatolik — birozdan keyin urinib ko\'ring' });
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

// ==================== IXCHAM XOTIRA KESHI ====================
// /api/games ni har bir mijoz 6 soniyada, /api/stats ni 20 soniyada so'raydi.
// Redis keshi bazani himoya qilardi, lekin HAR so'rov baribir Redis'ga borardi
// (tarmoq + JSON). 1-3 soniyalik xotira keshi shu yo'lni ham qisqartiradi:
// 200 o'yinchi bo'lsa sekundiga ~33 so'rov keladi va ularning faqat bittasi
// ish qiladi. Hujumda ham shu kesh zarbaning katta qismini yutadi.
//
// Kesh JUDA kichik (bir nechta kalit) va TTL sekundlar bilan o'lchanadi —
// shuning uchun alohida tozalash jarayoni kerak emas.
// Nomi ATAYLAB `hotCache`: `/health` ichida `const mem = process.memoryUsage()`
// bor va global `mem` uni soyalab, kelajakda chalkashtirib yuborardi.
const hotCache = new Map();
function memGet(key) {
  const v = hotCache.get(key);
  if (!v) return null;
  if (v.exp <= Date.now()) { hotCache.delete(key); return null; }
  return v.val;
}
function memSet(key, val, ttlMs) { hotCache.set(key, { val, exp: Date.now() + ttlMs }); }
function memClear() { hotCache.clear(); }

// ==================== HUJUM REJIMI (PANIC) ====================
// Katta so'rov to'lqini kelganda sayt butunlay yiqilib qolmasligi kerak.
//
// NEGA JARAYON RESTART QILINMAYDI: restart butun jonli o'yinlarni o'ldiradi
// va hujumchi aynan shuni xohlaydi — bir to'lqin yuborib hammani o'yindan
// chiqarib yuborish. Shuning uchun bu yerda TRAFIK to'siladi, o'yin emas:
//   1. har sekundda kelgan so'rovlar sanaladi;
//   2. chegaradan oshsa PANIC yoqiladi: TOKENSIZ so'rovlar darhol 429 bilan
//      (tanasiz javob — eng arzon yo'l) rad etiladi, keshlar BIR MARTA
//      tozalanadi va adminga Telegram xabari ketadi;
//   3. o'yinchilar (haqiqiy tokenli so'rovlar) ishlashda davom etadi;
//   4. to'lqin tinsa PANIC o'zi o'chadi.
// Jarayon haqiqatan javob bermay qolsa — uni watchdog qayta ishga tushiradi
// (u /health ni tekshiradi), ya'ni restart qarori o'lchovga tayanadi.
const PANIC_RPS = parseInt(process.env.PANIC_RPS || '300');          // so'rov/sekund
const PANIC_HOLD_MS = parseInt(process.env.PANIC_HOLD_MS || '45000');
const panic = {
  on: false, until: 0, win: Date.now(), hits: 0,
  peakRps: 0, entered: 0, blocked: 0, manual: false,
};

function panicFlush() {
  // Ortiqcha keshlar bir marta tozalanadi: hujum paytida eskirgan javob
  // tarqatib o'tirishdan ko'ra toza holatdan boshlash yaxshiroq.
  memClear();
  redis.del('cache:games', 'cache:pubstats', 'cache:board').catch(() => {});
}

function panicEnter(rps, manual = false) {
  panic.on = true;
  panic.manual = manual;
  panic.until = Date.now() + PANIC_HOLD_MS;
  panic.entered++;
  panicFlush();
  console.error(`\u{1F6E1} PANIC yoqildi: ${rps} so'rov/sek — tokensiz so'rovlar to'sildi`);
  if (TG_ADMIN_BOT_TOKEN && TG_ADMIN_CHAT_ID) {
    tgApi('sendMessage', {
      chat_id: TG_ADMIN_CHAT_ID,
      text: `\u{1F6E1} <b>Hujum shubhasi</b>\n${rps} so'rov/sekund keldi.\n`
          + `Tokensiz so'rovlar ${Math.round(PANIC_HOLD_MS / 1000)} soniya to'sildi, kesh tozalandi.\n`
          + `O'yinlar to'xtatilmadi.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
}

function panicLeave() {
  if (!panic.on) return;
  console.log(`\u2705 PANIC o'chdi (to'silgan so'rov: ${panic.blocked})`);
  panic.on = false;
  panic.manual = false;
}

// So'rov PANIC paytida o'tishga haqlimi? Faqat haqiqiy tokenli so'rov va
// tekshiruv yo'li. Token HMAC bilan tekshiriladi — mikrosoniyalar oladi.
function panicAllowed(req) {
  if (req.path === '/health') return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  try { jwt.verify(h.slice(7), JWT_SECRET); return true; } catch { return false; }
}

function panicMiddleware(req, res, next) {
  const now = Date.now();
  if (now - panic.win >= 1000) {
    const rps = panic.hits;
    if (rps > panic.peakRps) panic.peakRps = rps;
    panic.win = now;
    panic.hits = 0;
    if (!panic.on && rps > PANIC_RPS) panicEnter(rps);
  }
  panic.hits++;

  if (panic.on) {
    if (!panic.manual && now > panic.until) panicLeave();
    else if (!panicAllowed(req)) {
      panic.blocked++;
      res.setHeader('Retry-After', '30');
      return res.status(429).end();   // tanasiz javob: hujumga eng arzon qarshilik
    }
  }
  next();
}

// `shuttingDown` — SIGTERM boshlangani. Redis 'end' hodisasi shu paytda ham
// keladi va uni ogohlantirish sifatida ko'rsatish kerak emas.
// Yuqorida e'lon qilinadi, chunki redis tinglovchilari undan foydalanadi.
let shuttingDown = false;
const prisma = new PrismaClient();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  // umumiy Redis serverida boshqa loyihalar bilan aralashmaslik uchun alohida DB indeksi
  db: parseInt(process.env.REDIS_DB || '0'),
  retryStrategy: (times) => Math.min(times * 50, 2000),
  // Uzilgan paytda navbat CHEKSIZ o'smasin: 20 ta so'rovdan keyingisi darhol
  // rad etiladi va chaqiruvchidagi .catch() ishlaydi. Busiz uzoq uzilishda
  // minglab kutayotgan promise to'planib, ulanish tiklanganda hammasi
  // birdan otilardi.
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
});

// ⚠️ MAJBURIY: 'error' tinglovchisi.
//
// ioredis EventEmitter'ga tayanadi va Node'da tinglovchisi YO'Q 'error'
// hodisasi PROTSESSNI YIQITADI. Ya'ni Redis bir soniyaga uzilsa (yoki
// parol/DB indeksi noto'g'ri bo'lsa) butun server — barcha jonli o'yinlar
// bilan birga — o'lardi va logda faqat "Unhandled 'error' event" qolardi.
// ioredis o'zi qayta ulanadi, bizga esa faqat shovqinsiz log kerak.
let redisDownAt = 0;
redis.on('error', (e) => {
  if (!redisDownAt) {
    redisDownAt = Date.now();
    console.error('Redis xatosi:', e?.message || e);
  }
});
redis.on('ready', () => {
  if (redisDownAt) {
    console.log(`✅ Redis tiklandi (${Math.round((Date.now() - redisDownAt) / 1000)} s uzilgandi)`);
    redisDownAt = 0;
  }
});
redis.on('end', () => { if (!shuttingDown) console.warn('Redis ulanishi yopildi'); });

app.use(cors());
app.use(express.json({ limit: '800kb' })); // avatar (base64) sig'adi, lekin ulkan payload floodini cheklaydi
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
// PANIC eng oldinda: to'lqin kelganda hech qanday qimmat ish bajarilmasin
app.use(panicMiddleware);

// BURCHAKLI QAVSLARNI OLIB TASHLASH — bitta joyda, hamma yo'l uchun.
// Har bir route o'zi tozalashga tayanib bo'lmaydi: bitta yangi endpoint
// yozilganda u esdan chiqadi va teshik paydo bo'ladi. Shuning uchun
// tozalash so'rov ZANJIRINING boshida turadi.
//
// Avatar (base64) va boshqa uzun satrlar shikast ko'rmaydi: ular ichida
// qavs bo'lmaydi.
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') cleanDeep(req.body);
  if (req.query && typeof req.query === 'object') {
    for (const k of Object.keys(req.query)) {
      if (typeof req.query[k] === 'string') req.query[k] = cleanText(req.query[k], { maxLen: 300 });
    }
  }
  next();
});
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
  // DIQQAT: botlar ham HISOBGA OLINADI. Ilgari ular chiqarib tashlanardi va
  // guruhda "1/14 o'yinchi" ko'rinardi — xonada esa 14 kishi o'ynayotgan
  // bo'lardi. Xabar o'yin haqida haqiqatni aytishi kerak: kim ko'rsa,
  // xonaga kirib o'sha manzarani ko'radi.
  const n = (g.players || []).length;
  const max = g.totalPlayers || g.maxPlayers || 8;
  const name = tgEsc(g.name || 'Mafia xonasi');
  if (g.status === 'finished') {
    const ever = Array.isArray(g.everPlayers) ? g.everPlayers.length : n;
    const total = Math.max(n, ever);
    // Davomiylik va mafiya tarkibi — guruhda o'qigan odam natijani tushunsin.
    // O'yin tugagach rollar baribir ochiq, shuning uchun sir oshkor bo'lmaydi.
    const mins = (g.startedAt && g.endedAt)
      ? Math.max(1, Math.round((new Date(g.endedAt) - new Date(g.startedAt)) / 60000))
      : null;
    const mafia = (g.players || []).filter(p => sideOf(p.role) === 'mafia').map(p => tgEsc(p.username));
    const lines = [
      `\u{1F3C1} <b>${name}</b>`,
      '',
      tgEsc(winnerMessage(g.winner)),
      `\u{1F465} ${total} o'yinchi qatnashdi`,
    ];
    if (mins) lines.push(`⏱ ${mins} daqiqa`);
    if (mafia.length) lines.push(`\u{1F3AD} Mafiya: ${mafia.join(', ')}`);
    return lines.join('\n');
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

  // ===== Hisobni bog'lash: /start <kod> =====
  // Kod saytdagi profil sahifasidan olinadi va 10 daqiqa amal qiladi.
  const payload = String(msg.text || '').split(/\s+/)[1] || '';
  if (payload && /^[A-Za-z0-9_-]{8,40}$/.test(payload)) {
    const key = `tglink:${payload}`;
    // GETDEL: kod BIR MARTA ishlaydi — ikkinchi odam o'sha kod bilan
    // kelsa hech narsa bog'lanmaydi.
    let userId = null;
    try { userId = await redis.getdel(key); } catch { userId = await redis.get(key); await redis.del(key).catch(() => {}); }
    const tgId = String(msg.from?.id || '');
    if (!userId) {
      await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text: '\u23F3 Havola eskirgan yoki allaqachon ishlatilgan.\nSaytdagi profil sahifasidan yangi havola oling.',
      });
      return;
    }
    try {
      // Bitta Telegram hisobi — bitta o'yin hisobi. Band bo'lsa aytamiz.
      const busy = await prisma.user.findFirst({ where: { tgId }, select: { id: true, username: true } });
      if (busy && busy.id !== userId) {
        await tgApi('sendMessage', {
          chat_id: msg.chat.id,
          text: `\u26A0\uFE0F Bu Telegram hisobi allaqachon <b>${tgEsc(busy.username)}</b> hisobiga bog'langan.`,
          parse_mode: 'HTML',
        });
        return;
      }
      const u = await prisma.user.update({
        where: { id: userId },
        data: { tgId, tgUsername: msg.from?.username || null, tgLinkedAt: new Date() },
      });
      const st = profileState(u);
      await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text: `\u2705 <b>Hisob bog'landi!</b>\n\nO'yindagi taxallusingiz: <b>${tgEsc(u.username)}</b>\n`
            + (st.verified
                ? '\u{1F396} Ma\'lumotlaringiz to\'liq — endi profilingizda "Ishonchli" belgisi turadi.'
                : `\u{1F4CB} Profil to'liqligi: <b>${st.percent}%</b> — qolgan ma'lumotlarni saytda to'ldirsangiz "Ishonchli" belgisini olasiz.`),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '\u{1F464} Profilim', url: `${SITE_URL}/profil` }]] },
      });
    } catch (e) {
      console.error('tglink:', e.message);
      await tgApi('sendMessage', { chat_id: msg.chat.id, text: '\u274C Bog\'lashda xatolik. Keyinroq urinib ko\'ring.' });
    }
    return;
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
  const inRoom = (g.players || []).length;
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
  } catch (e) { serverFail(res, e); }
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
  let base = def;
  try {
    const v = await redis.hget('roomlimits', String(userId));
    if (v != null && v !== '') base = Math.max(0, parseInt(v));
  } catch {}
  // Do'kondan olingan qo'shimcha xonalar (faqat bugunga)
  try {
    const extra = parseInt((await redis.get(roomSlotKey(userId))) || '0');
    if (extra > 0) base += extra;
  } catch {}
  return base;
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

// ==================== JAZOLAR (admin choralari) ====================
// Ban — eng og'ir chora va u ko'pincha haddan ortiq. Shikoyat bo'yicha ko'proq
// kerak bo'ladigan narsa NUQTALI chora: odam o'ynay olsin, lekin muammo
// bo'lgan kanaldan vaqtincha chetlatilsin.
//
//   chat   — chatda yoza olmaydi
//   voice  — ovozli chatga umuman ulana olmaydi (mesh'ga kiritilmaydi, ya'ni
//            o'zgartirilgan mijoz ham gapira olmaydi)
//   avatar — profil rasmi hech kimga ko'rsatilmaydi (harf ko'rinadi)
//
// Redis'da `penalty:<userId>` hash, qiymati — TUGASH vaqti (epoch ms).
// Xotirada kesh: tekshiruv chat/ovoz/har `publicPlayers` chaqiruvida bo'ladi,
// ya'ni u SINXRON va arzon bo'lishi shart.
const PENALTY_KINDS = ['chat', 'voice', 'avatar'];
const penaltyCache = new Map();   // userId -> { chat, voice, avatar } (epoch ms)

function penaltyKey(userId) { return 'penalty:' + userId; }

// Sinxron tekshiruv (keshdan). Muddati o'tgan yozuv o'zi e'tiborsiz qoladi.
function hasPenalty(userId, kind) {
  if (!userId) return false;
  const p = penaltyCache.get(String(userId));
  if (!p) return false;
  const until = p[kind];
  return !!until && until > Date.now();
}
function penaltyOf(userId) {
  const p = penaltyCache.get(String(userId)) || {};
  const out = {};
  for (const k of PENALTY_KINDS) if (p[k] && p[k] > Date.now()) out[k] = p[k];
  return out;
}
async function setPenalty(userId, kind, untilMs) {
  if (!PENALTY_KINDS.includes(kind) || !isRealUser(userId)) return null;
  const cur = penaltyCache.get(String(userId)) || {};
  if (untilMs && untilMs > Date.now()) cur[kind] = untilMs; else delete cur[kind];
  if (Object.keys(cur).length) penaltyCache.set(String(userId), cur);
  else penaltyCache.delete(String(userId));
  try {
    if (untilMs && untilMs > Date.now()) {
      await redis.hset(penaltyKey(userId), kind, String(untilMs));
      // Eng uzoq jazodan keyin kalit o'zi yo'qolsin (axlat to'planmasin)
      const max = Math.max(...Object.values(cur));
      await redis.expire(penaltyKey(userId), Math.ceil((max - Date.now()) / 1000) + 3600);
    } else {
      await redis.hdel(penaltyKey(userId), kind);
    }
  } catch {}
  return penaltyOf(userId);
}
// Restartdan keyin keshni tiklaymiz (jazolar yo'qolib ketmasin)
async function loadPenalties() {
  try {
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'penalty:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const uid = k.slice('penalty:'.length);
        const h = await redis.hgetall(k).catch(() => null);
        if (!h) continue;
        const obj = {};
        for (const kind of PENALTY_KINDS) {
          const v = parseInt(h[kind] || '0');
          if (v > Date.now()) obj[kind] = v;
        }
        if (Object.keys(obj).length) { penaltyCache.set(uid, obj); n++; }
      }
    } while (cursor !== '0');
    if (n) console.log(`\u{1F507} ${n} ta amaldagi jazo keshga yuklandi`);
  } catch (e) { console.error('loadPenalties:', e.message); }
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

// Taxallus xatosining O'ZBEKCHA matni. Mijoz `code` ni olib o'z tilida
// ko'rsatadi — bu matn faqat zaxira (API ni to'g'ridan-to'g'ri
// chaqirganlar va loglar uchun).
function nickError(code) {
  return {
    empty: 'Taxallus bo\'sh bo\'lmasin',
    short: `Taxallus kamida ${NICK_MIN} belgi bo\'lishi kerak`,
    long: `Taxallus ${NICK_MAX} belgidan oshmasin`,
    edge: 'Taxallus harf yoki raqam bilan boshlanib, shunday tugashi kerak',
    sep: 'Ketma-ket "_", "." yoki "-" bo\'lmasin',
    chars: 'Faqat harf, raqam va "_", ".", "-" — lotin yoki kirill (aralash emas)',
    digits: 'Taxallus faqat raqamdan iborat bo\'lmasin',
    reserved: 'Bu taxallus band',
  }[code] || 'Taxallus qoidaga mos emas';
}

// ==================== AUTH ROUTES ====================

app.post('/api/register', limitAuth, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.allowPasswordAuth) return res.status(403).json({ error: 'Ro\'yxatdan o\'tish faqat Google orqali' });
    let { username, password } = req.body;
    const nick = validateNick(username);
    if (!nick.ok) {
      return res.status(400).json({ error: nickError(nick.code), code: 'nick_' + nick.code });
    }
    username = nick.value;
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

// Google'dan kelgan ismdan TAXALLUS yasaydi. Natija validateNick()
// qoidalariga mos bo'lishi SHART: aks holda o'yinchi keyin taxallusini
// o'zgartirmoqchi bo'lganda "mavjud nomingiz qoidaga mos emas" degan
// tushunarsiz holatga tushardi.
async function uniqueUsername(base) {
  // Lotin va kirill variantlari alohida yig'iladi va UZUNROG'I olinadi:
  // ism kirill bo'lsa ("Иван Петров") kirill taxallus chiqadi, aralash
  // bo'lsa qoidaga ko'ra faqat bitta yozuv tizimi qoladi.
  const raw = String(base || '').normalize('NFKC');
  const lat = raw.replace(/[^A-Za-z0-9]/g, '');
  const cyr = raw.replace(/[^Ѐ-ӿ0-9]/g, '');
  let candidate = (cyr.length > lat.length ? cyr : lat)
    .replace(/^[0-9]+/, '')          // raqam bilan boshlanmasin
    .slice(0, NICK_MAX);
  while (candidate.length && candidate.length < NICK_MIN) candidate += 'x';
  if (!candidate || !validateNick(candidate).ok) candidate = 'player';

  let username = candidate;
  // band bo'lsa raqam qo'shib ketamiz (uzunlik chegarasini buzmasdan)
  for (let i = 0; i < 50; i++) {
    const taken = await prisma.user.findUnique({ where: { username } });
    if (!taken) return username;
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    username = candidate.slice(0, NICK_MAX - suffix.length) + suffix;
  }
  const tail = Date.now().toString().slice(-6);
  return candidate.slice(0, NICK_MAX - tail.length) + tail;
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
// ==================== PROFIL TO'LIQLIGI VA ISHONCH ====================
// Nega kerak: soxta hisob yasab reytingni buzib yuradigan odam o'zi haqida
// ma'lumot qoldirmaydi. Ma'lumotlari to'liq o'yinchi esa "ishonchli" belgisi
// oladi va u O'YIN ICHIDA ham ko'rinadi — boshqalar kim bilan o'ynayotganini
// biladi. Hech qaysi maydon MAJBURIY emas: o'yin uchun faqat taxallus kerak.
const REGIONS = [
  'uz-tas', 'uz-tk', 'uz-and', 'uz-buk', 'uz-fer', 'uz-jiz', 'uz-xor',
  'uz-nam', 'uz-nav', 'uz-qas', 'uz-qar', 'uz-sam', 'uz-sir', 'uz-sur',
];
// Tartib MUHIM: ro'yxat foydalanuvchiga "nima qoldi" deb ko'rsatiladi va
// eng oson qadam boshida turadi.
//
// Rasm ATAYLAB ro'yxatda yo'q: Google orqali kirganda u avtomatik keladi,
// ya'ni "to'ldirish" qadami emas. Beshta maydonning hammasi profil
// sahifasidagi bitta formada to'ldiriladi.
const PROFILE_FIELDS = ['fullName', 'birthDate', 'region', 'gender', 'tgId'];

function profileState(u) {
  const missing = PROFILE_FIELDS.filter((f) => !u?.[f]);
  const filled = PROFILE_FIELDS.length - missing.length;
  return {
    percent: Math.round((filled / PROFILE_FIELDS.length) * 100),
    filled,
    total: PROFILE_FIELDS.length,
    missing,
    verified: missing.length === 0,
  };
}

// Ism: harf, bo'sh joy, apostrof va chiziqcha. Raqam/emoji o'tmaydi —
// "ismi" o'rniga taxallus yozib qo'yishning ma'nosi yo'q.
const NAME_RE = /^[\p{L}][\p{L}\s'’\-]{1,59}$/u;

function parseBirthDate(v) {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const age = (Date.now() - d.getTime()) / (365.25 * 86400000);
  // 8 dan kichik yoshdagi o'yinchi bo'lmaydi, 100 dan katta yosh esa
  // deyarli har doim xato kiritilgan sana.
  if (age < 8 || age > 100) return null;
  return d;
}

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
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: RATING_START, xp: 0 },
      // Liga — lobbi o'ziga mos xonalarni ajratib ko'rsatishi uchun
      tier: tierOf(u.stats?.rating ?? RATING_START),
      // profil ma'lumotlari va to'liqlik darajasi
      profile: {
        fullName: u.fullName || null,
        birthDate: u.birthDate ? new Date(u.birthDate).toISOString().slice(0, 10) : null,
        region: u.region || null,
        gender: u.gender || null,
        tgUsername: u.tgUsername || null,
        tgLinked: !!u.tgId,
      },
      completion: profileState(u),
      verified: profileState(u).verified,
      perks: await readPerks(u.id),
    });
  } catch (e) { serverFail(res, e); }
});

// ===== PROFIL MA'LUMOTLARINI SAQLASH =====
// Faqat kelgan maydonlar yangilanadi (qismli saqlash): foydalanuvchi
// formani bo'lak-bo'lak to'ldirishi mumkin.
app.patch('/api/me/profile', authMiddleware, limitByUser(30), async (req, res) => {
  try {
    const data = {};
    const b = req.body || {};

    if (b.fullName !== undefined) {
      const v = String(b.fullName || '').trim().replace(/\s+/g, ' ');
      if (!v) data.fullName = null;
      else if (!NAME_RE.test(v)) return res.status(400).json({ error: 'Ism faqat harflardan iborat bo\'lishi kerak' });
      else data.fullName = v;
    }
    if (b.birthDate !== undefined) {
      if (!b.birthDate) data.birthDate = null;
      else {
        const d = parseBirthDate(b.birthDate);
        if (!d) return res.status(400).json({ error: 'Tug\'ilgan sana noto\'g\'ri' });
        data.birthDate = d;
      }
    }
    if (b.region !== undefined) {
      if (!b.region) data.region = null;
      else if (!REGIONS.includes(String(b.region))) return res.status(400).json({ error: 'Viloyat noto\'g\'ri' });
      else data.region = String(b.region);
    }
    if (b.gender !== undefined) {
      if (!b.gender) data.gender = null;
      else if (!['m', 'f'].includes(String(b.gender))) return res.status(400).json({ error: 'Jins noto\'g\'ri' });
      else data.gender = String(b.gender);
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'O\'zgarish yo\'q' });

    const u = await prisma.user.update({ where: { id: req.user.userId }, data });
    res.json({ ok: true, completion: profileState(u), verified: profileState(u).verified });
  } catch (e) { serverFail(res, e); }
});

// ===== TELEGRAM HISOBINI BOG'LASH =====
// Bir martalik kod: 10 daqiqa amal qiladi va ishlatilgach o'chadi. Kod
// Telegram deep-link ichida ketadi (`t.me/bot?start=KOD`), ya'ni odam
// botga bir marta "start" bosadi va hisob bog'lanadi. Parol/kod yozish
// kerak emas — telefonda eng qulay yo'l.
//
// Nega bir martalik: doimiy havola tarqalib ketsa, boshqa odam o'sha
// havoladan foydalanib O'Z Telegramini begona hisobga bog'lab qo'yardi.
let TG_BOT_USERNAME = process.env.TG_BOT_USERNAME || '';
async function tgBotUsername() {
  if (TG_BOT_USERNAME) return TG_BOT_USERNAME;
  const r = await tgApi('getMe', {});
  TG_BOT_USERNAME = r?.result?.username || '';
  return TG_BOT_USERNAME;
}

app.post('/api/me/telegram/link', authMiddleware, limitByUser(10), async (req, res) => {
  try {
    if (!TG_ADMIN_BOT_TOKEN) return res.status(503).json({ error: 'Telegram bot sozlanmagan' });
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId }, select: { tgId: true },
    });
    if (u?.tgId) return res.status(409).json({ error: 'Telegram allaqachon bog\'langan' });

    const bot = await tgBotUsername();
    if (!bot) return res.status(503).json({ error: 'Bot nomi aniqlanmadi' });

    // Kod URL-xavfsiz va taxmin qilib bo'lmaydigan bo'lishi kerak
    const code = crypto.randomBytes(9).toString('base64url');
    await redis.set(`tglink:${code}`, req.user.userId, 'EX', 600);
    res.json({
      url: `https://t.me/${bot}?start=${code}`,
      expiresIn: 600,
    });
  } catch (e) { serverFail(res, e); }
});

app.delete('/api/me/telegram', authMiddleware, limitByUser(10), async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { tgId: null, tgUsername: null, tgLinkedAt: null },
    });
    const u = await prisma.user.findUnique({ where: { id: req.user.userId } });
    res.json({ ok: true, completion: profileState(u) });
  } catch (e) { serverFail(res, e); }
});

// 🛒 do'kon — tangaga item sotib olish
app.post('/api/shop/buy', authMiddleware, limitByUser(40), async (req, res) => {
  try {
    const { item } = req.body;

    // ===== Hisob imkoniyatlari (o'yin buyumi emas) =====
    if (PERK_KEYS.includes(item)) {
      const price = ECONOMY.prices[item];
      const userId = req.user.userId;
      const out = await withLock(`user:${userId}`, async () => {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
        if (!u) return { err: 404 };
        if ((u.coins ?? 0) < price) return { err: 402 };
        const upd = await prisma.user.update({
          where: { id: userId }, data: { coins: { decrement: price } }, select: { coins: true },
        });
        if (item === 'xpBoost') {
          await redis.incr(xpBoostKey(userId));
        } else {
          // Kun oxirigacha amal qiladi: TTL bugundan ertaga o'tishda tugaydi
          await redis.incr(roomSlotKey(userId));
          await redis.expire(roomSlotKey(userId), 36 * 3600);
        }
        logActivity(userId, 'shop_buy', { item, amount: -price, detail: `Do'kondan ${item} olindi` });
        return { coins: upd.coins };
      });
      if (out?.err === 404) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
      if (out?.err === 402) return res.status(400).json({ error: 'Tanga yetarli emas' });
      const perks = await readPerks(req.user.userId);
      const u2 = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { items: true } });
      return res.json({ coins: out.coins, items: normItems(u2?.items), perks });
    }

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
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
});

// 📜 o'yin tarixi (oxirgi 20 ta)
app.get('/api/me/history', authMiddleware, async (req, res) => {
  try {
    const list = await prisma.gameHistory.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }, take: 20
    });
    res.json(list.map(h => ({ role: h.role, won: h.won, winner: h.winner, coins: h.coins, createdAt: h.createdAt })));
  } catch (e) { serverFail(res, e); }
});

// 👤 profilni tahrirlash — nikname va rasm. Bo'sh nikname mumkin emas.
app.put('/api/me/profile', authMiddleware, limitByUser(15), async (req, res) => {
  try {
    let { username, avatar } = req.body;
    const data = {};
    if (username !== undefined) {
      const nick = validateNick(username);
      if (!nick.ok) {
        return res.status(400).json({ error: nickError(nick.code), code: 'nick_' + nick.code });
      }
      username = nick.value;
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
    serverFail(res, e);
  }
});

// reyting jadvali (public) — pagination
app.get('/api/leaderboard', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
    // 15 soniyalik xotira keshi: jadval har so'rovda to'liq `count` + `findMany`
    // qilardi va ochiq endpoint bo'lgani uchun uni istalgancha urish mumkin edi.
    // Reyting sekundlar ichida o'zgarmaydi — eskirish sezilmaydi.
    const ck = `board:${page}:${limit}`;
    const hot = memGet(ck);
    if (hot) return res.json(hot);
    // Bloklangan hisoblar va bir-ikki o'yin o'ynagan tasodifiy natijalar
    // jadvalda turmasin: birinchisi adolatsiz (ban olgan odam tepada qoladi),
    // ikkinchisi esa jadvalni ma'nosiz qiladi — bitta g'alaba bilan yuqori
    // reyting olib, keyin umuman o'ynamaslik eng oson "strategiya" edi.
    const BOARD_MIN_GAMES = 3;
    const where = { gamesPlayed: { gte: BOARD_MIN_GAMES }, user: { isBanned: false } };
    const total = await prisma.userStats.count({ where });
    const rows = await prisma.userStats.findMany({
      where,
      orderBy: [{ rating: 'desc' }, { gamesWon: 'desc' }],
      skip: (page - 1) * limit, take: limit,
      include: { user: { select: { username: true } } }   // avatar yo'q — payload yengil
    });
    const payload = {
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      // Liga va daraja SERVERDA hisoblanadi: chegaralar bitta joyda
      // (progression.js) turishi kerak, aks holda frontend bilan
      // bir-biriga mos kelmay qoladi.
      players: rows.map((s, i) => ({
        rank: (page - 1) * limit + i + 1,
        username: s.user.username, rating: s.rating,
        gamesPlayed: s.gamesPlayed, gamesWon: s.gamesWon, winRate: s.winRate,
        xp: s.xp || 0, level: levelFromXp(s.xp || 0), tier: tierOf(s.rating),
      })),
    };
    memSet(ck, payload, 15000);
    res.json(payload);
  } catch (e) { serverFail(res, e); }
});

// Liga chegaralari (public). /reyting sahifasidagi jadval shundan chiziladi —
// chegaralar frontendda TAKRORLANMASIN, aks holda biri o'zgarganda ikkinchisi
// jimgina noto'g'ri ko'rsatib turardi.
app.get('/api/tiers', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ start: RATING_START, tiers: TIERS });
});

// joriy foydalanuvchining reytingdagi o'rni
app.get('/api/me/rank', authMiddleware, limitByUser(60), async (req, res) => {
  try {
    // 15 soniyalik kesh: profil sahifasi buni tez-tez so'raydi va har so'rov
    // ikkita to'liq `count()` qilardi. O'rin sekundlar ichida o'zgarmaydi.
    const ck = 'rank:' + req.user.userId;
    const hot = memGet(ck);
    if (hot) return res.json(hot);
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
    const payload = {
      rank: higher + 1, total, rating,
      gamesPlayed: s?.gamesPlayed ?? 0, gamesWon: s?.gamesWon ?? 0, winRate: s?.winRate ?? 0,
      // daraja
      level: lv.level, xp: lv.xp, into: lv.into, need: lv.need,
      xpLeft: lv.left, percent: lv.percent,
      // liga
      tier: tr.tier, next: tr.next, tierPercent: tr.percent, tierLeft: tr.left,
    };
    memSet(ck, payload, 15000);
    res.json(payload);
  } catch (e) { serverFail(res, e); }
});

// ==================== GAME REST ROUTES ====================

// Oddiy holat — watchdog va nginx uchun. Batafsil raqamlar faqat admin kaliti bilan:
// ochiq ko'rsatilsa hujumchi himoya chegaralarini o'lchab olardi.
// Bog'liqliklar holati — 5 soniya keshlanadi (watchdog har 15 s so'raydi).
//
// NEGA 503 QAYTARMAYMIZ: watchdog 3 ta muvaffaqiyatsiz javobdan keyin
// jarayonni RESTART qiladi, restart esa barcha jonli o'yinlarni o'ldiradi.
// Postgres yoki Redis qisqa uzilib qolsa restart yordam bermaydi (ioredis va
// Prisma o'zi qayta ulanadi), faqat zarar qiladi. Shuning uchun /health
// "ok" bo'lib qolaveradi, holat esa kalitli javobda ko'rinadi va buzilish
// boshlanganda adminga Telegram xabari ketadi.
let depCache = { at: 0, ok: true, redis: 'ok', db: 'ok' };
let depAlerted = false;
async function depCheck() {
  if (Date.now() - depCache.at < 5000) return depCache;
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  const out = { at: Date.now(), ok: true, redis: 'ok', db: 'ok' };
  try { await Promise.race([redis.ping(), timeout(1500)]); } catch { out.redis = 'xato'; out.ok = false; }
  try { await Promise.race([prisma.$queryRaw`SELECT 1`, timeout(1500)]); } catch { out.db = 'xato'; out.ok = false; }
  depCache = out;
  if (!out.ok && !depAlerted) {
    depAlerted = true;
    console.error(`\u{26A0} Bog'liqlik uzildi — redis: ${out.redis}, postgres: ${out.db}`);
    if (TG_ADMIN_BOT_TOKEN && TG_ADMIN_CHAT_ID) {
      tgApi('sendMessage', {
        chat_id: TG_ADMIN_CHAT_ID,
        text: `\u{26A0} <b>Bog'liqlik uzildi</b>\nRedis: ${out.redis}\nPostgres: ${out.db}\n`
            + `Server ishlashda davom etyapti (restart qilinmadi).`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  }
  if (out.ok && depAlerted) {
    depAlerted = false;
    console.log("\u2705 Bog'liqliklar tiklandi");
  }
  return out;
}

app.get('/health', async (req, res) => {
  const base = { status: 'ok' };
  const key = req.query.key || req.headers['x-admin-key'];
  if (!ADMIN_ACCESS_KEY || key !== ADMIN_ACCESS_KEY) {
    // Kalitsiz so'rov ham bog'liqlikni tekshiradi (natija keshlanadi), lekin
    // javob o'zgarmaydi: hujumchi holatimizni o'lchay olmasin.
    depCheck().catch(() => {});
    return res.json(base);
  }
  const dep = await depCheck().catch(() => ({ ok: false, redis: '?', db: '?' }));
  const mem = process.memoryUsage();
  res.json({
    ...base,
    uptimeSec: Math.round(process.uptime()),
    bogliqliklar: { soz: dep.ok, redis: dep.redis, postgres: dep.db },
    oyinlar: { taymerlar: timers.size, qulflar: chains.size, xonalar: voiceCtx.size },
    // Disk: yozuvlar nazoratdan chiqmayotganini shu yerdan ko'rish mumkin
    yozuvlar: recStore.stats(),
    jazolar: penaltyCache.size,
    sockets: { ochiq: io.engine.clientsCount, chegara: MAX_TOTAL_SOCKETS, ipLar: ipConns.size },
    ramMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    // rad etilgan ulanishlar (server ishga tushgandan beri)
    radEtilgan: {
      panic: panic.on ? 'YONIQ' : 'o\'chiq',
      panicSoni: panic.entered,
      panicToSilgan: panic.blocked,
      eng_yuqori_rps: panic.peakRps,
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
    // 1-qadam: xotira keshi (Redis'ga ham bormaydi)
    const hot = memGet('stats');
    if (hot) return res.json(hot);
    const cached = await redis.get('cache:pubstats').catch(() => null);
    if (cached) { const v = JSON.parse(cached); memSet('stats', v, 3000); return res.json(v); }

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
    memSet('stats', data, 3000);
    res.json(data);
  } catch (e) { serverFail(res, e); }
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
  updateVoiceCtx(gameId, g);   // ovoz guruhlari (sof xotira — arzon)
  await redis.set(`game:${gameId}`, JSON.stringify(g), 'EX', 86400);
}

// ==================== OVOZ: KIM KIMNI ESHITADI ====================
// Himoyaning ASOSIY qatlami mijozda qoladi va shunday bo'lishi kerak: mafiya
// tunda `replaceTrack(null)` bilan tinch aholiga ovoz OQIMINI umuman
// yubormaydi, ya'ni o'zgartirilgan mijoz ham eshitolmaydi (mesh WebRTC da
// server oqimni ko'rmaydi — buni faqat SFU qila olardi).
//
// Lekin "gapiryapti" indikatori SERVERDAN o'tadi va u umuman tekshirilmasdi:
// o'zgartirilgan mijoz tunda kim gapirayotganini ko'rib, mafiyani ro'yxatdan
// aniqlab olishi mumkin edi. Shu sababli indikator endi shu jadval bo'yicha
// filtrlanadi. Jadval `saveG` da yangilanadi — ya'ni har doim joriy holat.
const voiceCtx = new Map();   // gameId -> { night, alive:Set, mafia:Set }
// Xonadagi TIRIK botlar surati — soxta ping uchun.
//
// `pingCycle` har 3 soniyada har bir xonaning BUTUN holatini Redis'dan o'qib
// JSON.parse qilardi (50 xona = sekundiga ~17 ta to'liq parse) — faqat botlar
// ro'yxatini bilish uchun. Ro'yxat holat saqlanganda bir marta yig'iladi.
const gameBots = new Map();   // gameId -> [{ socketId, persona }]
function updateVoiceCtx(gameId, g) {
  if (!g) { voiceCtx.delete(gameId); gameBots.delete(gameId); return; }
  const night = String(g.phase || '').startsWith('night');
  const alive = new Set(), mafia = new Set();
  const bots = [];
  for (const p of g.players || []) {
    if (p.isAlive !== false) alive.add(p.socketId);
    if (sideOf(p.role) === 'mafia') mafia.add(p.socketId);
    if (p.isBot === true && p.isAlive !== false) {
      if (!p.persona) p.persona = makePersona(p.userId || p.socketId);
      bots.push({ socketId: p.socketId, persona: p.persona });
    }
  }
  voiceCtx.set(gameId, { night, alive, mafia });
  if (bots.length) gameBots.set(gameId, bots); else gameBots.delete(gameId);
}
function canHearVoice(gameId, fromSid, toSid) {
  const c = voiceCtx.get(gameId);
  if (!c) return true;                                  // ma'lumot yo'q — to'smaymiz
  const fromAlive = c.alive.has(fromSid);
  const toAlive = c.alive.has(toSid);
  if (!fromAlive) return !toAlive;                      // o'lik faqat o'liklarga
  if (!toAlive) return true;                            // o'lik hammani eshitadi
  if (!c.night) return true;                            // kunduzi hamma eshitadi
  return c.mafia.has(fromSid) && c.mafia.has(toSid);     // tunda faqat mafiya
}

// barcha aktiv xonalar ro'yxati
app.get('/api/games', async (_, res) => {
  try {
    // Ikki qatlamli kesh: xotira (1.5s) -> Redis (3s) -> haqiqiy ish.
    // Xotira qatlami uchta frontend instansiyasi uchun alohida, lekin u
    // shunchaki Redis so'rovini tejaydi — ma'lumot baribir 3 soniyada
    // yangilanadi, ya'ni instansiyalar bir-biridan uzoqlashib ketmaydi.
    const hot = memGet('games');
    if (hot) return res.json(hot);
    const cached = await redis.get('cache:games').catch(() => null);
    if (cached) { const v = JSON.parse(cached); memSet('games', v, 1500); return res.json(v); }

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
        // Bot ochgan xonada xom `hostId` 'bot-' prefiksini oshkor qilardi
        hostId: publicHostId({ hostId: g.hostId, players: state?.players || [] }),
        createdAt: g.createdAt,
        phase: state?.phase || 'waiting',
        // Liga — o'yinchi o'ziga MOS xonani ko'rib tanlashi uchun. Odam
        // o'ynayotgan xonada haqiqiy reytingdan, bot bilan to'lgan xonada
        // barqaror pseudo-ligadan olinadi. Maydon HAMMA xonada bo'lishi
        // shart: ba'zisida bo'lib ba'zisida bo'lmasa, aynan shu farq bot
        // xonasini oshkor qilardi.
        tier: roomTier(state, g.id),
        // DIQQAT: `p.userId` EMAS, `p.publicId`. Bot userId'si 'bot-' bilan
        // boshlanadi va u ochiq ro'yxatda ko'rinsa, xonadagi botlar darhol
        // bilinib qolardi (butun "botlar odamga o'xshasin" talabi buzilardi).
        // Haqiqiy o'yinchining ichki ID si ham tashqariga chiqmasligi kerak.
        players: (state?.players || []).map(p => ({
          userId: p.publicId || p.userId, username: p.username, isAlive: p.isAlive,
        })),
        // Lobbi kartasida "kim kirdi / kim chiqdi" — o'yinchi xonaga
        // kirmasdan ham u tirik ekanini ko'radi.
        events: lobbyEvents(state),
      };
    }));
    // Lobbi bo'sh ko'rinmasin: soxta xonalar qo'shiladi. Ularning HAMMASI
    // to'lgan yoki jangda — ya'ni qo'shilib bo'lmaydi (frontend bunday
    // xonaning tugmasini o'zi bloklaydi). Sabab: soxta xona ID si haqiqiy
    // emas, unga kirmoqchi bo'lgan odam "Xona topilmadi" xatosini ko'rardi.
    // Haqiqiy xonalar tepada turadi — odamlar bir-birini topa olsin.
    const real = enriched.filter(Boolean);
    const list = dedupeLobbyNames(real, fakeRooms(Date.now(), FAKE_ONLINE));
    await redis.set('cache:games', JSON.stringify(list), 'EX', 3).catch(() => {});
    memSet('games', list, 1500);
    res.json(list);
  } catch (e) { serverFail(res, e); }
});

// Lobbi bo'ylab TAXALLUSLAR takrorlanmasin.
//
// Ikki mustaqil manba bor: HAQIQIY xonalarni to'ldiruvchi botlar (bot-ai.js —
// BOT_NAMES) va ro'yxatga qo'shiladigan soxta xonalar (presence.js —
// PLAYER_NAMES). Har biri o'z ichida takrorlanmaydi, lekin ikki ro'yxat
// kesishadi — natijada bitta taxallus lobbining ikki xonasida BIR VAQTDA
// ko'rinardi. Jonli saytda bunday bo'lmaydi va buni payqash oson.
//
// Faqat SOXTA xonaning o'yinchilari qayta nomlanadi: ularning nomi shunchaki
// ko'rsatiladi, hech qanday holatga bog'lanmagan. Haqiqiy xonadagi nom esa
// o'yin holatining o'zi — uni javobda o'zgartirish xona ichidagi ko'rinish
// bilan ziddiyat yaratardi.
//
// Haqiqiy xonalar birinchi kelgani uchun ularning nomlari HAR DOIM ustun:
// soxta xonalardagi nom o'zgarishi faqat haqiqiy xonalar o'zgarganda sodir
// bo'ladi, ya'ni ro'yxat har yangilanishda sakrab turmaydi.
function dedupeLobbyNames(realRooms, fakeRoomsList) {
  const taken = new Set();
  for (const r of realRooms) for (const p of r.players || []) taken.add(String(p.username).toLowerCase());
  for (const r of fakeRoomsList) {
    for (const p of r.players || []) {
      const low = String(p.username).toLowerCase();
      if (!taken.has(low)) { taken.add(low); continue; }
      // Band bo'lmagan birinchi zaxira nomni olamiz (barqaror tartibda)
      const free = BOT_NAMES.find((n) => !taken.has(n.toLowerCase()));
      p.username = free || (p.username + crypto.randomInt(10, 99));
      taken.add(String(p.username).toLowerCase());
    }
  }
  return [...realRooms, ...fakeRoomsList];
}

// Kutayotgan xonaning jurnalidan oxirgi kirish/chiqish hodisalarini
// oladi. Faqat KUTISH holatida: o'yin boshlangach lobbi kartasida bu
// ma'lumotning ma'nosi yo'q (xonaga kira olmaysiz).
//
// Bot ham, odam ham bir xil ko'rinadi — jurnalda faqat taxallus bor.
function lobbyEvents(state) {
  if (!state || state.status !== 'waiting') return [];
  const log = Array.isArray(state.log) ? state.log : [];
  const out = [];
  for (let i = log.length - 1; i >= 0 && out.length < 3; i--) {
    const e = log[i];
    // `logEvent` yozuvda `code` maydonini saqlaydi, `reason` emas — shuning
    // uchun bu tekshiruv HECH QACHON rost bo'lmasdi va lobbi kartasidagi
    // "kim kirdi / kim chiqdi" lentasi har doim bo'sh qolardi.
    const t = e?.code === 'playerJoined' ? 'join' : e?.code === 'playerLeft' ? 'leave' : null;
    if (!t) continue;
    const name = e?.args?.name;
    if (!name) continue;
    out.push({ n: name, t, s: Math.max(1, Math.round((Date.now() - (e.at || Date.now())) / 1000)) });
  }
  return out;
}

// ===== SOXTA XONANI OCHISH =====
// Lobbidagi soxta xonaning ID si haqiqiy emas — unga to'g'ridan-to'g'ri
// kirmoqchi bo'lgan odam "Xona topilmadi" xatosini ko'rardi. Shuning uchun
// bosilganda shu yerga so'rov keladi va server AYNI SHU nom bilan haqiqiy
// bot xonasi yaratib beradi: odam o'zi ko'rgan xonaga kirgan bo'ladi.
//
// Bir xonaga bir necha odam bossa — hammasi BITTA haqiqiy xonaga tushadi
// (moslik Redis'da 20 daqiqa saqlanadi).
// Bitta odam ketma-ket bosib lobbini xonalar bilan to'ldirib yubormasligi
// kerak: har bosishda haqiqiy xona yaratilardi va bitta foydalanuvchi
// maxRooms (50) chegarasini yakka o'zi yeb qo'yishi mumkin edi.
// Shuning uchun ikki to'siq:
//   1. daqiqada 6 ta so'rov (limitByUser);
//   2. KUTAYOTGAN bot xonalari 8 tadan oshsa yangisi yaratilmaydi —
//      odam mavjud bo'sh xonalardan biriga yuboriladi.
const OPEN_WAITING_CAP = 8;

// Limit 6 -> 25: lobbi endi HAR QANDAY xonaga bosilganda shu endpointni
// chaqiradi (ilgari faqat soxta xonalar uchun chaqirilardi). 6 ta so'rov bir
// necha xonani ko'rib chiqqan odamni ham bloklab qo'yardi.
// Yangi HAQIQIY xona yaratish baribir OPEN_WAITING_CAP bilan cheklangan.
app.post('/api/games/:id/open', authMiddleware, limitByUser(25), async (req, res) => {
  try {
    const fid = String(req.params.id || '');

    // HAQIQIY xona bo'lsa — shu ID ning o'zini qaytaramiz.
    //
    // NEGA: lobbi endi HAR QANDAY xonaga bosilganda shu endpointni chaqiradi.
    // Ilgari frontend javobdagi `fake: true` belgisiga qarab qaror qilardi va
    // aynan shu belgi soxta xonalarni oshkor qilardi. Qaror endi serverda:
    // mijoz qaysi xona soxta ekanini umuman bilmaydi.
    const real = await prisma.game.findUnique({ where: { id: fid } }).catch(() => null);
    if (real) {
      if (real.status === 'finished') return res.status(404).json({ error: 'notFound' });
      return res.json({ id: real.id });
    }

    // ID shu paytdagi soxta xonalardan birimi? (o'tgan slot ham hisobga
    // olinadi: odam ro'yxatni bir daqiqa oldin ochgan bo'lishi mumkin)
    const now = Date.now();
    const pool = [...fakeRooms(now, FAKE_ONLINE), ...fakeRooms(now - 7 * 60000, FAKE_ONLINE)];
    const room = pool.find((r) => r.id === fid);
    if (!room) return res.status(404).json({ error: 'notFound' });

    const mapKey = `fakeroom:${fid}`;
    const existing = await redis.get(mapKey).catch(() => null);
    if (existing) {
      const g = await prisma.game.findUnique({ where: { id: existing } }).catch(() => null);
      if (g && g.status === 'waiting') return res.json({ id: existing });
    }

    const settings = await getSettings();
    const active = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
    if (active >= (settings.maxRooms || 50)) return res.status(503).json({ error: 'tooManyRooms' });

    // Kutayotgan ochiq xonalar juda ko'p bo'lsa — yangisini yaratmaymiz,
    // eng yangisiga yuboramiz. O'yinchi uchun natija bir xil: u bo'sh joyi
    // bor xonaga tushadi.
    const waiting = await prisma.game.findMany({
      where: { status: 'waiting', isPrivate: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: OPEN_WAITING_CAP + 1,
    }).catch(() => []);
    if (waiting.length > OPEN_WAITING_CAP) {
      // Kutayotgan xona ko'p — yangisini yaratmaymiz. Qaysi biriga yuborishni
      // RETING hal qiladi: ilgari shunchaki eng yangisi berilardi va kuchli
      // o'yinchi yangi boshlovchilar orasiga tushib qolardi.
      const rating = await myRating(req.user.userId);
      const best = await pickRoomForRating(rating, { userId: req.user.userId });
      // Ilgari bu yerda `best || waiting[0].id` edi: `pickRoomForRating` RAD
      // ETGAN xona (to'lgan, boshlanayotgan yoki bizni chiqarib yuborgan)
      // baribir qaytarilardi. Mos xona bo'lmasa yangisini ochgan ma'qul.
      if (best) return res.json({ id: best });
    }

    const id = await startBotGame({ name: room.name, totalPlayers: room.totalPlayers, quick: true });
    if (!id) return res.status(503).json({ error: 'busy' });
    await redis.set(mapKey, id, 'EX', 20 * 60).catch(() => {});
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== TEZ O'YIN: reytingga mos xonaga tushirish =====
//
// O'yinchi ro'yxatni ko'rib o'tirmasdan darhol o'ynashni xohlaydi. Server
// unga KUCHI YAQIN odamlar bor xonani tanlab beradi; bunday xona bo'lmasa
// bot bilan to'ldiriladigan yangisini ochadi.
app.post('/api/games/quick', authMiddleware, limitByUser(20), async (req, res) => {
  try {
    const rating = await myRating(req.user.userId);
    const id = await pickRoomForRating(rating, { userId: req.user.userId });
    if (id) return res.json({ id, mos: true });

    // Mos xona yo'q — yangisini ochamiz (umumiy chegara amal qiladi)
    const settings = await getSettings();
    const active = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
    if (active >= (settings.maxRooms || 50)) return res.status(503).json({ error: 'tooManyRooms' });
    const fresh = await startBotGame({ quick: true });
    if (!fresh) return res.status(503).json({ error: 'busy' });
    res.json({ id: fresh, mos: false });
  } catch (e) { serverFail(res, e); }
});

// Xona nomi: tozalangan va cheklangan. Bo'sh yoki qoidaga mos kelmasa —
// egasining taxallusidan yasaladi (o'yinchi nom yozishga majbur emas).
function roomName(raw, owner) {
  const r = validateRoomName(raw);
  if (r.ok) return r.value;
  return cleanText(`${owner} xonasi`, { maxLen: 40 });
}

// yangi xona yaratish (ko'p xona ruxsat etilgan)
app.post('/api/games', authMiddleware, limitByUser(30), async (req, res) => {
  try {
    const settings = await getSettings();
    const activeCount = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
    if (activeCount >= (settings.maxRooms || 50)) {
      return res.status(429).json({ error: 'Xonalar limiti to\'ldi. Keyinroq urinib ko\'ring.' });
    }

    // KUNLIK LIMIT — o'chirilmaydigan hisoblagichda (roomsCreatedToday).
    // Jonli COUNT ishlatilganda xonani o'chirish limitni qaytarardi.
    const todayCount = await roomsCreatedToday(req.user.userId);
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
        name: roomName(name, req.user.username),
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
    await bumpRoomsCreated(req.user.userId);   // kunlik hisob (o'chirish bilan qaytmaydi)
    if (fillers.length) scheduleBotJoins(game.id, fillers);
    scheduleEmptyCheck(game.id); // 2 daqiqa ichida ODAM kirmasa o'chadi
    tgRoomAnnounce(game.id).catch(() => {}); // Telegram guruhiga e'lon (ochiq xonalar)
    res.json(game);
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
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
        // DIQQAT: `p.userId` EMAS, `p.publicId`. Bot userId'si 'bot-' bilan
        // boshlanadi va u ochiq ro'yxatda ko'rinsa, xonadagi botlar darhol
        // bilinib qolardi (butun "botlar odamga o'xshasin" talabi buzilardi).
        // Haqiqiy o'yinchining ichki ID si ham tashqariga chiqmasligi kerak.
        players: (state?.players || []).map(p => ({
          userId: p.publicId || p.userId, username: p.username, isAlive: p.isAlive,
        }))
      };
    }));
    res.json(enriched.filter(Boolean));
  } catch (e) { serverFail(res, e); }
});

// foydalanuvchi FAQAT o'z xonasini o'chira oladi
app.delete('/api/games/:id', authMiddleware, limitByUser(20), async (req, res) => {
  try {
    const id = req.params.id;
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Xona topilmadi' });
    if (game.hostId !== req.user.userId) return res.status(403).json({ error: 'Faqat o\'z xonangizni o\'chira olasiz' });
    // KETAYOTGAN o'yinni o'chirib bo'lmaydi. Ilgari mumkin edi va bu ikki narsani
    // buzardi: (1) yutqazayotgan host bir tugma bilan endGame/recordStats ni
    // chetlab o'tib mag'lubiyatdan qutulardi; (2) o'sha xonadagi QOLGAN haqiqiy
    // o'yinchilarning to'plangan reyting/tanga/XP si yo'q bo'lardi — ular hech
    // narsa qilmagan holda. O'yin tugagach xona baribir o'chadi.
    if (game.status === 'playing') {
      return res.status(409).json({ code: 'gameRunning', error: 'O\'yin ketyapti — tugagandan keyin o\'chirishingiz mumkin' });
    }
    io.to(`game:${id}`).emit('game_closed', { code: 'hostClosed', message: 'Xona egasi xonani yopdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    // guruhdagi e'lonni "o'chirildi" holatiga keltiramiz (redis o'chishidan OLDIN o'qiymiz)
    const hostG = await getG(id);
    tgRoomCancel(id, hostG, 'xona egasi yopdi').catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    await prisma.game.delete({ where: { id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { serverFail(res, e); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const g = await getG(req.params.id);
    if (!g) return res.status(404).json({ error: 'Xona topilmadi yoki tugagan' });
    res.json(publicGame(g));
  } catch (e) { serverFail(res, e); }
});

// ==================== SHIKOYAT VA DALIL ====================
//
// TURLAR. Bo'sh matn o'rniga aniq tur tanlanadi: admin yuzlab shikoyatni
// o'qib chiqmasdan ham qaysi kanalga qarash kerakligini biladi (ovoz yozuvimi,
// chat tariximi, profil rasmimi).
const REPORT_TYPES = ['voice_abuse', 'chat_abuse', 'avatar', 'nickname', 'cheating', 'afk', 'other'];
const REPORT_LABEL = {
  voice_abuse: 'Ovozli chatda so\'kindi',
  chat_abuse: 'Chatda so\'kindi / haqorat',
  avatar: 'Nomaqbul profil rasmi',
  nickname: 'Nomaqbul taxallus',
  cheating: 'Aldov / rol sotish',
  afk: 'O\'yinni tashlab ketdi',
  other: 'Boshqa',
};
// FLOOD HIMOYASI: bitta odamga kuniga BIR MARTA, kuniga ko'pi bilan 20 ta
// TURLI odamga. Ya'ni haqiqiy shikoyat qilish erkin, lekin bitta odamni
// ko'pchilik bo'lib ko'mib tashlash yoki bir kishini qayta-qayta bosish yo'q.
const REPORT_DAILY_TARGETS = Math.max(1, parseInt(process.env.REPORT_DAILY || '20'));
const repDayKey = (userId) => `rep:by:${userId}:${dayKeySuffix()}`;
const repGameKey = (gameId) => `rep:game:${gameId}`;

// Shikoyatsiz o'yin yozuvi shuncha vaqtdan keyin o'chadi. Darhol emas:
// o'yinchi NATIJA EKRANIDAN ham shikoyat qilishi mumkin.
const REC_GRACE_MS = Math.max(30000, parseInt(process.env.RECORD_GRACE_MS || '180000'));
// Chat takrorini tekshirish uchun oxirgi xabarlar. Ilgari bu `g.chatRecent`
// ichida turardi, lekin `g` har xabarda Redis'dan QAYTA o'qilardi va bu
// maydon hech qachon `saveG` bilan saqlanmasdi — ya'ni takror qoidasi
// umuman ishlamasdi. Ma'lumot o'tkinchi, holatga yozilishi shart emas.
const chatRecent = new Map();   // userId -> oxirgi 3 ta xabar
function recentOf(userId) { return chatRecent.get(userId) || []; }
function pushRecent(userId, text) {
  chatRecent.set(userId, [...recentOf(userId), text].slice(-3));
  // Xotira cheksiz o'smasin: eng eski yozuvdan boshlab qisqartiramiz
  while (chatRecent.size > 5000) chatRecent.delete(chatRecent.keys().next().value);
}

const recDropTimers = new Map();

// Tugagan o'yinning o'yinchilari — natija ekranidan kelgan shikoyat uchun
// (Redis holati endGame'dan keyin o'chadi).
const endedPlayers = new Map();   // gameId -> { sid -> { userId, username } }

function rememberEnded(gameId, g) {
  const map = {};
  for (const p of g.players || []) {
    // Botlar ham kiritiladi: natija ekranidan botga shikoyat qilinganda
    // javob odamnikidan farq qilmasligi kerak (aks holda bot detektori).
    map[p.socketId] = { userId: p.userId, username: p.username };
  }
  endedPlayers.set(gameId, map);
  setTimeout(() => endedPlayers.delete(gameId), REC_GRACE_MS + 60000).unref?.();
}

async function gameReportCount(gameId) {
  try { return await redis.llen(repGameKey(gameId)); } catch { return 0; }
}

// Shikoyat kelmagan bo'lsa yozuvni o'chiramiz. Taymer ichida QAYTA
// tekshiriladi: shu oraliqda shikoyat kelgan bo'lishi mumkin.
function scheduleRecDrop(gameId) {
  if (recDropTimers.has(gameId)) return;
  const t = setTimeout(async () => {
    recDropTimers.delete(gameId);
    try {
      if (await gameReportCount(gameId) > 0) return;   // shikoyat bor — saqlanadi
      recStore.drop(gameId);
    } catch (e) { console.error('recDrop:', e?.message || e); }
  }, REC_GRACE_MS);
  t.unref?.();
  recDropTimers.set(gameId, t);
}

// `recDropTimers` faqat XOTIRADA yashaydi: server qayta ishga tushsa
// shikoyatsiz yozuvlar 14 kun osilib qolardi va diskni behuda egallardi.
// Shuning uchun ishga tushishda va soatiga bir marta "egasiz" yozuvlarni
// topib o'chiramiz.
async function sweepOrphanRecordings() {
  let n = 0;
  for (const r of recStore.list(500)) {
    if (timers.has(r.gameId)) continue;            // ketayotgan o'yin
    if (recDropTimers.has(r.gameId)) continue;     // taymeri bor
    const ended = !!recStore.readJson(r.gameId, 'game');
    // Tugagan o'yinga muhlat REC_GRACE_MS; game.json yo'q bo'lsa bu server
    // qulaganidan qolgan chala yozuv — unga 1 soat beramiz.
    if (Date.now() - r.at < (ended ? REC_GRACE_MS : 3600000)) continue;
    if (await gameReportCount(r.gameId) > 0) continue;   // shikoyat bor — saqlanadi
    if (recStore.drop(r.gameId)) n++;
  }
  if (n) console.log(`\u{1F9F9} ${n} ta shikoyatsiz yozuv o'chirildi (restart qoldig'i)`);
  return n;
}

// O'yin tugadi: tarixni yozuvga tushiramiz va taqdirini hal qilamiz.
//
// game.json HAR DOIM yoziladi (bir necha KB), chunki shikoyat natija
// ekranidan ham kelishi mumkin — o'sha paytda Redis'dagi chat allaqachon
// yo'qolgan bo'lardi. Ovoz fayllari esa shikoyat bo'lmasa o'chiriladi.
async function finishRecording(gameId, g, winner) {
  if (!recStore.isOpen(gameId)) return;
  let chat = [];
  try {
    const raw = await redis.lrange(`chat:${gameId}`, 0, -1);
    chat = (raw || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch {}
  recStore.saveJson(gameId, 'game', {
    gameId,
    name: g.name,
    winner,
    startedAt: g.startedAt || null,
    endedAt: g.endedAt || Date.now(),
    rounds: g.round || 0,
    // `id` — ovoz fayllari nomi bilan bir xil (publicId), shuning uchun admin
    // qaysi fayl kimniki ekanini aniqlay oladi.
    players: (g.players || []).map((p) => ({
      // DIQQAT: kalit /api/voice-chunk dagi fayl nomi bilan AYNAN bir xil
      // bo'lishi shart (`p.publicId || p.userId`) — admin ovozni o'yinchiga
      // shu orqali bog'laydi. Ilgari bu yerda `socketId` edi va haqiqiy
      // o'yinchining ovozi hech qachon egasiga bog'lanmasdi.
      id: p.publicId || p.userId,
      userId: isRealUser(p.userId) ? p.userId : null,
      username: p.username,
      role: p.role || null,
      bot: p.isBot === true,
      alive: p.isAlive !== false,
    })),
    chat,
    log: fullLog(g),
  });
  const n = await gameReportCount(gameId);
  if (n > 0) {
    try {
      const rows = await redis.lrange(repGameKey(gameId), 0, -1);
      recStore.saveJson(gameId, 'reports', rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean));
    } catch {}
    console.log(`\u{1F6A9} ${gameId}: ${n} ta shikoyat — yozuv saqlanadi`);
  } else {
    scheduleRecDrop(gameId);
  }
}

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

// ==================== OVOZ YOZUVI: BO'LAKLARNI QABUL QILISH ====================
//
// Mijoz O'Z mikrofonini yozadi (faqat gapirgan paytida) va bo'laklarni
// ketma-ket shu yerga yuboradi. Server ularni faylga QO'SHIB boradi.
//
// Nega mijozda: ovoz WebRTC mesh orqali to'g'ridan-to'g'ri oqadi, server uni
// umuman ko'rmaydi. Aralashtirish uchun SFU kerak bo'lardi.
//
// `express.raw` FAQAT shu yo'lda: global `express.json` binary tanani
// buzib yuborardi.
const voiceChunkBody = express.raw({ type: '*/*', limit: recStore.MAX_CHUNK + 4096 });

app.post('/api/voice-chunk', authMiddleware, limitByUser(600), voiceChunkBody, async (req, res) => {
  try {
    if (!recStore.ON) return res.status(204).end();
    const gameId = String(req.headers['x-game-id'] || '');
    // Kengaytma OQ RO'YXATDA: mijoz uni tanlay olmaydi. Ilgari istalgan qiymat
    // o'tardi va har biri alohida fayl bo'lib, o'yinchi kvotasini bekor qilardi.
    const raw = String(req.headers['x-rec-ext'] || 'webm');
    const ext = recStore.ALLOWED_EXT.includes(raw) ? raw : 'webm';
    // Bo'lak raqami: mijoz yozuvni qayta boshlagan bo'lsa (mikrofon uzilib
    // qayta ulandi, MediaRecorder xato berdi) bo'lak YANGI faylga yoziladi.
    // Aks holda ikkinchi webm sarlavhasi eski faylga yopishib, dalil
    // ochilmaydigan bo'lib qolardi.
    const seg = Math.min(30, Math.max(0, parseInt(req.headers['x-rec-seg'] || '0', 10) || 0));
    if (!gameId || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'bad' });
    if (!recStore.isOpen(gameId)) return res.status(410).json({ code: 'closed' });

    // Yuboruvchi HAQIQATAN shu o'yinning o'yinchisimi?
    const g = await getG(gameId);
    const me = (g?.players || []).find((p) => p.userId === req.user.userId);
    if (!g || g.status !== 'playing' || !me) return res.status(403).json({ code: 'notInGame' });

    // Fayl nomi — MASKALANGAN publicId (haqiqiy userId fayl tizimida qolmasin)
    const key = me.publicId || me.userId;
    const r = recStore.append(gameId, key, req.body, ext, seg);
    if (!r.ok) {
      // Chegaraga yetdi — mijoz yozishni to'xtatadi. Bu XATO emas: o'yin
      // davom etaveradi, faqat bu o'yinchining ovozi boshqa yozilmaydi.
      return res.status(r.code === 'diskFull' || r.code === 'gameFull' || r.code === 'userFull' ? 507 : 400)
        .json({ code: r.code });
    }
    res.json({ ok: true, bytes: r.bytes });
  } catch (e) { serverFail(res, e); }
});

// Gap bo'laklarining VAQT BELGILARI: audio faqat gapirilgan paytlarni
// o'z ichiga oladi, shuning uchun "audio 40-soniya" o'yinning qaysi daqiqasi
// ekanini bilish uchun shu ro'yxat kerak.
app.post('/api/voice-marks', authMiddleware, limitByUser(60), async (req, res) => {
  try {
    if (!recStore.ON) return res.status(204).end();
    const gameId = String(req.body?.gameId || '');
    const marks = Array.isArray(req.body?.marks) ? req.body.marks.slice(0, 2000) : null;
    if (!gameId || !marks) return res.status(400).json({ error: 'bad' });
    if (!recStore.isOpen(gameId)) return res.status(410).json({ code: 'closed' });
    const g = await getG(gameId);
    const me = (g?.players || []).find((p) => p.userId === req.user.userId);
    if (!me) return res.status(403).json({ code: 'notInGame' });
    const clean = marks
      .filter((m) => m && Number.isFinite(m.at) && Number.isFinite(m.dur))
      .map((m) => ({ at: Math.round(m.at), dur: Math.round(m.dur) }));
    recStore.saveJson(gameId, (me.publicId || me.userId) + '.marks', { player: me.username, marks: clean });
    res.json({ ok: true, n: clean.length });
  } catch (e) { serverFail(res, e); }
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
// ===== HUJUM REJIMI: holat va qo'lda boshqarish =====
// Admin hujumni o'zi ko'rib qalqonni yoqishi/o'chirishi mumkin. Keshni
// tozalash ham shu yerda: "kesh bir marta tozalansin" degan holat aynan shu.
app.get('/api/admin/panic', authMiddleware, adminMiddleware, (_, res) => {
  res.json({
    on: panic.on,
    manual: panic.manual,
    secondsLeft: panic.on && !panic.manual ? Math.max(0, Math.round((panic.until - Date.now()) / 1000)) : null,
    threshold: PANIC_RPS,
    holdSeconds: Math.round(PANIC_HOLD_MS / 1000),
    entered: panic.entered,
    blocked: panic.blocked,
    peakRps: panic.peakRps,
  });
});

app.post('/api/admin/panic', authMiddleware, adminMiddleware, (req, res) => {
  const on = !!req.body?.on;
  if (on) panicEnter(0, true);        // qo'lda yoqilgan qalqon o'zi o'chmaydi
  else panicLeave();
  res.json({ ok: true, on: panic.on, manual: panic.manual });
});

// Keshni qo'lda tozalash — noto'g'ri/eskirgan javob tarqalib qolsa
app.post('/api/admin/flush-cache', authMiddleware, adminMiddleware, (_, res) => {
  panicFlush();
  res.json({ ok: true });
});

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
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
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
        jazo: penaltyOf(u.id),   // amaldagi chat/ovoz/rasm cheklovlari
        stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: RATING_START, xp: 0 }
      }))
    });
  } catch (e) { serverFail(res, e); }
});

// Admin choralarining jurnali. Redis ro'yxatida (oxirgi 1000 ta) —
// yangi jadval qo'shmasdan, lekin "kim nima qildi" savoli javobsiz qolmasin.
async function adminAudit(actor, action, targetId, targetName) {
  const rec = {
    at: Date.now(),
    byId: actor?.userId || '?', by: actor?.username || '?',
    action, targetId, target: targetName || null,
  };
  try {
    await redis.rpush('admin:audit', JSON.stringify(rec));
    await redis.ltrim('admin:audit', -1000, -1);
  } catch {}
  console.log(`\u{1F6E1} admin: ${rec.by} -> ${action} -> ${targetName || targetId}`);
}

// Shikoyatlar va admin jurnali (admin panel uchun)
app.get('/api/admin/reports', authMiddleware, adminMiddleware, async (_req, res) => {
  try {
    const [reports, audit] = await Promise.all([
      redis.lrange('reports', -300, -1).catch(() => []),
      redis.lrange('admin:audit', -200, -1).catch(() => []),
    ]);
    const parse = (rows) => rows.map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean).reverse();
    const list = parse(reports).map((r) => ({
      ...r,
      label: REPORT_LABEL[r.type] || REPORT_LABEL.other,
      // Dalil hali diskdami? (shikoyatsiz o'yinlarniki o'chirilgan bo'ladi)
      dalil: r.gameId ? recStore.isOpen(r.gameId) : false,
      jazo: penaltyOf(r.onId),
    }));
    res.json({
      reports: list,
      audit: parse(audit),
      turlar: REPORT_TYPES.map((t) => ({ id: t, label: REPORT_LABEL[t] })),
      yozuvlar: recStore.stats(),
    });
  } catch (e) { serverFail(res, e); }
});

// ===== DALIL: bitta o'yinning to'liq yozuvi =====
app.get('/api/admin/evidence/:gameId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.gameId || '');
    if (!recStore.isOpen(id)) return res.status(404).json({ error: 'Yozuv topilmadi yoki o\'chirilgan' });
    const game = recStore.readJson(id, 'game');
    const reports = recStore.readJson(id, 'reports') || [];
    const files = recStore.files(id);
    // Ovoz fayllarini o'yinchiga bog'lab beramiz (fayl nomi = publicId)
    const byId = new Map((game?.players || []).map((p) => [p.id, p]));
    const audio = files
      .filter((f) => /\.(webm|mp4|ogg|m4a)$/i.test(f.name))
      .map((f) => {
        // `abc.webm` -> `abc`; `abc.2.webm` -> `abc` (2 — yozuv qayta
        // boshlangandagi bo'lak raqami, u o'yinchini almashtirmaydi).
        const key = f.name.replace(/\.[^.]+$/, '').replace(/\.\d+$/, '');
        const qism = /\.(\d+)\.[^.]+$/.exec(f.name)?.[1] || null;
        const marks = recStore.readJson(id, key + '.marks');
        return {
          file: f.name, size: f.size, qism,
          player: byId.get(key)?.username || '?',
          role: byId.get(key)?.role || null,
          marks: marks?.marks || [],
        };
      });
    res.json({ gameId: id, game, reports, audio, files });
  } catch (e) { serverFail(res, e); }
});

// Ovoz faylini berish. Yo'l `recStore.filePath` da tozalanadi (traversal yo'q).
app.get('/api/admin/evidence/:gameId/file/:name', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const p = recStore.filePath(String(req.params.gameId || ''), String(req.params.name || ''));
    if (!p) return res.status(404).json({ error: 'Fayl topilmadi' });
    const ext = p.split('.').pop().toLowerCase();
    const TYPE = { webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', ogg: 'audio/ogg', json: 'application/json' };
    res.set('Content-Type', TYPE[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=60');
    res.sendFile(p);
  } catch (e) { serverFail(res, e); }
});

// Dalilni qo'lda o'chirish (ko'rib bo'lingach — disk bo'shasin)
app.delete('/api/admin/evidence/:gameId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.gameId || '');
    const ok = recStore.drop(id);
    await redis.del(repGameKey(id)).catch(() => {});
    await adminAudit(req.user, 'deleteEvidence', id, id);
    res.json({ ok, yozuvlar: recStore.stats() });
  } catch (e) { serverFail(res, e); }
});

// ===== JAZO: chat / ovoz / profil rasmi =====
// Ban emas: odam o'ynayveradi, faqat muammo bo'lgan kanaldan chetlatiladi.
// `hours: 0` — jazoni olib tashlash.
app.post('/api/admin/users/:id/penalty', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { kind, hours } = req.body || {};
    if (!PENALTY_KINDS.includes(kind)) return res.status(400).json({ error: 'Noma\'lum jazo turi' });
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0 || h > 24 * 365) return res.status(400).json({ error: 'Muddat 0-8760 soat oralig\'ida' });
    const u = await prisma.user.findUnique({ where: { id: req.params.id }, select: { username: true } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const until = h > 0 ? Date.now() + h * 3600000 : 0;
    const now = await setPenalty(req.params.id, kind, until);
    await adminAudit(req.user, (h > 0 ? 'penalty:' : 'unpenalty:') + kind + (h > 0 ? `:${h}s` : ''), req.params.id, u.username);
    // Chat/ovoz jazosi DARHOL kuchga kirsin: o'yinchiga xabar beramiz
    if (h > 0) {
      for (const [sid, dd] of socketData) {
        if (dd?.userId !== req.params.id) continue;
        io.to(sid).emit('game_error', {
          code: kind === 'chat' ? 'chatBanned' : kind === 'voice' ? 'voiceBanned' : 'avatarHidden',
          message: kind === 'chat' ? '🔇 Chatda yozish vaqtincha taqiqlandi'
                 : kind === 'voice' ? '🔇 Ovozli chat vaqtincha taqiqlandi'
                 : '🖼 Profil rasmingiz vaqtincha yashirildi',
        });
      }
      if (kind === 'voice') {
        // Ovozli seansdan ham chiqaramiz — keyingi o'yinni kutmaymiz
        for (const [sid, dd] of socketData) {
          if (dd?.userId !== req.params.id || !dd.gameId) continue;
          voiceLeave(dd.gameId, sid);
          io.to(`game:${dd.gameId}`).emit('voice_peer_leave', { socketId: sid });
        }
      }
    }
    res.json({ id: req.params.id, jazo: now });
  } catch (e) { serverFail(res, e); }
});

app.post('/api/admin/users/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const updated = await prisma.user.update({ where: { id: u.id }, data: { isBanned: !u.isBanned } });
    await setBanned(u.id, updated.isBanned);
    // ban darhol kuchga kirsin — ochiq sessiyalarni uzamiz
    if (updated.isBanned) kickUserSockets(u.id, 'Hisobingiz bloklandi');
    // Admin chorasi JURNALGA yoziladi. Ilgari hech qayerda iz qolmasdi:
    // kim, qachon va kimni bloklaganini keyin aniqlab bo'lmasdi.
    await adminAudit(req.user, updated.isBanned ? 'ban' : 'unban', u.id, u.username);
    res.json({ id: updated.id, isBanned: updated.isBanned });
  } catch (e) { serverFail(res, e); }
});

app.post('/api/admin/users/:id/admin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const updated = await prisma.user.update({ where: { id: u.id }, data: { isAdmin: !u.isAdmin } });
    await adminAudit(req.user, updated.isAdmin ? 'grantAdmin' : 'revokeAdmin', u.id, u.username);
    res.json({ id: updated.id, isAdmin: updated.isAdmin });
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'O\'zingizni o\'chira olmaysiz' });
    const victim = await prisma.user.findUnique({ where: { id: req.params.id }, select: { username: true } }).catch(() => null);
    await prisma.user.delete({ where: { id: req.params.id } });
    // O'CHIRILGAN HISOB SESSIYASI ham darhol tugaydi. Ilgari faqat DB yozuvi
    // o'chirilardi, JWT esa 30 kun yashaydi va hech narsani tekshirmasdi —
    // o'chirilgan odam o'ynashda davom etardi (xona ochish, chat, ovoz).
    await setBanned(req.params.id, true);
    kickUserSockets(req.params.id, 'Hisobingiz o\'chirildi');
    userRooms.delete(req.params.id);
    await adminAudit(req.user, 'deleteUser', req.params.id, victim?.username || '?');
    res.json({ ok: true });
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
});

// xonani majburan to'xtatish
app.post('/api/admin/games/:id/stop', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    // DALIL SAQLANSIN: endGame chaqirilmagani uchun ilgari game.json yozilmasdi
    // va `chat:<id>` redis.del bilan butunlay yo'q bo'lardi — diskda esa egasiz
    // ovoz fayllari 14 kun qolib ketardi. Admin xonani AYNAN shikoyat sababli
    // to'xtatgan bo'lishi mumkin, ya'ni dalil eng kerak bo'lgan payt.
    {
      const g = await getG(id).catch(() => null);
      if (g?.recording) {
        rememberEnded(id, g);
        await finishRecording(id, g, g.winner || 'draw').catch((e) => console.error('adminStop/rec:', e?.stack || e));
      }
    }
    await prisma.game.update({ where: { id }, data: { status: 'finished', endedAt: new Date() } }).catch(() => {});
    io.to(`game:${id}`).emit('game_closed', { code: 'adminStopped', message: 'Admin tomonidan xona yopildi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    // guruhdagi e'lonni olib tashlaymiz (redis o'chishidan OLDIN o'qiymiz)
    const stopG = await getG(id);
    tgRoomCancel(id, stopG, 'admin xonani yopdi').catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { serverFail(res, e); }
});

// xonani butunlay o'chirish
app.delete('/api/admin/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    {
      // Bu yerda ham dalil yoziladi — sabab yuqoridagi bilan bir xil
      const g = await getG(id).catch(() => null);
      if (g?.recording) {
        rememberEnded(id, g);
        await finishRecording(id, g, g.winner || 'draw').catch((e) => console.error('adminDelete/rec:', e?.stack || e));
      }
    }
    io.to(`game:${id}`).emit('game_closed', { code: 'adminDeleted', message: 'Admin xonani o\'chirdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    const delG = await getG(id);
    tgRoomCancel(id, delG, "admin xonani o'chirdi").catch(() => {});
    await redis.del(`game:${id}`, `chat:${id}`).catch(() => {});
    await prisma.game.delete({ where: { id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
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
  } catch (e) { serverFail(res, e); }
});

// ==================== GAME ENGINE ====================

const timers = new Map();

// ==================== RETING BO'YICHA MOSLASHTIRISH ====================
//
// Maqsad: o'yinchilar ko'payganda kuchi yaqin odamlar bitta xonaga tushsin.
//
// NEGA "o'yinchilar ko'p bo'lsa" degan ALOHIDA shart kerak emas: xonaning
// reytingi FAQAT HAQIQIY o'yinchilardan hisoblanadi. Odam kam bo'lganda
// xonalar bo'sh (reytingsiz) bo'ladi va hammasi bir xil mos keladi — ya'ni
// hech qanday bo'linish yuz bermaydi va odam kutib qolmaydi. Odam ko'paygani
// sari xonalar reyting oladi va guruhlanish O'ZI boshlanadi. Bu — qat'iy
// chegaradan ancha barqaror: "nechta odam ko'p hisoblanadi?" degan savolga
// javob berish shart emas.
//
// Botlar hisobga OLINMAYDI: ular to'ldiruvchi, reytingi yo'q. Aks holda
// har bir xona RATING_START atrofida ko'rinib, moslashtirish ma'nosini
// yo'qotardi.
function roomRating(g) {
  const real = (g?.players || []).filter((p) => !isBot(p) && Number.isFinite(p.rating));
  if (!real.length) return null;
  return Math.round(real.reduce((a, p) => a + p.rating, 0) / real.length);
}

// Xona ligasi — lobbi ro'yxati uchun. Odam bo'lmasa barqaror pseudo-liga
// (maydon HAR DOIM bo'lishi kerak, aks holda bot xonasi oshkor bo'lardi).
function roomTier(g, gameId) {
  const r = roomRating(g);
  if (r != null) return tierOf(r);
  return pseudoTier(hashId(gameId));
}
function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) { h ^= String(id).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Reyting oynasi: taxminan bitta liga kengligi. Undan tashqarida ham xona
// topilmasa, odam KUTIB QOLMASLIGI uchun eng yaqini beriladi — bo'sh
// o'tirgandan ko'ra biroz kuchsiz/kuchli raqib yaxshiroq.
const MATCH_BAND = 250;

// Berilgan reytingga ENG MOS kutayotgan xonani tanlaydi.
// Qaytadi: gameId yoki null (mos xona yo'q — yangisini yaratish kerak).
async function pickRoomForRating(rating, { excludeId = null, userId = null } = {}) {
  const rows = await prisma.game.findMany({
    where: { status: 'waiting', isPrivate: false },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { id: true, totalPlayers: true, createdAt: true },
  }).catch(() => []);

  const withReal = [], neutral = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const g = await getG(row.id).catch(() => null);
    if (!g || g.status !== 'waiting') continue;
    if (userId && g.kicked?.[userId]) continue;          // chiqarib yuborilgan
    if (g.vsBots) continue;                              // "botlar bilan" xonasi shaxsiy
    // Sanoq boshlangan xona: o'yinchi kirguncha o'yin boshlanib ketadi va u
    // "O'yin boshlangan" ekraniga tushadi — tez o'yin uchun eng yomon tajriba.
    if (botStartTimers.has(row.id)) continue;
    const cap = g.totalPlayers || row.totalPlayers || 8;
    const free = cap - (g.players || []).length;
    if (free <= 0) continue;
    const rr = roomRating(g);
    const item = { id: row.id, free, rr, at: new Date(row.createdAt).getTime() };
    (rr == null ? neutral : withReal).push(item);
  }

  // 1) Oynaga tushadigan, ODAM BOR xonalar — eng yaqini
  const inBand = withReal.filter((x) => Math.abs(x.rr - rating) <= MATCH_BAND);
  if (inBand.length) {
    inBand.sort((a, b) => Math.abs(a.rr - rating) - Math.abs(b.rr - rating) || b.at - a.at);
    return inBand[0].id;
  }
  // 2) Odam yo'q (bot bilan to'lgan) xona — hammaga bir xil mos
  if (neutral.length) {
    neutral.sort((a, b) => b.at - a.at);
    return neutral[0].id;
  }
  // 3) Oynadan tashqarida bo'lsa ham eng yaqini — kutib qolgandan yaxshiroq
  if (withReal.length) {
    withReal.sort((a, b) => Math.abs(a.rr - rating) - Math.abs(b.rr - rating));
    return withReal[0].id;
  }
  return null;
}

// So'rov yuborgan foydalanuvchining reytingi (keshlanadi — lobbi tez-tez so'raydi)
async function myRating(userId) {
  if (!isRealUser(userId)) return RATING_START;
  const ck = 'rating:' + userId;
  const hot = memGet(ck);
  if (hot != null) return hot;
  const s = await prisma.userStats.findUnique({ where: { userId }, select: { rating: true } }).catch(() => null);
  const r = s?.rating ?? RATING_START;
  memSet(ck, r, 30000);
  return r;
}

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
// Uzilib qolgan o'yinchini kutish: joriy faza shuncha uzaytiriladi.
// Har o'yinchi uchun FAQAT BIR MARTA (p.graceUsed).
const RECONNECT_GRACE_MS = 60000;
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
    // NATIJA YOZILADI. Ilgari o'yin jimgina o'chirilardi va `recordStats` umuman
    // chaqirilmasdi — ya'ni yutqazayotgan o'yinchi tabni yopib mag'lubiyatdan
    // qutulardi. Bot bilan to'lgan xonada bu eng ko'p uchraydigan holat edi
    // (odam yagona tirik ulanish bo'ladi).
    const winner = checkWin(g) || 'draw';
    logEvent(g, '\u{1F50C}', "O'yinchilar uzilib qoldi — o'yin yakunlandi", 'abandonedEnd');
    await saveG(gameId, g);
    io.to(`game:${gameId}`).emit('game_closed', { code: 'abandoned', message: 'O\'yinchilar uzilib qolgani uchun o\'yin yopildi' });
    // endGame o'zi: statusni yopadi, recordStats ni yozadi, Telegram e'lonini
    // yakunlaydi va 60 soniyadan keyin Redis kalitlarini o'chiradi.
    await endGame(gameId, winner);
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
  // Xato KAMIDA loglanadi. Ilgari `next.catch(() => {})` uni butunlay yutardi:
  // o'yin dvigatelida xato bo'lsa xona jimgina muzlardi va logda hech qanday
  // iz qolmasdi — sababni topish imkonsiz edi.
  const tail = next.catch((e) => { console.error(`withLock[${key}]:`, e?.stack || e); });
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
      // Ishonchli belgisi — ma'lumotlari to'liq o'yinchi. O'yin ichida
      // ko'rinishi muhim: odam kim bilan o'ynayotganini bilib turadi.
      verified: p.verified === true,
    };
    // Jazo bo'lsa rasm KO'RSATILMAYDI — mijoz taxallusning birinchi harfini
    // chizadi. Admin panelida original rasm ko'rinishda qoladi (u qaror qabul
    // qilishi uchun kerak).
    if (!light) o.avatar = hasPenalty(p.userId, 'avatar') ? null : (p.avatar || null);
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
    avatar: hasPenalty(p.userId, 'avatar') ? null : (p.avatar || null),
    isAlive: p.isAlive,
    isHost: p.isHost === true,
    verified: p.verified === true,
    role: p.role,
    team: sideOf(p.role),
  }));
}

// Xona egasining TASHQARIGA chiqadigan ID si.
//
// `publicPlayers` har bir o'yinchining userId'sini puxta maskalaydi, lekin xona
// darajasidagi `hostId` xom holda ketardi — bot ochgan xonada u 'bot-' prefiksi
// bilan ko'rinib, xonani kim ochganini darhol oshkor qilardi.
//
// Frontend `hostId` ni faqat "bu mening xonammi" solishtiruvi uchun ishlatadi
// (app/game/[id]/page.js va app/oyin/view.js), shuning uchun haqiqiy
// foydalanuvchi uchun qiymat o'zgarmaydi — faqat bot host maskalanadi.
function publicHostId(g) {
  if (!g || !g.hostId) return null;
  if (isRealUser(g.hostId)) return g.hostId;
  const h = (g.players || []).find(p => p.userId === g.hostId);
  return h?.publicId || null;
}

// Mijozga yuboriladigan XAVFSIZ o'yin holati.
// `{ ...g }` ni to'g'ridan-to'g'ri yuborish mumkin emas: nightActions ichida
// mafiya socketId'lari (mafiaVotes), nightCheck ichida komissar tekshiruvi turadi —
// ular fosh bo'lsa o'yinning butun siri yo'qoladi. Shu sababli faqat oq ro'yxat.
function publicGame(g) {
  if (!g) return null;
  return {
    // Mijoz o'z soatini SERVER soati bilan solishtirib tuzatadi. Busiz faza
    // taymeri qurilma soatiga bog'liq edi: soat 40 soniya oldinda bo'lsa
    // hisoblagich umuman ko'rinmasdi (darhol 00:00), orqada bo'lsa esa faza
    // allaqachon yopilganda ham sanashda davom etardi.
    now: Date.now(),
    id: g.id,
    name: g.name,
    status: g.status,
    hostId: publicHostId(g),
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
  // O'yin buyumlari (xonada ishlatiladi) + hisob imkoniyatlari (o'yin
  // muvozanatiga tegmaydi, shuning uchun narxi ham arzon emas).
  prices: { shield: 60, lupa: 50, life: 100, xpBoost: 120, roomSlot: 80 },
};

// ==================== HISOB IMKONIYATLARI (PERK) ====================
// Nega `items` ichida emas: `items` — xona ichida sarflanadigan buyumlar
// (qalqon, lupa, jon) va o'yin dvigateli aynan shu uch kalitni biladi.
// Imkoniyatlar esa o'yindan TASHQARIDA ishlaydi:
//   xpBoost   — keyingi tugagan o'yinda XP ikki barobar (bir marta);
//   roomSlot  — BUGUN bitta qo'shimcha xona yaratish huquqi.
// Ikkisi ham Redis'da: roomSlot kun bilan chegaralangan (TTL), xpBoost esa
// ishlatilmaguncha turadi. Shu sababli baza sxemasi o'zgarmadi.
const PERK_KEYS = ['xpBoost', 'roomSlot'];
const dayKeySuffix = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
const xpBoostKey = (userId) => `perk:xpboost:${userId}`;
// Kunlik xona hisoblagichi. Redis'da, XONA O'CHIRILSA HAM KAMAYMAYDI.
//
// Ilgari limit jonli `prisma.game.count` ga tayanardi: xonani o'chirish hisobni
// QAYTARARDI, ya'ni yarat-o'chir aylanishi bilan kunlik limitni cheksiz chetlab
// o'tish mumkin edi va 80 tangalik `roomSlot` perki bekorga sotib olinardi.
//
// Kun `dayKeySuffix` bilan bir xil (UTC+5) — roomSlot perki bilan AYNI kunda
// tugasin. Ilgari perk UTC+5 da, xona hisobi esa server vaqtida hisoblanardi va
// sotib olingan perk vaqt zonasi farqi ichida yo'qolib ketardi.
const roomCountKey = (userId) => `rooms:created:${userId}:${dayKeySuffix()}`;
async function roomsCreatedToday(userId) {
  try { return Math.max(0, parseInt((await redis.get(roomCountKey(userId))) || '0') || 0); }
  catch { return 0; }
}
async function bumpRoomsCreated(userId) {
  try {
    const k = roomCountKey(userId);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 36 * 3600);   // kun almashgach o'zi o'chadi
  } catch {}
}
const roomSlotKey = (userId) => `perk:roomslot:${userId}:${dayKeySuffix()}`;

async function readPerks(userId) {
  try {
    const [xp, rooms] = await Promise.all([
      redis.get(xpBoostKey(userId)),
      redis.get(roomSlotKey(userId)),
    ]);
    return { xpBoost: Math.max(0, parseInt(xp || '0')), roomSlot: Math.max(0, parseInt(rooms || '0')) };
  } catch {
    return { xpBoost: 0, roomSlot: 0 };
  }
}

// XP kuchaytirgich BIR MARTA ishlaydi: o'yin tugagach sarflanadi.
// `decr` atomik — ikkita o'yin bir vaqtda tugasa ham ikki marta
// ishlatilmaydi (manfiyga tushsa 0 ga qaytariladi).
async function consumeXpBoost(userId) {
  try {
    const left = await redis.decr(xpBoostKey(userId));
    if (left < 0) { await redis.set(xpBoostKey(userId), '0'); return false; }
    return true;
  } catch { return false; }
}
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


// ==================== O'YIN VAQT BUDJETI ====================
// Hisob-kitob pacing.js da (testlari bor). Bu yerda faqat o'yin holatini
// shu modulga bog'laydigan ikki yupqa yordamchi qoladi.
function gameElapsed(g) {
  return pacingElapsed(g && g.startedAt);
}
function dur(g, phase) {
  const base = (g.durations && g.durations[phase]) || DEFAULT_SETTINGS.durations[phase];
  return phaseDuration(base, phase, gameElapsed(g));
}


async function startPhase(gameId, phase) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;

  // Vaqt chegarasi KUNDUZ boshida tekshiriladi: tabiiy to'xtash nuqtasi,
  // o'yinchi tungi harakatini bajarib bo'lgan bo'ladi va natija tushunarli
  // chiqadi. Tekshiruv har raundda bir marta bo'lgani uchun o'yin
  // chegaradan ko'pi bilan bitta raundga (2-4 daqiqa) oshadi.
  if (phase === 'day_discussion' && g.status === 'playing' && isTimeUp(gameElapsed(g))) {
    logEvent(g, '\u23F3', "Vaqt tugadi — mafiya shaharni bo'ysundira olmadi", 'timeUp');
    await saveG(gameId, g);
    return endGame(gameId, 'town');
  }

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
    phase, endsAt, duration: d, round: g.round, now: Date.now(),
    players: publicPlayers(g.players, { light: true }), log: g.log
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
  if (phase === 'day_discussion' && (g.players || []).some(isBot)) {
    scheduleBotDay(gameId, g);
    scheduleBotChat(gameId, g);   // muhokama jim o'tmasin
  }
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
          scheduleDeadTalk(gameId);   // o'liklar kanalida gap (o'lgan odam bo'lsa)
          msg = `☀️ ${p.username} ovoz bilan o'ldirildi — ${roleName(p.role)}`;
          result = { eliminated: p.username, role: p.role, reason: 'votedOut', name: p.username };
          logEvent(g, '⚖️', `${p.username} ovoz bilan chiqarildi — u ${roleName(p.role)} edi`, 'votedOut', { name: p.username, role: p.role });
          // 🗣️ Oxirgi so'z — chiqarilgan o'yinchi day_results davomida bitta ochiq xabar yozadi
          g.lastWordSid = p.socketId;
          io.to(p.socketId).emit('your_last_word', {});
          if (isBot(p)) scheduleBotLastWord(gameId, p.socketId);
          // 🧞‍♂️ Afsungar ovozda o'ldirilsa — qurbonni O'ZI tanlaydi (ROLES.md).
          // Tanlov day_results davomida beriladi; tanlamasa hech kim o'lmaydi.
          if (p.role === 'afsungar' && g.players.some(x => x.isAlive && x.socketId !== p.socketId)) {
            g.revenge = { by: p.socketId, username: p.username, target: null };
            revengeWindow = true;
            if (isBot(p)) scheduleBotRevenge(gameId, p.socketId);
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
      phase: 'day_results', endsAt: g.phaseEndsAt, duration: d, round: g.round, now: Date.now(),
      players: publicPlayers(g.players, { light: true }), message: msg, result, log: g.log
    });
    if (timers.has(gameId)) clearTimeout(timers.get(gameId));
    timers.set(gameId, setTimeout(() => withLock(gameId, () => startNight(gameId)), d * 1000));

  } else if (phase === 'night') {
    await processNight(gameId);
  } else {
    // ZAXIRA TARMOQ. Bu yerga tushish = fazani suradigan taymer noto'g'ri
    // funksiyaga ulangan. Ilgari bunday holatda HECH NIMA bo'lmasdi va xona
    // abadiy muzlab qolardi. Endi o'yin baribir davom etadi, log esa sababni
    // topish uchun iz qoldiradi.
    console.error(`onPhaseEnd: kutilmagan faza "${phase}" (${gameId}) — davom ettiramiz`);
    await phaseResumer(g).fire(gameId);
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
  // Kimni davolagani ESLAB QOLINADI — keyingi kecha o'shani takrorlay olmaydi.
  // Faqat haqiqatan davolagan bo'lsa (Kezuvchi bloklamagan bo'lsa) yoziladi.
  if (healTarget) {
    const doc = find(na.doctor.by);
    if (doc) { doc.roleData = doc.roleData || {}; doc.roleData.healedLast = healTarget; }
  }
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
  scheduleDeadTalk(gameId);
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
    phase: 'night_results', endsAt: g.phaseEndsAt, now: Date.now(),
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
    phase: step.phase, endsAt, duration: d, round: g.round, now: Date.now(),
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
    if (present) scheduleBotNightStep(gameId, idx, d * 1000, actors.find(isBot), g);
    // Taymer HAR DOIM qo'yiladi. Ilgari roli odamda bo'lsa taymer umuman qo'yilmasdi va
    // u harakat qilmasa (yoki uzilib qolsa) o'yin abadiy muzlab qolardi.
    //
    // Zaxira qiymat ilgari qat'iy `7000` edi — botlar ushlagan bosqich HAR SAFAR
    // aynan 7.000 soniyada yopilardi. Endi tasodifiy oraliq.
    const fb = humanActor ? (d * 1000)
      : (present ? Math.min(d * 1000, 6000 + crypto.randomInt(5000)) : d * 1000);
    timers.set(gameId, setTimeout(() => withLock(gameId, () => endNightStep(gameId, idx)), fb));
  } else {
    timers.set(gameId, setTimeout(() => withLock(gameId, () => endNightStep(gameId, idx)), d * 1000));
  }
}

// ==================== FAZANI DAVOM ETTIRISH ====================
// Joriy fazadan kelib chiqib, o'yinni SURADIGAN funksiyani beradi.
//
// NEGA ALOHIDA FUNKSIYA: bu mantiq ilgari faqat `recoverTimers` ichida bor edi.
// `disconnect` esa uzilgan o'yinchini kutish uchun xonaning YAGONA faza
// taymerini o'chirib, o'rniga HAR DOIM `onPhaseEnd(gameId, ph)` qo'yardi.
// `onPhaseEnd` esa faqat 'day_discussion' ni biladi ('night' tarmog'i o'lik kod —
// bunday faza umuman yo'q). Natijada 'day_results', 'night_results' va tungi
// bosqichlarda uzilish xonani ABADIY muzlatardi: faza almashmaydi, botlar kutadi
// va qutqaruv yo'li yo'q — o'yinchi qaytib kelsa ham (cancelAbandonCheck ishlaydi).
function phaseResumer(g) {
  const phase = g?.phase;
  const step = nightStepByPhase(phase);
  if (step) {
    let idx = Number.isInteger(g.nightStep) ? g.nightStep : NIGHT_STEPS.indexOf(step);
    if (idx < 0) idx = 0;
    return { step, idx, fire: (gameId) => endNightStep(gameId, idx) };
  }
  if (phase === 'day_discussion') return { step: null, idx: -1, fire: (gameId) => onPhaseEnd(gameId, 'day_discussion') };
  if (phase === 'day_results')   return { step: null, idx: -1, fire: (gameId) => startNight(gameId) };
  if (phase === 'night_results') return { step: null, idx: -1, fire: (gameId) => startPhase(gameId, 'day_discussion') };
  // noma'lum yoki eski format — kunduzdan davom ettiramiz (muzlab qolgandan yaxshiroq)
  return { step: null, idx: -1, fire: (gameId) => startPhase(gameId, 'day_discussion') };
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
function scheduleBotJoins(gameId, bots, fast = false) {
  cancelBotJoins(gameId);
  const timers = [];
  let delay = 0;
  for (const bot of bots) {
    // `fast` — odam lobbidan shu xonaga kirib kelmoqda: u ko'rgan xona
    // deyarli to'la edi, demak botlar ham darhol joyida bo'lishi kerak.
    // Odamlar bittalab, TENG oraliqda kirmaydi: ba'zan ikkitasi deyarli birga
    // keladi, ba'zan uzoq pauza bo'ladi. Ilgari oraliq har doim 2-9 soniya edi
    // va hech qachon ikkita "o'yinchi" birga kirmasdi — bu ham naqsh edi.
    const together = crypto.randomInt(100) < 22;
    delay += fast
      ? (together ? 120 + crypto.randomInt(320) : 400 + crypto.randomInt(1200))
      : (together ? 250 + crypto.randomInt(900) : 1800 + crypto.randomInt(7500));
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
      // Qatnashganlar ro'yxati (Telegram e'lonida ismlar ko'rsatiladi) —
      // botlar ham oddiy o'yinchi sifatida tushadi.
      if (!Array.isArray(g.everPlayers)) g.everPlayers = [];
      if (!g.everPlayers.includes(bot.username)) g.everPlayers.push(bot.username);
      // logEvent saveG dan OLDIN: aks holda yozuv Redis'ga tushmas va lobbi
      // lentasi (lobbyEvents) baribir bo'sh qolardi.
      logEvent(g, '👋', `${bot.username} o'yinga qo'shildi`, 'playerJoined', { name: bot.username });
      await saveG(gameId, g);
      io.to(`game:${gameId}`).emit('game_state', publicGame(g));
      tgRoomTouch(gameId);   // guruhdagi e'londa o'yinchilar soni yangilanadi

      // XONA TO'LDI -> o'yin 5-10 soniyada boshlanadi.
      // Nega darhol emas: o'yinchi kimlar bilan o'ynayotganini ko'rib
      // olishi kerak, ekran ostidan sirg'alib ketmasligi kerak.
      // Nega kutilmaydi: to'lgan xonada kutishning ma'nosi yo'q —
      // yangi odam baribir sig'maydi.
      if ((g.players || []).length >= (g.totalPlayers || 99)) {
        cancelBotStart(gameId);
        armBotStart(gameId, 5000 + crypto.randomInt(5000));
      }
    }), delay));
  }
  // ~35% xonada bitta "o'yinchi" kirib, keyin fikridan qaytib chiqib ketadi.
  // Ilgari bot HECH QACHON chiqmasdi — xonaga kirgan hamma oxirigacha qolardi.
  // Jonli lobbida bunday bo'lmaydi va "hech kim chiqmaydigan xona" ham naqsh edi.
  if (!fast && bots.length > 2 && crypto.randomInt(100) < 35) {
    timers.push(setTimeout(() => { withLock(gameId, async () => {
      const g = await getG(gameId);
      if (!g || g.status !== 'waiting') return;
      const cand = (g.players || []).filter(isBot);
      // Xona minimumdan pastga tushmasin — aks holda o'yin boshlanmay qoladi
      if (cand.length <= 1 || g.players.length <= (g.minPlayers || 5)) return;
      const gone = cand[crypto.randomInt(cand.length)];
      g.players = g.players.filter(p => p.socketId !== gone.socketId);
      logEvent(g, '👋', `${gone.username} xonadan chiqdi`, 'playerLeft', { name: gone.username });
      await saveG(gameId, g);
      io.to(`game:${gameId}`).emit('game_state', publicGame(g));
      io.to(`game:${gameId}`).emit('player_left', { username: gone.username });
      tgRoomTouch(gameId);
    }).catch(() => {}); }, delay + 3000 + crypto.randomInt(9000)));
  }
  botJoinTimers.set(gameId, timers);
}
function cancelBotJoins(gameId) {
  for (const t of botJoinTimers.get(gameId) || []) clearTimeout(t);
  botJoinTimers.delete(gameId);
}

// ==================== XONANI TEZ BOSHLASH ====================
// Botlar bilan to'lgan xonaga ODAM kirdi — uni uzoq kutdirmaymiz, lekin
// bir zumda ham boshlamaymiz: odam xonani ko'rib, kim borligini o'qib
// olishi kerak. 10-15 soniya shu uchun.
const botStartTimers = new Map();
function armBotStart(gameId, delay) {
  if (botStartTimers.has(gameId)) return false;   // allaqachon qurollangan
  botStartTimers.set(gameId, setTimeout(() => {
    botStartTimers.delete(gameId);
    withLock(gameId, async () => {
      const g = await getG(gameId);
      if (!g || g.status !== 'waiting') return;
      if ((g.players || []).length < (g.minPlayers || 5)) return;
      await beginGame(gameId);
    }).catch(() => {});
  }, delay));
  return true;
}
function cancelBotStart(gameId) {
  if (botStartTimers.has(gameId)) { clearTimeout(botStartTimers.get(gameId)); botStartTimers.delete(gameId); }
}

// Bot nomidan ochiq chat xabari. Xabar oddiy o'yinchi xabari kabi saqlanadi
// va tarqatiladi — tashqaridan farqi yo'q.
// Bot nomidan xabar. `channel`: public | mafia | dead — yetkazish odam
// xabari bilan AYNAN bir xil (chat_message ishlovchisiga qarang), shuning
// uchun mijoz uchun farqi yo'q.
async function botSay(gameId, bot, text, channel = 'public') {
  const payload = {
    username: bot.username, message: text, channel,
    isAlive: bot.isAlive !== false, timestamp: Date.now(),
  };
  try {
    const ck = `chat:${gameId}`;
    await redis.rpush(ck, JSON.stringify(payload));
    await redis.ltrim(ck, -200, -1);
    await redis.expire(ck, 86400);
  } catch {}
  if (channel === 'public') { io.to(`game:${gameId}`).emit('chat_message', payload); return; }
  const g = await getG(gameId).catch(() => null);
  if (!g) return;
  const who = channel === 'mafia'
    ? g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia')
    : g.players.filter(p => !p.isAlive);
  for (const p of who) if (!isBot(p)) io.to(p.socketId).emit('chat_message', payload);
}

// "Boshlaymizmi?" degan xabarlar. Odam shulardan birini yozsa bot javob
// beradi va o'yin boshlanadi.
const START_ASK = /(^|\s)(g+o+|boshla\w*|gaz|start\w*|ketdik|davay|qani|tez\w*|tayyor\w*)(\s|$|[!?.,]+)/i;
// Javoblar HAR SAFAR boshqa bo'ladi: bir xil javob qaytarilsa, javob
// yozayotgan narsa bot ekani darhol bilinadi. Yozilish uslubi ham ataylab
// "telefonda shosha-pisha yozilgan" kabi — ideal imlo shubha tug'diradi.
const START_REPLIES = [
  'ok boshlaymz', 'boshlavommz', 'gooo', 'bosvomman',
  'hamma tayyor bosa bosdm', 'ha ketdik', 'boshladik',
  'hozr bosaman', 'tayyor bo\'sa ketdik', 'bosdim',
  'yaxshi boshlaymiz', 'ketdik unda', 'mayli bosdm',
  'ha endi boshlasa bo\'ladi', 'bosaman ha', 'qani ketdik',
];

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

// `opts.name` / `opts.totalPlayers` — soxta xonani haqiqiyga aylantirganda
// beriladi: odam lobbida KO'RGAN xona nomi va sig'imi saqlanib qolsin.
// `opts.quick` — odam allaqachon kirmoqchi, botlar tezroq to'ladi.
async function startBotGame(opts = {}) {
  const settings = await getSettings();
  // Umumiy xona chegarasi bot o'yinlariga ham amal qiladi
  const active = await prisma.game.count({ where: { status: { in: ['waiting', 'playing'] } } });
  if (active >= (settings.maxRooms || 50)) return null;

  const totalPlayers = Math.max(8, Math.min(16, opts.totalPlayers || (9 + crypto.randomInt(4))));
  const mafiaCount = Math.max(1, Math.round(totalPlayers * 0.3));
  // 2-3 joy ODAM uchun bo'sh qoladi: bot o'yini "yopiq tomosha" emas, unga
  // kirib o'ynash mumkin bo'lishi kerak. Odam kirmasa botlar o'zlari o'ynaydi.
  const freeSeats = 2 + crypto.randomInt(2);
  const botCount = Math.max(5, totalPlayers - freeSeats);
  const bots = makeFillerBots('seed' + Date.now().toString(36), botCount, []);
  const host = bots[0];
  host.isHost = true;

  // Xona nomi o'yinchi yozganday ko'rinadi va HAR XIL bo'ladi. Hozir ochiq
  // xonalar nomlari beriladi — lobbida ikkita bir xil nom turmasin.
  const openNames = await prisma.game
    .findMany({ where: { status: { in: ['waiting', 'playing'] } }, select: { name: true }, take: 60 })
    .then((rows) => rows.map((r) => r.name))
    .catch(() => []);

  const game = await prisma.game.create({
    data: {
      name: opts.name || randomRoomName(host.username, openNames),
      status: 'waiting', hostId: host.userId, isPrivate: false,
      totalPlayers, maxPlayers: 20, minPlayers: Math.min(5, totalPlayers),
      mafiaCount, sheriffCount: 1, doctorCount: 1,
      civilCount: Math.max(0, totalPlayers - mafiaCount - 2),
    },
  });

  // Tez rejimda botlarning yarmi DARHOL xonada bo'ladi: odam lobbida
  // "9/12" yozilgan xonani ko'rgan, unga kirganda 1/12 ni ko'rmasligi kerak.
  // DIQQAT: bots[0] — host, u allaqachon xonada. Shuning uchun kesish 1 dan
  // boshlanadi, aks holda host ikki marta qo'shilib qolardi.
  const upfront = opts.quick ? bots.slice(1, 1 + Math.max(1, Math.floor((bots.length - 1) / 2))) : [];
  for (const b of upfront) b.joinedAt = Date.now();

  const state = {
    ...game, players: [host, ...upfront], phase: 'waiting', roleConfig: null,
    dayVotes: {}, nightActions: {}, round: 0, durations: settings.durations,
    log: [], botEvents: [], kicked: {},
    everPlayers: [host.username, ...upfront.map((b) => b.username)],
    botOnly: true,          // odamsiz o'yin: bo'sh xona tekshiruvidan himoyalangan
  };
  await saveG(game.id, state);

  // Qolgan botlar bittalab kiradi (2-9 s), keyin xona qisqa vaqt OCHIQ
  // turadi: odam kirsa u bilan o'ynaydi, kirmasa botlar o'zlari boshlaydi.
  //
  // NEGA QISQA (15-30 s): uzoq kutgan xona lobbida "muzlab qolgan" bo'lib
  // ko'rinadi. Tez aylanma yaxshiroq: xona to'ladi, o'yin boshlanadi,
  // tugaydi, o'rniga yangisi ochiladi — ro'yxat doim tirik. Odam uchun
  // qo'shilish imkoni yo'qolmaydi: soxta xonaga bosilganda bir zumda
  // haqiqiy xona yaratiladi (botlar allaqachon ichida).
  const rest = bots.slice(1 + upfront.length);
  scheduleBotJoins(game.id, rest, !!opts.quick);
  const startAfter = opts.quick
    ? 20000 + crypto.randomInt(15000)
    : rest.length * 9000 + 15000 + crypto.randomInt(15000);
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

// Bot o'yini tugagach — YANGI xona. "Xona yopildi, yangi xona ochildi"
// zanjiri saytni tirik ko'rsatadi: guruhda ham yangi e'lon paydo bo'ladi.
// Kunlik chegara bor (BOT_GAMES_MAX) — aks holda zanjir kechasi ham
// to'xtamasdi. Faol soatlar: 10:00-00:00 (Toshkent).
// Kuniga nechta bot o'yini: jadvalda 4-10 ta, zanjir bilan ham shundan
// oshmasin. Botlar o'yini "sayt tirik" hissi uchun, lobbining asosiy
// mazmuni uchun emas.
// Kuniga nechta bot o'yini. Aylanma tez bo'lgani uchun (xona 15-30
// soniya kutadi, o'yin 20-30 daqiqa) bir kunda ~30 ta o'yin chiqadi.
// Chegara shundan yuqori: tunda o'yin ochilmaydi va zaxira bo'lib qoladi.
const BOT_GAMES_MAX = 44;
function tashkentHour(now = Date.now()) {
  return new Date(now + 5 * 3600 * 1000).getUTCHours();
}
async function chainNextBotGame() {
  if (!BOT_GAMES_ON) return;
  const h = tashkentHour();
  if (h < 10) return;                       // tunda yangi xona ochilmaydi
  try {
    const dayKey = 'botgames:' + new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const done = await redis.scard(dayKey).catch(() => 0);
    if (done >= BOT_GAMES_MAX) return;
    // Slot xona HAQIQATAN yaratilgandan keyin band qilinadi. Ilgari avval band
    // qilinardi va `startBotGame` xato bersa (yoki maxRooms to'lgan bo'lsa) o'sha
    // slot kun bo'yi yo'qolardi — logda esa hech qanday iz qolmasdi.
    const mark = -Date.now();
    // 2-6 daqiqa tanaffus: xona tugagan zahoti yangisi chiqsa sun'iy
    // ko'rinadi, uzoq kutilsa esa lobbi bo'shab qoladi.
    const delay = (2 + Math.random() * 4) * 60000;
    setTimeout(() => {
      startBotGame()
        .then(async (id) => {
          if (!id) { console.warn('chainNextBotGame: xona yaratilmadi — slot band qilinmadi'); return; }
          await redis.sadd(dayKey, String(mark)).catch(() => {});
          await redis.expire(dayKey, 3 * 86400).catch(() => {});
        })
        .catch((e) => console.error('chainNextBotGame/start:', e?.stack || e));
    }, delay);
    console.log(`\u{1F501} yangi bot xonasi ${Math.round(delay / 60000)} daqiqadan keyin`);
  } catch (e) {
    console.error('chainNextBotGame:', e.message);
  }
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
function pickRandom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

// barcha rollardan bittadan (botlar bilan o'ynash) — 11 maxsus + 1 civil = 12 o'yinchi
function allRolesConfig() {
  const cfg = {};
  for (const r of SELECTABLE_ROLES) cfg[r] = 1;
  cfg.civil = 1;
  return cfg;
}

// Xonaga kirgan odam bilan BIR XIL taxallusli botni qayta nomlaydi.
//
// `makeFillerBots` faqat xona egasining taxallusini chetlab o'tadi; keyin
// kirgan odam bot bilan bir xil nomda bo'lib qolishi mumkin edi. Mijoz esa
// o'yinchini ISM bo'yicha ko'rsatadi — ikkita bir xil nom xonada chalkashlik
// va ochiq soxtalik belgisi bo'lardi.
function renameClashingBots(g, username) {
  const low = String(username || '').trim().toLowerCase();
  if (!low) return;
  for (const p of g.players || []) {
    if (!isBot(p) || String(p.username).toLowerCase() !== low) continue;
    const used = new Set((g.players || []).map(x => String(x.username).toLowerCase()));
    const free = BOT_NAMES.filter(n => !used.has(n.toLowerCase()));
    p.username = free.length
      ? free[crypto.randomInt(free.length)]
      : 'mafia' + crypto.randomInt(1000, 9999);
  }
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
  // Buyumlar BITTA so'rovda olinadi. Ilgari har o'yinchi uchun alohida
  // `loadUserItems` chaqirilardi — 12 kishilik xonada 12 ta KETMA-KET so'rov,
  // va o'yin boshlanishi shuncha kechikardi.
  const itemIds = g.players.filter(p => isRealUser(p.userId)).map(p => p.userId);
  const itemRows = itemIds.length
    ? await prisma.user.findMany({ where: { id: { in: itemIds } }, select: { id: true, items: true } }).catch(() => [])
    : [];
  const itemsById = new Map(itemRows.map(r => [r.id, normItems(r.items)]));
  for (const p of g.players) {
    p.items = itemsById.get(p.userId) || { shield: 0, lupa: 0, life: 0 };
    p.shieldActive = false;
  }
  logEvent(g, '🎭', 'O\'yin boshlandi — rollar tarqatildi', 'gameStarted');
  // DIQQAT: `startedAt` HOLATGA ham yoziladi, faqat bazaga emas.
  // Ilgari u faqat Postgres'da bo'lardi va Redis'dagi `g.startedAt`
  // `null` bo'lib qolardi. Natijada unga tayangan uchta narsa JIMGINA
  // ishlamasdi: vaqt chegarasi (25 daqiqa), fazalarning tezlashuvi va
  // Telegram natijasidagi "⏱ N daqiqa" qatori.
  g.startedAt = Date.now();
  // DALIL YOZUVI — faqat ODAM o'ynaydigan xonalarda.
  //
  // Botlarning o'zaro o'yinlari (botOnly) va "Botlar bilan o'ynash" (vsBots)
  // rejimida shikoyat qiladigan ham, shikoyat qilinadigan ham yo'q —
  // ularni yozish sof disk isrofi bo'lardi (kuniga 10-15 ta bot o'yini).
  const humans = (g.players || []).filter((p) => isRealUser(p.userId)).length;
  g.recording = (humans > 0 && !g.botOnly && !g.vsBots) ? recStore.open(gameId) : false;
  await saveG(gameId, g);
  prisma.game.update({ where: { id: gameId }, data: { status: 'playing', startedAt: new Date(g.startedAt) } }).catch(() => {});
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

// Tungi bosqichda bot harakatini rejalashtiradi.
//
// Kechikish botning XARAKTERIGA va bosqich uzunligiga bog'liq. Ilgari
// `botDelayMs()` — 2.0-4.5 s — barcha rollar, barcha tunlar va barcha botlar
// uchun bitta tor oyna berardi. Natijada mijoz 20-25 soniyalik hisoblagich
// ko'rsatardi, bosqich esa HAR SAFAR o'sha hisoblagichning 10-22% ida yopilardi:
// progress-bar aynan bir joyda o'lardi va tun ~145 soniya o'rniga ~20 soniyada
// o'tardi. Bu bot ekanini ko'rsatadigan eng aniq naqshlardan biri edi.
function scheduleBotNightStep(gameId, idx, stepMs = 20000, actor = null, g = null) {
  // Mafiya bosqichi: odam mafiya bilan bot sherik bo'lsa, u kanalda gapiradi
  if (g && NIGHT_STEPS[idx]?.phase === 'night_mafia') scheduleMafiaNightChat(gameId, g, stepMs);
  let persona = actor?.persona;
  if (actor && !persona) persona = actor.persona = makePersona(actor.userId || actor.socketId);
  const delay = nightDelayMs(persona || makePersona(gameId + ':' + idx), stepMs);
  const t = setTimeout(() => { withLock(gameId, () => runBotNightStep(gameId, idx)).catch(() => {}); }, delay);
  t.unref?.();
}

// ==================== BOTLARNING GAPI ====================
// Ilgari botlar o'yin davomida chatda BIR OG'IZ ham gapirmasdi. Keyin har
// kunduzda 2-5 bot bir martadan yozadigan bo'ldi — lekin odamning gapiga
// hech qanday javob yo'q edi: odam "Aziz mafiya" desa, Aziz jim turardi;
// kutish xonasida salomga javob yo'q; mafiya kanalida sherik jim; o'liklar
// kanali bo'sh. Bu "faqat o'z gapini gapiradigan" o'yinchi — bot belgisi.
//
// Endi HAMMA bot gapi bitta yo'ldan (`botSayLine`) o'tadi: ibora tanlanadi
// (takror eslanadi), botning uslubi qo'shiladi, "yozish" vaqti kutiladi,
// yuborishdan OLDIN faza QAYTA tekshiriladi va budjet (bir fazada nechta bot
// gapi) nazorat qilinadi — aks holda 10 bot bir-biriga javob berib chatni
// bosib yuborardi.
//
// Qarorlar bot-ai.js da (sof funksiyalar, testlari bor): chooseChatAct,
// chooseReaction, chooseDayOpener. Ular ovoz berish bilan AYNI manbaga
// (ochiq shubha ballari) tayanadi — bot aytgan gap keyingi ovoziga mos keladi.

const botChatBudget = new Map();   // gameId -> { key, n }
const BOT_CHAT_CAP = { public: 12, mafia: 5, dead: 4, waiting: 4 };
function chatBudgetOk(gameId, g, channel) {
  // Kutish xonasida budjet DAQIQA bo'yicha (odam u yerda uzoq o'tirishi mumkin)
  const key = g.status === 'waiting'
    ? 'w:' + Math.floor(Date.now() / 60000)
    : (g.round || 0) + ':' + String(g.phase || '').replace(/^night_.*/, 'night') + ':' + channel;
  let b = botChatBudget.get(gameId);
  if (!b || b.key !== key) { b = { key, n: 0 }; botChatBudget.set(gameId, b); }
  const cap = g.status === 'waiting' ? BOT_CHAT_CAP.waiting : (BOT_CHAT_CAP[channel] || 6);
  if (b.n >= cap) return false;
  b.n++;
  return true;
}
// Kanal shu fazada ochiqmi (odam uchun ham xuddi shu qoida)
function botChatPhaseOk(g, channel) {
  if (!g) return false;
  if (channel === 'public') return g.status === 'waiting' || (g.status === 'playing' && g.phase === 'day_discussion');
  if (channel === 'mafia') return g.status === 'playing' && String(g.phase || '').startsWith('night');
  if (channel === 'dead') return g.status === 'playing';
  return false;
}

// Bitta bot bitta gap: `kind` — ibora turi (bot-ai.js LINES), `targetSid` —
// gapda tilga olinadigan o'yinchi. Qaytadi: rejalashtirildimi.
async function botSayLine(gameId, botSid, kind, targetSid = null, opts = {}) {
  const channel = opts.channel || 'public';
  const g = await getG(gameId);
  if (!g || !botChatPhaseOk(g, channel)) return false;
  const bot = (g.players || []).find(p => p.socketId === botSid);
  if (!isBot(bot)) return false;
  if (channel === 'public' && g.status === 'playing' && !bot.isAlive) return false;
  if (channel === 'dead' && bot.isAlive) return false;
  if (channel === 'mafia' && (!bot.isAlive || sideOf(bot.role) !== 'mafia')) return false;
  const tgt = targetSid ? g.players.find(p => p.socketId === targetSid) : null;
  if (targetSid && !tgt) return false;
  if (!chatBudgetOk(gameId, g, channel)) return false;
  bot.mem = bot.mem || {};
  if (!bot.persona) bot.persona = makePersona(bot.userId || bot.socketId);
  // Takror gap bot ekanini darhol oshkor qiladi: bot o'zining oxirgi 12 ta
  // iborasini VA butun xonada aytilgan oxirgi 25 tasini chetlab o'tadi —
  // ikki bot bir xil gapni aytsa ham naqsh.
  const avoid = [...(bot.mem.said || []), ...(g.botSaid || [])];
  const line = botChatLine(kind, { n: tgt?.username }, avoid);
  if (!line) return false;
  bot.mem.said = [...(bot.mem.said || []), line.key].slice(-12);
  g.botSaid = [...(g.botSaid || []), line.key].slice(-25);
  // Komissar bir odamni qayta-qayta e'lon qilmaydi; da'vo botlar tarixiga
  // ham tushadi — shunda doktor bot uni himoya qiladi, qolganlar nishonga
  // shubha bilan qaraydi (jamoatchilik fikri).
  if ((kind === 'claim' || kind === 'clear') && targetSid) {
    if (kind === 'claim') bot.mem.claimedSids = [...(bot.mem.claimedSids || []), targetSid];
    botEvent(g, { type: kind, round: g.round || 0, from: botSid, target: targetSid });
  }
  await saveG(gameId, g);

  const text = styleLine(line.text, bot.persona);
  // "Yozib turish" vaqti: uzunroq gap uzoqroq yoziladi. Yuborishdan OLDIN
  // faza qayta tekshiriladi — kunduzgi gap tunda chiqib qolmasin.
  const t = setTimeout(() => {
    getG(gameId)
      .then((fresh) => {
        if (!fresh || !botChatPhaseOk(fresh, channel)) return;
        const still = (fresh.players || []).find((x) => x.socketId === botSid);
        if (!still) return;
        if (channel !== 'dead' && !still.isAlive) return;
        return botSay(gameId, still, text, channel);
      })
      .catch(() => {});
  }, (opts.delayMs || 0) + typingMs(text));
  t.unref?.();
  return true;
}
// Kechiktirib gapirish (qulf ostida)
function scheduleBotLine(gameId, sid, act, delay, channel = 'public') {
  const t = setTimeout(() => {
    withLock(gameId, () => botSayLine(gameId, sid, act.kind, act.targetSid, { channel })).catch(() => {});
  }, delay);
  t.unref?.();
}

// Kun boshida botlar nimaga munosabat bildiradi: oldingi kunning natijasi va
// kechasi kim o'lgani. Tarixning DUMIDAN o'qiladi: ... lynched, killed*, [bugun]
function lastEventsFor(g) {
  const ev = g.botEvents || [];
  const killed = [];
  let lynched = null;
  let i = ev.length - 1;
  while (i >= 0 && ev[i].type === 'killed') { killed.push(ev[i].target); i--; }
  while (i >= 0 && (ev[i].type === 'claim' || ev[i].type === 'clear')) i--;
  if (i >= 0 && ev[i].type === 'lynched') lynched = { sid: ev[i].target, wasMafia: !!ev[i].wasMafia };
  return { lynched, killed, anyNight: (g.round || 0) > 1 };
}

// Kunduzgi muhokama: kim, qachon gapiradi.
function scheduleBotChat(gameId, g) {
  const phaseMs = dur(g, 'day_discussion') * 1000;
  const bots = (g.players || []).filter(p => p.isAlive && isBot(p));
  if (!bots.length || phaseMs < 15000) return;
  for (const b of bots) if (!b.persona) b.persona = makePersona(b.userId || b.socketId);
  const order = bots.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Har raundda hamma emas: kim gapirishi `chatty` xarakteriga bog'liq (2..7)
  const speakers = pickSpeakers(order);
  // Vaqtlar faza bo'ylab TARQOQ va kamida 2.6 s oraliq bilan. Oxirgi slot faza
  // tugashidan kamida TYPING_MAX oldin — gap keyingi fazada chiqib qolmasin.
  const TYPING_MAX = 12000;
  const from = 2500;
  const last = phaseMs - TYPING_MAX - 2000;
  if (last <= from) return;
  const to = Math.max(from + 3000, last);
  const slots = speakers.map(() => from + crypto.randomInt(to - from)).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] - slots[i - 1] < 2600) slots[i] = slots[i - 1] + 2600 + crypto.randomInt(1800);
  }
  speakers.forEach((bot, i) => {
    if (slots[i] > last) return;
    // Birinchi 1-2 gap — OLDINGI natijaga munosabat (2-raunddan): "X tinch
    // ekan xato qildik", "kecha Y ni olishdi". Odam ham kunni shundan boshlaydi.
    const opener = (g.round || 0) > 1 && i < 2 && crypto.randomInt(100) < 70;
    const t = setTimeout(() => { withLock(gameId, async () => {
      if (!opener) return botTalkOnce(gameId, bot.socketId);
      const fresh = await getG(gameId);
      const bb = fresh?.players?.find(p => p.socketId === bot.socketId);
      if (!bb) return;
      const act = chooseDayOpener({ ...botCtx(fresh, bb), last: lastEventsFor(fresh) });
      return botTalkOnce(gameId, bot.socketId, act);
    }).catch(() => {}); }, slots[i]);
    t.unref?.();
  });
  // Ikkinchi to'lqin: uzun fazada ba'zi botlar yana bir marta gapiradi —
  // muhokama fazaning oxirigacha "tirik" qoladi.
  if (phaseMs >= 60000) {
    const half = Math.round(phaseMs * 0.55);
    for (const bot of speakers) {
      if (crypto.randomInt(100) >= 35) continue;
      const at = half + crypto.randomInt(Math.max(1000, last - half));
      if (at > last) continue;
      const t = setTimeout(() => { withLock(gameId, () => botTalkOnce(gameId, bot.socketId)).catch(() => {}); }, at);
      t.unref?.();
    }
  }
}

// Bitta bot bitta gap yozadi. `forced` — tashqaridan berilgan qaror
// (kun boshidagi munosabat); bo'lmasa chooseChatAct hal qiladi.
async function botTalkOnce(gameId, botSid, forced = null) {
  const g = await getG(gameId);
  if (!g || g.status !== 'playing' || g.phase !== 'day_discussion') return;
  const bot = (g.players || []).find(p => p.socketId === botSid);
  if (!isBot(bot) || !bot.isAlive) return;
  const act = forced || chooseChatAct(botCtx(g, bot));
  if (!act) return;
  const ok = await botSayLine(gameId, botSid, act.kind, act.targetSid);
  if (!ok) return;

  // BOT-BOT MULOQOTI: kimnidir ayblasa, ayblangan bot o'zini himoya qiladi,
  // yana bittasi qo'shiladi yoki qarshi chiqadi. Busiz har gap havoda qolar
  // va chat "bir-birini eshitmaydigan" odamlar ro'yxatiga o'xshardi.
  if ((act.kind === 'accuse' || act.kind === 'claim' || act.kind === 'agree') && act.targetSid) {
    const tgt = g.players.find(p => p.socketId === act.targetSid);
    if (isBot(tgt) && tgt.isAlive && crypto.randomInt(100) < 55) {
      scheduleBotLine(gameId, tgt.socketId, { kind: 'defend', targetSid: null }, 3000 + crypto.randomInt(6000));
    }
    const others = g.players.filter(p => p.isAlive && isBot(p) && p.socketId !== botSid && p.socketId !== act.targetSid);
    if (others.length && crypto.randomInt(100) < 30) {
      const o = others[crypto.randomInt(others.length)];
      // Mafiya bot sherigini ayblovga QO'SHILMAYDI — himoya qiladi
      const mate = sideOf(o.role) === 'mafia' && sideOf(tgt?.role) === 'mafia';
      const kind = mate ? (act.kind === 'claim' ? 'doubtClaim' : 'disagree') : 'agree';
      scheduleBotLine(gameId, o.socketId, { kind, targetSid: act.targetSid }, 5000 + crypto.randomInt(7000));
    }
  }
}

// ODAMNING GAPIGA JAVOB. Chat ishlovchisidan chaqiriladi (qulfsiz — faqat
// taymer qo'yadi; gapning o'zi qulf ostida yoziladi).
const botReactAt = new Map();   // gameId -> oxirgi javob vaqti (bosib yubormaslik)
async function botReactToHuman(gameId, g, human, text, channel) {
  if (!(g.players || []).some(isBot)) return;
  const now = Date.now();
  if (now - (botReactAt.get(gameId) || 0) < 2500) return;
  const kind = classifyChat(text);
  const seatsOn = g.status === 'playing';
  const roster = (g.players || []).map((p, i) => ({ socketId: p.socketId, username: p.username, seat: i + 1 }));
  const targets = mentionedPlayers(text, roster, { authorSid: human.socketId, seats: seatsOn });

  // ----- Kutish xonasi: faqat salomga javob -----
  if (g.status === 'waiting') {
    if (kind !== 'greet') return;
    const bots = g.players.filter(isBot);
    if (!bots.length || crypto.randomInt(100) >= 70) return;
    botReactAt.set(gameId, now);
    const b = bots[crypto.randomInt(bots.length)];
    scheduleBotLine(gameId, b.socketId, { kind: 'greetReply', targetSid: crypto.randomInt(100) < 40 ? human.socketId : null }, 1200 + crypto.randomInt(2500));
    return;
  }
  if (g.status !== 'playing') return;

  // ----- Mafiya kanali (tun): sherik bot javob beradi -----
  if (channel === 'mafia') {
    const mates = g.players.filter(p => p.isAlive && isBot(p) && sideOf(p.role) === 'mafia');
    if (!mates.length) return;
    botReactAt.set(gameId, now);
    const b = mates[crypto.randomInt(mates.length)];
    const tgt = targets.find(sid => { const p = g.players.find(x => x.socketId === sid); return p && p.isAlive && sideOf(p.role) !== 'mafia'; });
    if (tgt) { scheduleBotLine(gameId, b.socketId, { kind: 'mafiaAgree', targetSid: tgt }, 1200 + crypto.randomInt(2500), 'mafia'); return; }
    if (kind === 'question' || crypto.randomInt(100) < 45) {
      const t = chooseNightTarget(botCtx(g, b));
      if (t) scheduleBotLine(gameId, b.socketId, { kind: 'mafiaPropose', targetSid: t }, 1500 + crypto.randomInt(3000), 'mafia');
    }
    return;
  }
  if (channel !== 'public' || g.phase !== 'day_discussion') return;

  // ----- Kunduz: nishonga olingan bot ALBATTA javob beradi, qolganlar ehtimol bilan -----
  const bots = g.players.filter(p => p.isAlive && isBot(p));
  if (!bots.length) return;
  const responders = bots.filter(b => targets.includes(b.socketId));
  const rest = bots.filter(b => !responders.includes(b));
  const p = kind === 'other' ? 12 : kind === 'greet' ? 0 : 55;
  if (rest.length && crypto.randomInt(100) < p) {
    const o = weightedPick(rest.map(b => ({ v: b, w: b.persona?.chatty ?? 0.6 })));
    if (o) responders.push(o);
  }
  if (!responders.length) return;
  botReactAt.set(gameId, now);
  responders.slice(0, 2).forEach((bot, i) => {
    // O'qish + yozish: 1.5-5 s, ikkinchi javob yana 2.5 s kechroq
    const delay = 1500 + crypto.randomInt(3500) + i * 2500;
    const t = setTimeout(() => { withLock(gameId, async () => {
      const fresh = await getG(gameId);
      if (!fresh || fresh.status !== 'playing' || fresh.phase !== 'day_discussion') return;
      const b = fresh.players.find(x => x.socketId === bot.socketId);
      if (!b || !b.isAlive) return;
      const c = botCtx(fresh, b);
      const act = chooseReaction({
        kind, targets, authorSid: human.socketId, me: c.me, mates: c.mates, iAmMafia: c.iAmMafia,
        alive: c.alive, suspicion: c.suspicion, persona: c.persona, phase: 'day_discussion',
      });
      if (!act) return;
      await botSayLine(gameId, b.socketId, act.kind, act.targetSid);
    }).catch(() => {}); }, delay);
    t.unref?.();
  });
  // Odamning komissar da'vosi botlar tarixiga tushadi: ular buni keyingi
  // ovozda hisobga oladi (haqiqiy o'yinchi ham "kom" gapini eshitadi).
  if (kind === 'claim' && targets.length) {
    withLock(gameId, async () => {
      const fresh = await getG(gameId);
      if (!fresh || fresh.status !== 'playing') return;
      botEvent(fresh, { type: 'claim', round: fresh.round || 0, from: human.socketId, target: targets[0] });
      await saveG(gameId, fresh);
    }).catch(() => {});
  }
}

// KUTISH XONASI: odam kirganda salomlashish (35%) va vaqti-vaqti bilan
// bekorchi gap ("necha kishi kutamiz", "mikrofon bormi") — faqat odam
// xonada bo'lsa; bo'sh xonada gapirishning ma'nosi yo'q.
const waitTalkTimers = new Map();
function scheduleWaitingChatter(gameId, human) {
  if (crypto.randomInt(100) < 35) {
    const t = setTimeout(() => { withLock(gameId, async () => {
      const g = await getG(gameId);
      if (!g || g.status !== 'waiting') return;
      const bots = g.players.filter(isBot);
      if (!bots.length) return;
      const b = bots[crypto.randomInt(bots.length)];
      await botSayLine(gameId, b.socketId, 'greet', crypto.randomInt(100) < 50 ? human.socketId : null);
    }).catch(() => {}); }, 2500 + crypto.randomInt(4500));
    t.unref?.();
  }
  if (waitTalkTimers.has(gameId)) return;
  let at = 0;
  for (let i = 0; i < 3; i++) {
    at += 20000 + crypto.randomInt(30000);
    const t = setTimeout(() => { withLock(gameId, async () => {
      const g = await getG(gameId);
      if (!g || g.status !== 'waiting') return;
      if (!g.players.some(p => !isBot(p) && p.connected !== false)) return;
      const bots = g.players.filter(isBot);
      if (!bots.length) return;
      const b = bots[crypto.randomInt(bots.length)];
      await botSayLine(gameId, b.socketId, 'waitTalk');
    }).catch(() => {}); }, at);
    t.unref?.();
  }
  waitTalkTimers.set(gameId, true);
  setTimeout(() => waitTalkTimers.delete(gameId), at + 1000).unref?.();
}

// O'LIKLAR KANALI: o'lgan bot gapiradi — lekin faqat uni O'QIYDIGAN o'lgan
// odam bo'lsa (aks holda behuda). Tiriklar uchun ko'rinmaydi.
function scheduleDeadTalk(gameId) {
  const t = setTimeout(() => { withLock(gameId, async () => {
    const g = await getG(gameId);
    if (!g || g.status !== 'playing') return;
    if (!g.players.some(p => !p.isAlive && !isBot(p) && p.connected !== false)) return;
    const deadBots = g.players.filter(p => !p.isAlive && isBot(p));
    if (!deadBots.length || crypto.randomInt(100) < 35) return;
    const b = deadBots[crypto.randomInt(deadBots.length)];
    const c = botCtx(g, b);
    const top = c.alive.filter(p => p.socketId !== b.socketId && !c.mates.includes(p.socketId))
      .map(p => ({ sid: p.socketId, sc: c.suspicion[p.socketId] || 0 })).sort((x, y) => y.sc - x.sc)[0];
    await botSayLine(gameId, b.socketId, 'deadTalk', top && top.sc > 0.5 && crypto.randomInt(100) < 50 ? top.sid : null, { channel: 'dead' });
  }).catch(() => {}); }, 6000 + crypto.randomInt(14000));
  t.unref?.();
}

// MAFIYA KANALI (tun): odam mafiya bilan bir jamoada bot sherik bo'lsa,
// sherik jim turmaydi — so'raydi yoki taklif qiladi. Odam bosqichning 60%
// igacha tanlamasa, botlar O'ZLARI tanlab, aytadi: ilgari odam AFK bo'lsa
// mafiya butun kecha hech narsa qilmasdi.
function scheduleMafiaNightChat(gameId, g, stepMs) {
  const alive = (g.players || []).filter(p => p.isAlive);
  const voters = alive.filter(p => MAFIA_VOTERS.includes(p.role));
  const humans = voters.filter(p => !isBot(p) && p.connected !== false);
  const bots = voters.filter(isBot);
  const readers = alive.filter(p => sideOf(p.role) === 'mafia' && !isBot(p) && p.connected !== false);
  if (!bots.length || !readers.length) return;
  const b = bots[crypto.randomInt(bots.length)];
  const t1 = setTimeout(() => { withLock(gameId, async () => {
    const fresh = await getG(gameId);
    if (!fresh || fresh.phase !== 'night_mafia') return;
    const bb = fresh.players.find(p => p.socketId === b.socketId);
    if (!bb || !bb.isAlive) return;
    if (Object.keys(fresh.nightActions?.mafiaVotes || {}).length) return;   // allaqachon tanlangan
    if (crypto.randomInt(100) < 45) return botSayLine(gameId, bb.socketId, 'mafiaAsk', null, { channel: 'mafia' });
    const t = chooseNightTarget(botCtx(fresh, bb));
    if (!t) return;
    fresh.mafiaProposal = t;
    await saveG(gameId, fresh);
    return botSayLine(gameId, bb.socketId, 'mafiaPropose', t, { channel: 'mafia' });
  }).catch(() => {}); }, 2500 + crypto.randomInt(3500));
  t1.unref?.();
  if (!humans.length) return;
  const t2 = setTimeout(() => { withLock(gameId, async () => {
    const fresh = await getG(gameId);
    if (!fresh || fresh.phase !== 'night_mafia') return;
    const na = fresh.nightActions = fresh.nightActions || {};
    na.mafiaVotes = na.mafiaVotes || {};
    const hv = fresh.players.filter(p => p.isAlive && MAFIA_VOTERS.includes(p.role) && !isBot(p));
    if (hv.some(p => na.mafiaVotes[p.socketId])) return;   // odam tanlagan — ergashish boshqa yerda
    const bs = fresh.players.filter(p => p.isAlive && isBot(p) && MAFIA_VOTERS.includes(p.role));
    if (!bs.length || bs.some(x => na.mafiaVotes[x.socketId])) return;
    const lead = bs[0];
    const prop = fresh.mafiaProposal && fresh.players.find(p => p.socketId === fresh.mafiaProposal && p.isAlive && sideOf(p.role) !== 'mafia');
    const t = prop ? prop.socketId : chooseNightTarget(botCtx(fresh, lead));
    if (!t) return;
    for (const x of bs) na.mafiaVotes[x.socketId] = t;
    await saveG(gameId, fresh);
    emitMafiaVotes(gameId, fresh);
    await botSayLine(gameId, lead.socketId, prop ? 'mafiaAgree' : 'mafiaPropose', t, { channel: 'mafia' });
  }).catch(() => {}); }, Math.round(stepMs * 0.6));
  t2.unref?.();
}
// Chiqarilgan BOT ham oxirgi so'zini yozadi. Ilgari faqat odam yozardi va
// bot chiqarilgan har raundda o'sha o'rin bo'sh — takrorlanadigan jimlik — edi.
function scheduleBotLastWord(gameId, sid) {
  const t = setTimeout(() => { withLock(gameId, async () => {
    const g = await getG(gameId);
    if (!g || g.lastWordSid !== sid || g.phase !== 'day_results') return;
    const bot = g.players.find(p => p.socketId === sid);
    if (!isBot(bot)) return;
    delete g.lastWordSid;
    bot.mem = bot.mem || {};
    const line = botChatLine('lastWord', {}, bot.mem.said || []);
    if (line) bot.mem.said = [...(bot.mem.said || []), line.key].slice(-10);
    await saveG(gameId, g);
    if (!line) return;
    const payload = {
      username: bot.username, message: line.text, channel: 'public',
      isAlive: false, lastWord: true, timestamp: Date.now(),
    };
    try {
      const ck = `chat:${gameId}`;
      await redis.rpush(ck, JSON.stringify(payload));
      await redis.ltrim(ck, -200, -1);
      await redis.expire(ck, 86400);
    } catch {}
    io.to(`game:${gameId}`).emit('chat_message', payload);
  }).catch(() => {}); }, 1500 + crypto.randomInt(3000));
  t.unref?.();
}

// Bot Afsungar ham qasos oladi. Ilgari faqat odam tanlay olardi: bot Afsungar
// chiqarilsa o'yin "qasos tanlanmoqda" deb 15 soniyaga muzlab turardi va keyin
// har safar "qasos olmadi" deb yozardi — takrorlanuvchi va ochiq bot belgisi.
function scheduleBotRevenge(gameId, sid) {
  const t = setTimeout(() => { withLock(gameId, async () => {
    const g = await getG(gameId);
    if (!g || !g.revenge || g.revenge.by !== sid || g.revenge.target) return;
    const bot = g.players.find(p => p.socketId === sid);
    if (!isBot(bot)) return;
    const pool = g.players.filter(x => x.isAlive && x.socketId !== sid);
    if (!pool.length) return;
    // Eng shubhali odamni olib ketadi — odam ham shunday qiladi
    const sus = buildSuspicion(g.botEvents || [], g.players);
    const cand = pool.map(x => ({ v: x.socketId, w: 1 + (sus[x.socketId] || 0) * 2 }));
    g.revenge.target = weightedPick(cand) || pool[crypto.randomInt(pool.length)].socketId;
    await saveG(gameId, g);
  }).catch(() => {}); }, 3000 + crypto.randomInt(6000));
  t.unref?.();
}

// Bot mafiya sheriklari ODAMNING tanloviga qo'shiladi.
//
// Ilgari bu faqat `g.vsBots` xonasida ishlardi. Oddiy xonada va botlarning
// o'zaro o'yinlarida `vsBots` qo'yilmaydi, shuning uchun `runBotNightStep`
// dagi `if (humanActor) return` bilan birga natija shunday bo'lardi: odam
// mafiya bo'lsa (mafiya ~30%, ya'ni har uchinchi o'yin) sheriklari HECH QACHON
// nishon tanlamaydi. Kelishuv paneli har kecha bo'sh turadi va
// `nightStepComplete` hech qachon rost bo'lmay, night_mafia har tunda to'liq
// 25 soniyani yondiradi — boshqa bosqichlar bir necha soniyada o'tayotganda.
// `humanSid` — nishon EMAS, odam mafiyaning socketId'si. Sababi: odam
// fikrini o'zgartirishi mumkin. Ilgari bu yerga nishon uzatilardi va
// sheriklar BIRINCHI bosilgan odamga ovoz berib qolardi — mafiya kelisha
// olmay, kecha bo'sh ketardi. Endi taymer ichida joriy ovoz qayta o'qiladi.
function scheduleBotMafiaFollow(gameId, humanSid) {
  // Darhol emas va hammasi birga emas: sherik ham "o'ylab" turadi.
  for (let i = 0; i < 4; i++) {
    const t = setTimeout(() => { withLock(gameId, async () => {
      const g = await getG(gameId);
      if (!g || g.status !== 'playing') return;
      const step = nightStepByPhase(g.phase);
      if (!step || step.phase !== 'night_mafia') return;
      const na = g.nightActions = g.nightActions || {};
      na.mafiaVotes = na.mafiaVotes || {};
      const targetSid = na.mafiaVotes[humanSid];   // JORIY tanlov
      if (!targetSid) return;                      // odam ovozini qaytarib olgan
      const tgt = g.players.find(p => p.socketId === targetSid);
      if (!tgt || !tgt.isAlive || sideOf(tgt.role) === 'mafia') return;
      const waiting = g.players.filter(p =>
        p.isAlive && isBot(p) && MAFIA_VOTERS.includes(p.role) && !na.mafiaVotes[p.socketId]);
      // Fikri o'zgargan bo'lsa ALLAQACHON ovoz bergan botlar ham ko'chadi,
      // aks holda kecha hech qachon yakunlanmay qolishi mumkin.
      for (const p of g.players) {
        if (p.isAlive && isBot(p) && MAFIA_VOTERS.includes(p.role) &&
            na.mafiaVotes[p.socketId] && na.mafiaVotes[p.socketId] !== targetSid) {
          na.mafiaVotes[p.socketId] = targetSid;
        }
      }
      if (!waiting.length) { await saveG(gameId, g); emitMafiaVotes(gameId, g); return; }
      na.mafiaVotes[waiting[0].socketId] = targetSid;
      await saveG(gameId, g);
      emitMafiaVotes(gameId, g);
      // Sherik ovoz berganini AYTADI ham ("ok Aziz") — kanal jim qolmasin
      if (crypto.randomInt(100) < 55) scheduleBotLine(gameId, waiting[0].socketId, { kind: 'mafiaAgree', targetSid }, 200, 'mafia');
      if (nightStepComplete(g, step)) await endNightStep(gameId, g.nightStep);
    }).catch(() => {}); }, 1500 + i * (1200 + crypto.randomInt(2200)));
    t.unref?.();
  }
}

// Mafiya kelishuv panelini yangilaydi (botlar ham qo'shilgani ko'rinsin).
function emitMafiaVotes(gameId, g) {
  const na = g.nightActions || {};
  const view = {};
  for (const m of g.players.filter(p => p.isAlive && MAFIA_VOTERS.includes(p.role))) {
    const sid = (na.mafiaVotes || {})[m.socketId];
    const tgt = sid ? g.players.find(p => p.socketId === sid) : null;
    view[m.username] = tgt ? tgt.username : null;
  }
  for (const m of g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia' && !isBot(p))) {
    io.to(m.socketId).emit('mafia_vote_update', { votes: view });
  }
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
  // "O'zini davolash huquqi sarflangan" belgisi. Server bu qoidani (ROLES.md)
  // faqat ODAM doktorga qo'llardi — bot `na.doctor` ni to'g'ridan-to'g'ri
  // yozgani uchun uni chetlab o'tardi va o'zini cheksiz davolay olardi.
  bot.mem.selfHeal = bot.roleData?.selfHeal === true;
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
  // Uzilib qolgan odam kutilmaydi: ilgari odam mafiya offline bo'lsa botlar
  // butun kecha "uni kutib" hech narsa qilmasdi.
  const humanActor = actors.some(p => !isBot(p) && p.connected !== false);

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
  // Ba'zan ovozini e'lon ham qiladi — AYNAN bergan ovozi (gap bilan ovoz
  // mos kelmasa kuzatuvchi buni sezadi)
  if (choice !== 'skip' && crypto.randomInt(100) < 30) scheduleBotLine(gameId, botSid, { kind: 'vote', targetSid: choice }, 300 + crypto.randomInt(1500));
  else if (choice === 'skip' && crypto.randomInt(100) < 20) scheduleBotLine(gameId, botSid, { kind: 'skip', targetSid: null }, 300 + crypto.randomInt(1500));
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
  // DIQQAT: fazaning HAQIQIY davomiyligi olinadi — `g.durations` dagi
  // bazaviy qiymat EMAS.
  //
  // Nega muhim: o'yin 13 daqiqadan oshgach fazalar qisqara boradi
  // (pacing.js). Bazaviy 120 soniyaga mo'ljallangan kechikish esa faza
  // 60 soniyaga tushganda uning TASHQARISIGA chiqib ketardi va
  // `botDayVoteOne` "faza o'zgargan" deb ovozni tashlab yuborardi.
  // Natijada o'yinning eng muhim — oxirgi raundlarida botlarning katta
  // qismi umuman ovoz bermay qolardi.
  const phaseMs = dur(g, 'day_discussion') * 1000;
  for (const bot of g.players.filter(p => p.isAlive && isBot(p))) {
    if (!bot.persona) bot.persona = makePersona(bot.userId || bot.socketId);
    // Zaxira chegara: kechikish har qanday holatda faza tugashidan
    // kamida 2 soniya oldin bo'lsin.
    const delay = Math.max(1200, Math.min(voteDelayMs(bot.persona, phaseMs), phaseMs - 2000));
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

  // RAQIB KUCHI. Xonada botlar bo'lsa, ular ham TO'LA QONLI raqib sifatida
  // hisoblanadi (reytingi RATING_START deb olinadi) — aks holda 1 odam + 11 bot
  // bo'lgan o'yinda "raqib yo'q" bo'lib chiqardi.
  //
  // MUHIM: "Botlar bilan o'ynash" tugmasi bosilgan o'yin (vsBots) yuqorida
  // butunlay chetlab o'tiladi — u reytingga ta'sir qilmaydi. Bu yerda gap
  // oddiy xonalar haqida: u yerda bot odam o'rnini to'ldiradi va o'yin
  // haqiqiy hisoblanadi.
  const botCount = g.players.filter((p) => !isRealUser(p.userId)).length;
  const totalRating = ids.reduce((s, id) => s + ratingOf(id), 0) + botCount * RATING_START;

  // O'yinchilar PARALLEL yoziladi: ilgari 12 kishilik xonada har biri uchun
  // ketma-ket 4-5 ta so'rov bajarilardi va natija ekrani shular tugaguncha
  // kutib turardi.
  await Promise.all(real.map(async (p) => {
    const won = isWinner(p.role, winner, p.isAlive);
    const reward = won ? ECONOMY.winReward : ECONOMY.loseReward;
    const prev = statsById.get(p.userId);
    const rating = prev?.rating ?? RATING_START;
    const gamesPlayed = prev?.gamesPlayed ?? 0;

    // Raqib kuchi = QOLGANLARNING o'rtachasi (o'zini qo'shmaymiz — aks holda
    // o'yinchi qisman o'zi bilan o'ynagan bo'lib chiqadi va delta kichrayadi).
    // Botlar ham "qolganlar" ichida.
    const others = ids.length - 1 + botCount;
    const opponent = others > 0 ? (totalRating - rating) / others : RATING_START;

    const delta = eloDelta({ rating, opponent, won, gamesPlayed });
    const nextRating = applyElo(rating, delta);
    let gainedXp = xpForGame({ won, survived: !!p.isAlive, rounds: g.round || 0 });
    // Do'kondan olingan kuchaytirgich — faqat bitta o'yinga va faqat
    // XP ga ta'sir qiladi. Reyting (Elo) TEGILMAYDI: tangaga reyting
    // sotilsa, jadval ma'nosini yo'qotadi.
    if (await consumeXpBoost(p.userId)) gainedXp *= 2;
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
      // 🪙 tanga mukofoti + o'yin tarixi — uchtasi PARALLEL, va yangi balans
      // update natijasidan olinadi (ilgari qo'shimcha findUnique so'rovi bor edi).
      const [updated] = await Promise.all([
        prisma.user.update({ where: { id: p.userId }, data: { coins: { increment: reward } }, select: { coins: true } }),
        prisma.gameHistory.create({
          data: { userId: p.userId, gameId: g.id, role: p.role || 'civil', won, winner: winner || '', coins: reward },
        }),
        logActivity(p.userId, 'coin_earn', { amount: reward, gameId: g.id, detail: `${won ? 'G\'alaba' : 'Mag\'lubiyat'} — ${roleName(p.role)}` }),
      ]);
      if (updated && p.socketId) io.to(p.socketId).emit('coins_update', { coins: updated.coins, reward });
    } catch (e) {
      // Ilgari bo'sh `catch {}` edi: reyting/tanga jimgina yozilmay qolardi va
      // logda hech qanday iz qolmasdi — shikoyat kelganda sababni topib bo'lmasdi.
      console.error('recordStats:', p.userId, e?.stack || e);
    }
  }));
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
  // Dalil: tarix yoziladi, ovoz fayllarining taqdiri shikoyatga qarab hal bo'ladi
  if (g.recording) {
    rememberEnded(gameId, g);
    await finishRecording(gameId, g, winner).catch((e) => console.error('finishRecording:', e?.stack || e));
  }
  tgRoomFinish(gameId).catch(() => {}); // guruhdagi e'lonni yakunlash
  // Botlar xonasi tugadi — o'rniga yangisi ochiladi
  if (g.botOnly) chainNextBotGame().catch(() => {});
  io.to(`game:${gameId}`).emit('game_over', {
    winner, players: revealPlayers(g.players), log: fullLog(g),
    message: winnerMessage(winner)
  });
  if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
  for (const p of g.players || []) {
    BOT_PING_HIST.delete(p.socketId);            // xotira sizmasin
    if (!isBot(p) && p.userId) userRooms.delete(p.userId);
  }
  voiceCtx.delete(gameId);
  gameBots.delete(gameId);
  cancelAbandonCheck(gameId);
  cancelEmptyCheck(gameId);
  cancelBotJoins(gameId);   // qo'shilishni kutayotgan botlar endi kerak emas
  cancelBotStart(gameId);   // "10-15 soniyada boshlash" taymeri ham
  setTimeout(() => redis.del(`game:${gameId}`, `chat:${gameId}`).catch(() => {}), 60000);
}

// ==================== SOCKET.IO ====================

const socketData = new Map();
// userId -> gameId. Bir foydalanuvchi bir vaqtda FAQAT bitta o'yinda bo'ladi.
//
// Ilgari cheklov yo'q edi va ikki oqibati bor edi:
//   1) eski xonalarda "arvoh" o'yinchi abadiy qolardi — xona hech qachon
//      o'chmasdi va `maxRooms` chegarasi to'lib borardi;
//   2) buyumlar (qalqon/lupa/jon) `beginGame` da har xonaga ALOHIDA
//      yuklanadi, ya'ni bitta qalqonni ikki xonada parallel ishlatib
//      ikkilantirish mumkin edi.
const userRooms = new Map();

// ==================== BITTA HISOB = BITTA FAOL SESSIYA ====================
// userId -> hozir o'yin o'ynayotgan socket. Ikkinchi qurilmadan (yoki
// ikkinchi varaqdan) o'yinga kirilsa, ESKI ulanish o'yindan chiqariladi.
//
// Ilgari eski socket xonada QOLIB KETARDI: `remapSocketId` o'yinchini yangi
// socketga ko'chirar, eskisi esa `game:<id>` xonasida qolib `game_state`
// oqimini olib turardi. Natijada ekranda o'yin "tirik" ko'rinar, lekin
// hech bir tugma ishlamasdi (server o'yinchini socketId bo'yicha topadi) —
// foydalanuvchi uchun bu "o'yin qotib qoldi" bo'lib ko'rinardi.
const userSockets = new Map();

// Bitta eski sessiyani o'yindan chiqarish. `newSid` — o'rnini egallagan
// yangi socket (xabar matnini tanlash uchun: o'sha qurilmami yoki boshqasi).
function kickSession(sid, newSid) {
  const eski = socketData.get(sid);
  socketData.delete(sid);   // disconnect ishlovchisi bu socketni endi KO'RMAYDI
  // Ovozli chatdagi izi tozalansin — aks holda qolganlarda jimjit peer osilib qolardi
  if (eski?.gameId) {
    try { voiceLeave(eski.gameId, sid); } catch {}
    io.to(`game:${eski.gameId}`).emit('voice_peer_leave', { socketId: sid });
  }
  const s = io.sockets.sockets.get(sid);
  if (!s) return;
  const yangi = newSid ? io.sockets.sockets.get(newSid) : null;
  // Qurilma barmoq izi (tokendagi `dvc`) mos kelsa — bu o'sha qurilmaning
  // boshqa varag'i; aks holda haqiqatan boshqa qurilma.
  const boshqaQurilma = !yangi || !s.data?.dvc || !yangi.data?.dvc || s.data.dvc !== yangi.data.dvc;
  try {
    for (const r of [...s.rooms]) if (String(r).startsWith('game:')) s.leave(r);
    s.emit('session_taken', {
      code: boshqaQurilma ? 'otherDevice' : 'otherTab',
      message: boshqaQurilma
        ? 'Hisobingizga boshqa qurilmadan kirildi'
        : 'O\'yin boshqa oynada ochildi',
    });
  } catch {}
  // Mijoz xabarni ko'rsatib ulgursin, keyin uzamiz
  const t = setTimeout(() => { try { s.disconnect(true); } catch {} }, 2000);
  t.unref?.();
}

// O'yinga kirish MUVAFFAQIYATLI bo'lgach chaqiriladi: shu userId ga tegishli
// boshqa hamma ulanish o'yindan chiqariladi va sessiya yangisiga bog'lanadi.
function bindSession(socket, userId, username, gameId) {
  const eskiSid = userSockets.get(userId);
  if (eskiSid && eskiSid !== socket.id) kickSession(eskiSid, socket.id);
  // Zaxira: `userSockets` biror sababga ko'ra yangilanmay qolgan bo'lsa ham
  // shu hisobning boshqa socketlari qolib ketmasin (arvoh sessiya bo'lmasin).
  for (const [sid, d] of [...socketData]) {
    if (sid !== socket.id && d?.userId === userId) kickSession(sid, socket.id);
  }
  userSockets.set(userId, socket.id);
  socketData.set(socket.id, { userId, username, gameId });
}

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
// Botlar uchun ALOHIDA oyna. Bot pingi ham xuddi odamniki kabi hisoblanishi
// kerak (oxirgi 5 namunaning minimumi) — aks holda taqsimot TESKARI naqsh
// beradi: bot raqami har 3 soniyada sakraydi, haqiqiy o'yinchiniki esa
// (minimum olingani uchun) deyarli qotib turadi. Ya'ni "tebranib turgan
// ping = bot" degan oddiy qoida ishlab ketardi.
const BOT_PING_HIST = new Map();

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
      // Botlar ro'yxati XOTIRADAN olinadi (saveG da yangilanadi) — ilgari bu
      // yerda har xona uchun to'liq holat Redis'dan o'qilib parse qilinardi.
      for (const b of gameBots.get(gameId) || []) {
        const hist = BOT_PING_HIST.get(b.socketId) || [];
        hist.push(fakePing(b.persona));
        if (hist.length > PING_WINDOW) hist.shift();
        BOT_PING_HIST.set(b.socketId, hist);
        map[b.socketId] = Math.min(...hist);
        trByGame.get(gameId)[b.socketId] = 'websocket';
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
// Socket FAQAT bitta o'yin xonasida qoladi. Ilgari eski xonadan chiqarilmasdi:
// bitta socket bir necha xonaning `game_state` oqimini olib turardi.
function joinRoomOnly(socket, key) {
  for (const r of socket.rooms) {
    if (r !== socket.id && r !== key && String(r).startsWith('game:')) socket.leave(r);
  }
  socket.join(key);
}

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
          if (dev && deviceHash(dev) === p.dvc) { socket.data.auth = p; socket.data.dvc = p.dvc; }
          // mos kelmasa — auth o'rnatilmaydi (boshqa nomidan kira olmaydi)
        } else socket.data.auth = p;
      } catch {}
    }
  } catch {}
  if (SOCKET_REQUIRE_AUTH && !socket.data.auth) {
    shield.noAuth++;
    return next(new Error('unauthorized'));
  }

  // (2.5) HUJUM REJIMIDA chegaralar qattiqlashadi: bitta IP dan 3 tadan
  // ko'p ulanish ochib bo'lmaydi. Oddiy o'yinchiga 1-2 ulanish yetarli
  // (varaq + zaxira), shuning uchun u sezmaydi; bir IP dan yuzlab socket
  // ochayotgan skript esa shu yerda to'xtaydi.
  if (panic.on && isPublicIp(ip) && (ipConns.get(ip) || 0) >= 3) {
    shield.perIp++;
    return next(new Error('too_many_connections'));
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

  // SOCKET UCHUN HAM tozalash. HTTP middleware bu yo'lni ko'rmaydi, chat
  // esa aynan socket orqali keladi — ya'ni bu qatlam bo'lmasa qavslar
  // faqat bitta yo'ldan to'silgan bo'lardi.
  socket.use((packet, next) => {
    try {
      for (let i = 1; i < packet.length; i++) {
        const a = packet[i];
        if (typeof a === 'string') packet[i] = cleanText(a, { maxLen: 4000 });
        else if (a && typeof a === 'object') cleanDeep(a);
      }
    } catch {}
    next();
  });
  // Ulangan, lekin hech qaysi o'yinga kirmagan socketni tozalaymiz:
  // bot ulanib jim turib xotira egallashi mumkin emas.
  socket.data.idleTimer = setTimeout(() => {
    if (!socketData.has(socket.id)) { shield.idle++; try { socket.disconnect(true); } catch {} }
  }, IDLE_SOCKET_MS);
  socket.data.idleTimer.unref?.();

  // ==================== XAVFSIZ ISHLOVCHI ====================
  // socket.io ishlovchini process.nextTick ichida chaqiradi va QAYTGAN
  // promise'ni kuzatmaydi. Shu sababli `socket.on('x', () => withLock(...))`
  // shaklidagi ishlovchida xato bo'lsa u `unhandledRejection` ga aylanardi —
  // `onFatal` esa bir daqiqada 10 ta shunday xatodan keyin YAGONA instansiyani
  // o'chirib yuboradi (barcha jonli o'yinlar bilan birga). Amalda buning uchun
  // Redis'ning 10 soniyalik uzilishi yoki noto'g'ri `gameId` yuborilgan bir
  // nechta chat xabari kifoya edi.
  //
  // Endi HAR BIR ishlovchi shu o'ramdan o'tadi: xato loglanadi va shu yerda
  // qoladi. Yangi hodisa qo'shilganda ham esdan chiqmaydi.
  const sOn = (event, fn) => socket.on(event, (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(`socket/${event}:`, e?.stack || e));
    } catch (e) { console.error(`socket/${event}:`, e?.stack || e); }
  });

  sOn('join_game', ({ gameId, userId, username } = {}) => withLock(gameId, async () => {
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

      // ===== BIR VAQTDA FAQAT BITTA O'YIN =====
      const prevId = userRooms.get(userId);
      if (prevId && prevId !== gameId) {
        const prev = await getG(prevId).catch(() => null);
        const there = prev?.players?.find(p => p.userId === userId);
        if (prev && prev.status === 'playing' && there && there.isAlive !== false) {
          socket.emit('game_error', { code: 'alreadyInGame', message: 'Siz boshqa o\'yindasiz — avval o\'sha o\'yinni tugating' });
          return;
        }
        if (prev && prev.status === 'waiting' && there) {
          // Kutayotgan xonadan jimgina chiqaramiz (boshqa qulf — deadlock yo'q)
          await withLock(prevId, async () => {
            const fresh = await getG(prevId);
            if (!fresh) return;
            fresh.players = (fresh.players || []).filter(p => p.userId !== userId);
            logEvent(fresh, '\u{1F44B}', `${there.username} xonadan chiqdi`, 'playerLeft', { name: there.username });
            await saveG(prevId, fresh);
            io.to(`game:${prevId}`).emit('game_state', publicGame(fresh));
            io.to(`game:${prevId}`).emit('player_left', { username: there.username });
            if (!(fresh.players || []).some(p => !isBot(p))) scheduleEmptyCheck(prevId);
          }).catch(() => {});
        }
        userRooms.delete(userId);
      }
      userRooms.set(userId, gameId);
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
          clearIdle(socket); pingSoon(); bindSession(socket, userId, existing.username, gameId);
          joinRoomOnly(socket, key);
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
              phase: g.phase, endsAt: g.phaseEndsAt, now: Date.now(),
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
        clearIdle(socket); pingSoon(); bindSession(socket, userId, existing.username, gameId);
        joinRoomOnly(socket, key);
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

      renameClashingBots(g, username);   // bot bilan bir xil nom qolmasin
      const isHost = g.hostId && g.hostId === userId;
      let avatar = null;
      let verified = false;
      let rating = RATING_START;
      if (userId && !String(userId).startsWith('guest-')) {
        const u = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            avatar: true, fullName: true, birthDate: true, region: true, gender: true, tgId: true,
            // Reyting o'yinchi bilan birga holatga yoziladi — xonaning
            // moslashtirish reytingi shundan hisoblanadi. Alohida so'rov
            // qo'shilmaydi: bu so'rov baribir bajarilyapti.
            stats: { select: { rating: true } },
          },
        }).catch(() => null);
        avatar = u?.avatar || null;
        verified = u ? profileState(u).verified : false;
        rating = u?.stats?.rating ?? RATING_START;
      }
      const player = {
        socketId: socket.id,
        userId: userId || 'guest-' + socket.id.slice(0, 6),
        username: username || 'O\'yinchi-' + socket.id.slice(0, 4),
        avatar,
        verified,
        rating,
        role: null, isAlive: true, connected: true, isHost, joinedAt: Date.now()
      };
      g.players.push(player);
      // xonada bo'lib o'tganlar ro'yxati — chiqib ketsa ham qoladi (Telegram e'loni uchun)
      if (!Array.isArray(g.everPlayers)) g.everPlayers = [];
      if (!g.everPlayers.includes(player.username)) g.everPlayers.push(player.username);
      await saveG(gameId, g);
      clearIdle(socket); pingSoon(); bindSession(socket, player.userId, player.username, gameId);
      joinRoomOnly(socket, key);

      io.to(key).emit('game_state', publicGame(g));
      io.to(key).emit('player_joined', { username: player.username, total: g.players.length });
      tgRoomTouch(gameId); // guruhdagi e'londa o'yinchilar sonini yangilash
      // Botli xonaga odam kirdi — kimdir salom beradi, vaqti-vaqti bilan gap bo'ladi
      if (g.status === 'waiting' && (g.players || []).some(isBot)) scheduleWaitingChatter(gameId, player);

      // 🤖 "Botlar bilan o'ynash" — foydalanuvchi kirishi bilan boshlanadi
      if (g.vsBots && g.status === 'waiting') {
        setTimeout(() => withLock(gameId, () => beginGame(gameId)), 700);
      } else if (g.status === 'waiting' && (g.players || []).some(isBot)
                 && g.players.length >= (g.minPlayers || 5)) {
        // Odam kirdi. Xona TO'LGAN bo'lsa 5-10 soniya, aks holda 10-15:
        // to'lmagan xonada yana bir-ikki odam kirib qolishi mumkin,
        // to'lganida esa kutishning ma'nosi yo'q.
        const full = g.players.length >= (g.totalPlayers || 99);
        const wait = full ? 5000 + crypto.randomInt(5000) : 10000 + crypto.randomInt(5000);
        if (armBotStart(gameId, wait)) {
          logEvent(g, '\u23F3', "O'yin boshlanmoqda...", 'startingSoon');
          await saveG(gameId, g);
          io.to(key).emit('game_state', publicGame(g));
        }
      }
    } catch (e) {
      console.error('join_game:', e);
      socket.emit('game_error', { message: e.message });
    }
  }));

  sOn('start_game', ({ gameId } = {}) => withLock(gameId, async () => {
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

  sOn('day_vote', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
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

  sOn('night_action', ({ gameId, targetSocketId, actionType } = {}) => withLock(gameId, async () => {
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
          // Bot mafiya sheriklari odamning tanloviga QO'SHILADI — darhol emas,
          // har biri o'z kechikishi bilan (scheduleBotMafiaFollow). Shart ilgari
          // `g.vsBots` edi va oddiy xonada umuman ishlamasdi: sheriklar hech
          // qachon nishon tanlamay, panel har kecha bo'sh turardi.
          if ((g.players || []).some(isBot)) scheduleBotMafiaFollow(gameId, socket.id);
          socket.emit('action_confirmed', { code: 'mafiaVote', name: target.username, message: `🔫 Ovozingiz: ${target.username}` });
          // mafiya sheriklarga joriy ovozlarni ko'rsatamiz (kelishish uchun)
          emitMafiaVotes(gameId, g);
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
          // Klassik qoida: KETMA-KET bir odamni davolab bo'lmaydi. Busiz doktor
          // bitta o'yinchini abadiy himoya qilib, mafiyani ma'nosiz qoldirardi.
          // Bir kecha oralatib o'sha odamni yana davolash mumkin.
          if (player.roleData?.healedLast && player.roleData.healedLast === targetSocketId) {
            socket.emit('game_error', {
              code: 'healSameTwice',
              message: "Ketma-ket bir odamni davolab bo'lmaydi",
            });
            return;
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
  sOn('revenge_pick', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
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

  sOn('use_item', ({ gameId, item, targetSocketId } = {}) => withLock(gameId, async () => {
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

  sOn('chat_message', async ({ gameId, message } = {}) => {
    if (!guard(socket, 'chat', 6, 5000)) return; // ~1.2 xabar/sekund
    const data = socketData.get(socket.id);
    if (!data) return;
    const text = String(message || '').trim().slice(0, 300);
    if (!text) return;
    const g = await getG(gameId);
    const player = g?.players.find(p => p.socketId === socket.id);
    if (!player) return;

    // Xona egasi jim qildirgan o'yinchi yozolmaydi.
    //
    // NEGA CHIQARIB YUBORISH EMAS: o'yin boshlangach o'yinchini xonadan
    // chiqarish rollar muvozanatini buzadi (mafiya chiqarilsa shahar
    // avtomatik g'olib bo'ladi) — shuning uchun `kick_player` faqat
    // kutish xonasida ishlaydi. Lekin ilgari o'yin boshlangach so'kinayotgan
    // odamdan qutulishning UMUMAN yo'li yo'q edi: 15 daqiqa chidashdan boshqa
    // chora qolmasdi. Jim qildirish muvozanatga tegmaydi.
    if (g.muted?.[player.userId]) {
      socket.emit('game_error', { code: 'muted', message: '🔇 Xona egasi sizni jim qildirdi' });
      return;
    }
    // Admin bergan chat jazosi (shikoyat bo'yicha chora)
    if (hasPenalty(player.userId, 'chat')) {
      socket.emit('game_error', { code: 'chatBanned', message: '🔇 Chatda yozish vaqtincha taqiqlangan' });
      return;
    }

    // Tarkib tekshiruvi (validate.js — sof funksiya, testlari bor)
    const recent = recentOf(player.userId);
    const chk = checkChat(text, recent);
    if (!chk.ok) {
      const MSG = {
        link: '🚫 Havola yuborish mumkin emas',
        phone: '🚫 Telefon raqam yuborish mumkin emas',
        repeat: '🚫 Bir xil xabarni takrorlamang',
        flood: '🚫 Bunday xabar yuborib bo\'lmaydi',
        empty: '',
      };
      if (MSG[chk.code]) socket.emit('game_error', { code: 'chat_' + chk.code, message: MSG[chk.code] });
      return;
    }
    // Oxirgi 3 ta xabar eslanadi (takror tekshiruvi uchun)
    pushRecent(player.userId, text);

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

    // ===== Kutish xonasida "boshlaymizmi?" =====
    // Botlar bilan to'lgan xonada odam "goo / boshla / start" deb yozsa,
    // botlardan biri odam kabi javob beradi va bir necha soniyadan keyin
    // o'yin boshlanadi (darhol emas).
    // Javob har safar boshqa bo'ladi — bir xil javob bot ekanini oshkor
    // qiladi.
    if (g.status === 'waiting' && !isBot(player) && START_ASK.test(text)) {
      const bots = (g.players || []).filter(isBot);
      if (bots.length && (g.players || []).length >= (g.minPlayers || 5) && !g.startAsked) {
        g.startAsked = true;
        await saveG(gameId, g);
        const bot = bots[crypto.randomInt(bots.length)];
        const reply = START_REPLIES[crypto.randomInt(START_REPLIES.length)];
        // 1.2-2.8 s — odam yozishga shuncha vaqt ketadi
        setTimeout(() => {
          botSay(gameId, bot, reply).catch(() => {});
          cancelBotStart(gameId);
          // Javobdan keyin DARHOL boshlanmaydi. Haqiqiy host "bosdim" deb
          // yozganidan keyin ham tugmani izlab bosguncha vaqt ketadi, va
          // xonadagilar "boshlanyapti" degan yozuvni ko'rib ulgurishi kerak.
          // Bir zumda boshlanish — botlar borligini oshkor qiladigan birinchi
          // belgi. 7-13 soniya shu uchun.
          armBotStart(gameId, 7000 + crypto.randomInt(6000));
          // Xonada "O'yin boshlanmoqda..." ko'rinsin — odam kutayotganini
          // bilib tursin, chat ichida javob yo'qolib ketmasin.
          withLock(gameId, async () => {
            const fresh = await getG(gameId);
            if (!fresh || fresh.status !== 'waiting') return;
            logEvent(fresh, '⏳', "O'yin boshlanmoqda...", 'startingSoon');
            await saveG(gameId, fresh);
            io.to(`game:${gameId}`).emit('game_state', publicGame(fresh));
          }).catch(() => {});
        }, typingMs(reply));
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
    // Botlar odamning gapini "eshitadi": ayblangan bot javob beradi, salomga
    // salom, komissar da'vosiga savol, mafiya kanalida sherik rozilik.
    botReactToHuman(gameId, g, player, text, channel).catch(() => {});
  });

  // ===== Do'st bot-o'yiniga qo'shilish so'rovi =====
  sOn('request_join_bot', async ({ hostUsername, userId, username, avatar } = {}) => {
    try {
      if (!guard(socket, 'joinreq', 3, 30000)) return socket.emit('bot_join_error', { message: 'Juda tez-tez so\'rov yubordingiz' });
      // Avtorizatsiya SHART. Ilgari token bo'lmasa `userId`/`username` MIJOZDAN
      // olinardi: istalgan socket boshqa odamning nomidan so'rov yuborib, uni
      // uch marta rad ettirib o'yinga kirishini butunlay bloklay olardi
      // (g.rejects userId bo'yicha saqlanadi).
      if (!socket.data.auth) return socket.emit('bot_join_error', { message: 'Avtorizatsiya kerak' });
      userId = socket.data.auth.userId;
      username = socket.data.auth.username;
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

  sOn('join_response', async ({ requestId, accept } = {}) => {
    if (!guard(socket, 'joinresp', 10, 5000)) return;
    const req = pendingJoins.get(requestId);
    if (!req) return;
    pendingJoins.delete(requestId);
    await withLock(req.gameId, async () => {
      const g = await getG(req.gameId);
      if (!g) { io.to(req.requesterSocketId).emit('bot_join_error', { message: 'O\'yin tugagan' }); return; }
      // Javob beruvchi — XONA EGASI bo'lishi shart. Ilgari faqat "o'yin
      // ichidagi odammi" tekshirilardi: so'rov xona egasiga yuborilsa ham,
      // xonadagi ISTALGAN odam uni tasdiqlab yoki rad etib yubora olardi
      // (do'stini o'zi chaqirmagan holda o'yinga kiritish yoki begonani
      // uch marta rad etib butunlay bloklash).
      const responder = g.players.find(p => p.socketId === socket.id && !p.isBot);
      if (!responder) return;
      if (g.hostId && responder.userId !== g.hostId && responder.isHost !== true) return;
      // Bloklangan yoki chiqarib yuborilgan odam qayta kira olmasin
      if (accept && (g.kicked?.[req.requesterUserId] || await isBanned(req.requesterUserId))) {
        io.to(req.requesterSocketId).emit('bot_join_error', { message: 'Siz bu o\'yinga qo\'shila olmaysiz' });
        return;
      }
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
  sOn('kick_player', ({ gameId, targetSocketId } = {}) => withLock(gameId, async () => {
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

  // ===== Jim qildirish (xona egasi, o'yin ichida ham) =====
  // `kick_player` faqat kutish xonasida ishlaydi (rollar muvozanati), shuning
  // uchun o'yin boshlangach suiiste'molga qarshi yagona chora shu.
  sOn('mute_player', ({ gameId, targetSocketId, on = true } = {}) => withLock(gameId, async () => {
    if (!guard(socket, 'mute', 20, 10000)) return;
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;
    const g = await getG(gameId);
    if (!g) return;
    if (g.hostId !== d.userId) {
      socket.emit('game_error', { code: 'notHost', message: 'Faqat xona egasi jim qildira oladi' });
      return;
    }
    const target = (g.players || []).find(p => p.socketId === targetSocketId);
    if (!target || target.userId === d.userId) return;
    g.muted = g.muted || {};
    if (on) g.muted[target.userId] = Date.now(); else delete g.muted[target.userId];
    logEvent(g, on ? '\u{1F507}' : '\u{1F509}',
      `${target.username} ${on ? 'jim qildirildi' : 'ovozi qaytarildi'}`,
      on ? 'playerMuted' : 'playerUnmuted', { name: target.username });
    await saveG(gameId, g);
    io.to(`game:${gameId}`).emit('game_state', publicGame(g));
    if (!isBot(target)) {
      io.to(target.socketId).emit('game_error', {
        code: on ? 'muted' : 'unmuted',
        message: on ? '\u{1F507} Xona egasi sizni jim qildirdi' : '\u{1F509} Jim qildirish bekor qilindi',
      });
    }
  }));

  // ===== Shikoyat =====
  // Ilgari o'yinchi suiiste'molni BILDIRA olmasdi — hech qanday kanal yo'q edi.
  //
  // Shikoyat kelishi o'yin YOZUVINI saqlab qoladi: ovozli chat, matnli chat va
  // to'liq o'yin tarixi. Shikoyat bo'lmasa yozuv o'chiriladi (disk).
  sOn('report_player', async ({ gameId, targetSocketId, type, reason } = {}) => {
    if (!guard(socket, 'report', 6, 60000)) return;
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;

    const kind = REPORT_TYPES.includes(type) ? type : 'other';

    // Nishonni topamiz. O'yin TUGAGAN bo'lishi mumkin (natija ekranidan
    // shikoyat qilinadi) — o'sha holda tugash paytidagi ro'yxatdan olamiz.
    const g = await getG(gameId);
    // DIQQAT: bot bu yerda CHIQARIB TASHLANMAYDI. Ilgari `&& !isBot(p)` bor edi
    // va botga qilingan shikoyat "topilmadi" bo'lib qaytardi — ya'ni pastdagi
    // butun maskalash mantiqiga umuman yetib bormasdi. Bot odam bilan bir xil
    // yo'ldan o'tishi kerak, farq faqat ko'rinmaydigan qismda bo'lsin.
    let target = (g?.players || []).find((p) => p.socketId === targetSocketId);
    if (!target) {
      const snap = endedPlayers.get(gameId);
      const t = snap?.[targetSocketId];
      if (t) target = { userId: t.userId, username: t.username };
    }
    // O'ZIGA shikoyat qilib bo'lmaydi (bu odam uchun ham, bot uchun ham bir xil)
    if (!target || target.userId === d.userId) {
      socket.emit('report_result', { ok: false, code: 'reportBad', message: 'Shikoyat yuborilmadi' });
      return;
    }

    // ===== BOT OSHKOR BO'LMASIN =====
    // Ilgari botga shikoyat HAR DOIM "Shikoyat yuborilmadi" berardi, odamga esa
    // "yuborildi". Ya'ni 🚩 tugmasi BEPUL VA CHEKSIZ BOT DETEKTORIGA aylangandi:
    // bir necha bosishda xonadagi hamma botni aniqlab olish mumkin edi.
    //
    // Endi bot ODAM BILAN BIR XIL yo'ldan o'tadi: kunlik chegara hisobi ham
    // yuritiladi (takroriy shikoyat ham bir xil javob beradi), javob ham aynan
    // bir xil. Farqi faqat ko'rinmaydigan qismda: yozuv saqlanmaydi va admin
    // bezovta qilinmaydi — botga qarshi chora ko'rishning ma'nosi yo'q.
    const targetIsBot = !isRealUser(target.userId);

    // ===== FLOOD HIMOYASI =====
    // Bitta odamga kuniga BIR MARTA; kuniga ko'pi bilan 20 ta TURLI odamga.
    const dayKey = repDayKey(d.userId);
    try {
      // DIQQAT: bu yerda POYGA bo'lmasligi kerak. Ilgari `sismember` bilan
      // tekshirilib, keyin `sadd` qilinardi — ikkisi orasida bir nechta
      // shikoyat o'tib ketardi va bitta odam bitta nishonga daqiqasiga
      // o'nlab shikoyat yozardi. `sadd` ning O'ZI atomik: 1 qaytarsa nishon
      // yangi, 0 qaytarsa bugun allaqachon shikoyat qilingan.
      const yangi = await redis.sadd(dayKey, String(target.userId));
      await redis.expire(dayKey, 36 * 3600);
      if (yangi === 0) {
        socket.emit('report_result', {
          ok: false, code: 'reportDup',
          message: 'Siz bu o\'yinchiga bugun allaqachon shikoyat qilgansiz',
        });
        return;
      }
      // Chegara qo'shilgandan KEYIN tekshiriladi; oshib ketgan bo'lsa
      // o'zimiz qo'shgan a'zoni qaytarib olamiz (hisob buzilmasin).
      if (await redis.scard(dayKey) > REPORT_DAILY_TARGETS) {
        try { await redis.srem(dayKey, String(target.userId)); } catch {}
        socket.emit('report_result', {
          ok: false, code: 'reportDaily', n: REPORT_DAILY_TARGETS,
          message: `Kuniga ko'pi bilan ${REPORT_DAILY_TARGETS} ta o'yinchiga shikoyat qilish mumkin`,
        });
        return;
      }
    } catch {
      // Redis uzilgan bo'lsa shikoyatni BLOKLAMAYMIZ — u chegaradan muhimroq
    }

    const why = cleanText(String(reason || ''), { maxLen: 300 });
    const entry = {
      at: Date.now(), gameId, type: kind,
      byId: d.userId, by: d.username,
      onId: target.userId, on: target.username,
      reason: why || '',
    };
    // BOTGA qilingan shikoyat saqlanmaydi (admin uchun ma'nosi yo'q), lekin
    // foydalanuvchi buni SEZMAYDI — javob va chegara hisobi bir xil.
    if (targetIsBot) {
      socket.emit('report_result', { ok: true, code: 'reportSent', message: 'Shikoyat yuborildi' });
      return;
    }
    try {
      await redis.rpush('reports', JSON.stringify(entry));
      await redis.ltrim('reports', -500, -1);
      // Shu o'yinning shikoyatlari — YOZUV SAQLANISHI uchun belgi ham shu
      await redis.rpush(repGameKey(gameId), JSON.stringify(entry));
      await redis.expire(repGameKey(gameId), recStore.LIMITS.keepDays * 86400);
    } catch {}

    // O'chirish taymeri qo'yilgan bo'lsa bekor qilamiz va dalilni saqlaymiz
    if (recDropTimers.has(gameId)) { clearTimeout(recDropTimers.get(gameId)); recDropTimers.delete(gameId); }
    if (recStore.isOpen(gameId)) {
      try {
        const rows = await redis.lrange(repGameKey(gameId), 0, -1);
        recStore.saveJson(gameId, 'reports', rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean));
      } catch {}
    }

    await logActivity(d.userId, 'report', { detail: `${target.username}: ${REPORT_LABEL[kind]}`, gameId });
    if (TG_ADMIN_BOT_TOKEN && TG_ADMIN_CHAT_ID) {
      tgApi('sendMessage', {
        chat_id: TG_ADMIN_CHAT_ID,
        text: `\u{1F6A9} <b>Shikoyat</b>\n${tgEsc(entry.by)} \u2192 <b>${tgEsc(entry.on)}</b>\n`
            + `Tur: <b>${tgEsc(REPORT_LABEL[kind])}</b>\n`
            + (why ? `Izoh: ${tgEsc(why)}\n` : '')
            + `Xona: <code>${tgEsc(gameId)}</code>\n`
            + (recStore.isOpen(gameId) ? '\u{1F3A4} Yozuv saqlandi' : 'Yozuv yo\'q'),
        parse_mode: 'HTML',
      }).catch(() => {});
    }
    socket.emit('report_result', { ok: true, code: 'reportSent', message: 'Shikoyat yuborildi' });
  });

  // ===== Ovozli chat signaling =====
  sOn('voice_join', ({ gameId } = {}) => {
    if (!guard(socket, 'vjoin', 5, 5000)) return;
    // Faqat o'sha xonaning o'yinchisi ovozli seansga qo'shila oladi — ilgari
    // begona odam "arvoh peer" bo'lib kirib, xonadagi socketId'lar ro'yxatini olardi
    const d = socketData.get(socket.id);
    if (!d?.gameId || d.gameId !== gameId) return;
    // Ovoz jazosi: mesh'ga UMUMAN kiritilmaydi. Shuning uchun o'zgartirilgan
    // mijoz ham gapira olmaydi — hech kim unga ulanmaydi.
    if (hasPenalty(d.userId, 'voice')) {
      socket.emit('game_error', { code: 'voiceBanned', message: '🔇 Ovozli chat vaqtincha taqiqlangan' });
      return;
    }
    const set = voicePeers.get(gameId) || new Set();
    // qo'shiluvchiga mavjud ovozli o'yinchilar ro'yxatini yuboramiz (u ularga ulanadi)
    socket.emit('voice_peers', { peers: [...set] });
    set.add(socket.id);
    voicePeers.set(gameId, set);
  });
  sOn('voice_leave', ({ gameId } = {}) => {
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
  sOn('voice_signal', ({ to, data } = {}) => {
    if (!guard(socket, 'vsig', 600, 10000)) return; // ICE ko'p bo'lishi mumkin — saxiy
    if (!voiceAllowed(to)) return;
    // SDP/ICE dan boshqa narsa uzatmaymiz: aks holda socket 1MB gacha ixtiyoriy
    // ma'lumotni boshqa o'yinchiga relay qilish kanaliga aylanardi
    if (!data || typeof data !== 'object' || (!data.sdp && !data.ice)) return;
    if (JSON.stringify(data).length > 16000) return;
    io.to(to).emit('voice_signal', { from: socket.id, data });
  });
  // "gapiryapti" indikatori — faqat ruxsat etilgan tinglovchilarga
  sOn('voice_talk', ({ to, on } = {}) => {
    if (!guard(socket, 'vtalk', 40, 5000)) return;
    if (!Array.isArray(to)) return;
    const d = socketData.get(socket.id);
    for (const sid of to.slice(0, 40)) {
      // Ikki shart: (1) ikkovi bir ovozli seansda, (2) hozir eshitishga HAQLI.
      // Ikkinchisi ilgari yo'q edi — tunda mafiya indikatori butun xonaga ketardi.
      if (voiceAllowed(sid) && canHearVoice(d?.gameId, socket.id, sid)) {
        io.to(sid).emit('voice_talk', { from: socket.id, on: !!on });
      }
    }
  });

  sOn('disconnect', async () => {
    console.log(`❌ ${socket.id}`);
    clearIdle(socket);
    PING_MS.delete(socket.id);
    PING_HIST.delete(socket.id);
    // IP ulanish hisobini kamaytiramiz (faqat hisoblangan ommaviy IP uchun)
    const ip = socket.data?.ip;
    if (ip && isPublicIp(ip)) { const n = (ipConns.get(ip) || 1) - 1; if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n); }
    const data = socketData.get(socket.id);
    socketData.delete(socket.id);
    // Sessiya reestri: faqat O'ZIMIZNIKI bo'lsa o'chiramiz. Boshqa qurilma
    // allaqachon o'rnimizni egallagan bo'lsa, uning yozuvi tegilmasligi shart.
    if (data?.userId && userSockets.get(data.userId) === socket.id) userSockets.delete(data.userId);
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
        if (p) {
          p.connected = false;
          // ---- Qaytishini kutish ----
          // O'yinchining interneti uzilsa, joriy faza BIR MARTA 60 soniyaga
          // uzaytiriladi — u qaytib ulgursin. Ikkinchi marta uzilganda kutilmaydi:
          // aks holda bitta odam qayta-qayta uzilib, butun o'yinni cho'zib
          // yuborardi va qolganlar zerikib ketardi.
          if (!p.graceUsed && p.isAlive !== false && g.phaseEndsAt) {
            p.graceUsed = true;
            g.phaseEndsAt += RECONNECT_GRACE_MS;
            if (timers.has(data.gameId)) clearTimeout(timers.get(data.gameId));
            const left = Math.max(1000, g.phaseEndsAt - Date.now());
            // FAZAGA MOS davomchi. Ilgari bu yerda har doim `onPhaseEnd`
            // qo'yilardi va u faqat 'day_discussion' ni bilardi — natijada
            // tungi bosqichda yoki natija ekranida uzilish xonani abadiy
            // muzlatardi (xonaning yagona taymeri yuqorida o'chirilgan).
            const resume = phaseResumer(g);
            timers.set(data.gameId, setTimeout(
              () => withLock(data.gameId, () => resume.fire(data.gameId)),
              left + graceFor(g)));
            io.to(`game:${data.gameId}`).emit('phase_extended', {
              username: p.username,
              endsAt: g.phaseEndsAt,
              seconds: Math.round(RECONNECT_GRACE_MS / 1000),
            });
          }
          await saveG(data.gameId, g);
        }
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
        if (!(g.players || []).some(p => !p.isBot)) { scheduleEmptyCheck(gameId); continue; }
        // Xonada ODAM bor va botlar bilan to'lgan: restartdan keyin "boshlash"
        // taymeri ham yo'qolgan. Qayta qurmasak xona lobbida abadiy kutib
        // qolardi — odam ichkarida o'tirib, o'yin hech qachon boshlanmaydi.
        if ((g.players || []).some(isBot) && g.players.length >= (g.minPlayers || 5)) {
          armBotStart(gameId, 8000 + crypto.randomInt(7000));
        }
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
      // Dispetcher `phaseResumer` da — disconnect bilan AYNI mantiq ishlatilsin
      // (ilgari ikki nusxa bor edi va faqat shu yerdagisi to'g'ri edi).
      const resume = phaseResumer(g);
      const { step, idx: stepIdx } = resume;
      // Holatni tiklaymiz: endNightStep birinchi navbatda `g.nightStep !== idx` ni
      // tekshiradi — normallashtirmasak u darhol qaytib ketib, o'yin muzlab qolardi.
      if (step && g.nightStep !== stepIdx) { g.nightStep = stepIdx; await saveG(gameId, g); }
      if (timers.has(gameId)) clearTimeout(timers.get(gameId));
      timers.set(gameId, setTimeout(() => withLock(gameId, () => resume.fire(gameId)), remain));
      // Xonada bot bo'lsa — joriy faza bot harakatlarini ham qayta rejalashtiramiz.
      //
      // DIQQAT: shart ilgari `g.vsBots` edi. Aynan shu xato startPhase va
      // startNightStep da allaqachon tuzatilgan (izohlari o'sha yerda), bu yerda
      // esa qolib ketgan edi. Natijasi: har deploy/restartdan keyin to'ldiruvchi
      // botli va botOnly xonalarda joriy faza bo'sh o'tardi — birorta bot ovoz
      // bermaydi, tunda hech kim harakat qilmaydi. Foydalanuvchi buni "hamma
      // birdan AFK bo'lib qoldi" deb ko'radi.
      if ((g.players || []).some(isBot)) {
        if (step) scheduleBotNightStep(gameId, stepIdx, dur(g, step.dur) * 1000, null, g);
        else if (phase === 'day_discussion') { scheduleBotDay(gameId, g); scheduleBotChat(gameId, g); }
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
  loadPenalties(); // amaldagi jazolar (chat/ovoz/rasm) keshini tiklaymiz
  recoverTimers(); // restart'dan keyin ketayotgan o'yinlarni davom ettiramiz
  // Dalil yozuvlari: katalog, hajm hisobi va tozalash jadvali
  {
    const r = recStore.init();
    if (r.ok) {
      console.log(`\u{1F3A4} Yozuvlar: ${recStore.LIMITS.dir} — ${r.totalMb} MB band, chegara ${recStore.LIMITS.maxTotalMb} MB`);
      // Soatiga bir marta: muddati o'tganini o'chiramiz, hajmni chegarada ushlaymiz.
      // KETAYOTGAN o'yinlarga tegilmaydi.
      const sweepTimer = setInterval(() => {
        try {
          const live = new Set(timers.keys());
          const res = recStore.sweep(live);
          if (res.ochirildi) console.log(`\u{1F9F9} ${res.ochirildi} ta eski yozuv o'chirildi (${res.hajmMb} MB qoldi)`);
          recStore.resync();   // xotiradagi hisob haqiqiy holatdan uzoqlashmasin
        } catch (e) { console.error('recSweep:', e?.message || e); }
        sweepOrphanRecordings().catch(() => {});
      }, 3600000);
      sweepTimer.unref?.();
      // Ishga tushgandan 1 daqiqa keyin birinchi tozalash
      setTimeout(() => { try { recStore.sweep(new Set(timers.keys())); } catch {} }, 60000).unref?.();
      // Restart qoldiqlari: o'yinlar tiklanib ulgurishi uchun 90 soniyadan keyin
      setTimeout(() => { sweepOrphanRecordings().catch(() => {}); }, 90000).unref?.();
    } else if (recStore.ON) {
      console.warn('Yozuvlar o\'chirilgan holatda ishlayapti:', r.reason);
    }
  }
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
    // Adminga XABAR BERAMIZ. Ilgari server jimgina qayta ishga tushardi:
    // barcha jonli o'yinlar yo'qolardi va egasi bundan hech qachon
    // xabar topmasdi (Telegram kanali esa allaqachon ishlab turibdi).
    if (TG_ADMIN_BOT_TOKEN && TG_ADMIN_CHAT_ID) {
      tgApi('sendMessage', {
        chat_id: TG_ADMIN_CHAT_ID,
        text: `\u{1F6A8} <b>Server qayta ishga tushmoqda</b>\nBir daqiqada 10 ta ushlanmagan xato.\n`
            + `Oxirgisi: <code>${tgEsc(String(e?.message || e).slice(0, 300))}</code>`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
    // Xabar ketishiga bir soniya beramiz, keyin chiqamiz
    setTimeout(() => process.exit(1), 1000).unref?.();
    return;
  }
}
process.on('uncaughtException', (e) => onFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => onFatal('unhandledRejection', e));

// SIGTERM: ochiq socketlar bor ekan `httpServer.close` callback'i HECH QACHON
// chaqirilmaydi (Socket.io ulanishlari uzoq yashaydi), ya'ni jarayon o'zi
// tugamasdi va pm2 har deploy'da uni `kill_timeout` dan keyin SIGKILL bilan
// uzardi. Endi: yangi ulanishlar to'xtaydi, mijozlarga xabar beriladi va
// jarayon belgilangan muddatda TOZA chiqadi.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} — to'xtatilmoqda...`);
  try { io.emit('server_restart', { message: 'Server yangilanmoqda — bir zumdan keyin qayta ulanadi' }); } catch {}
  try { httpServer.close(); } catch {}
  try { io.close(); } catch {}
  const done = () => {
    Promise.allSettled([prisma.$disconnect(), redis.quit()]).finally(() => process.exit(0));
  };
  setTimeout(done, 1500).unref?.();
  // Har qanday holatda 6 soniyada chiqamiz — pm2 SIGKILL gacha bormasin
  setTimeout(() => process.exit(0), 6000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

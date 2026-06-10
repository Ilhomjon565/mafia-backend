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

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'mafia-dev-secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1012676002382-21keol37nklhi22reit714nkgjb58dgm.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const prisma = new PrismaClient();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

app.use(cors());
app.use(express.json());

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
  minPlayers: 3,
  maxRooms: 50,
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

function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Avtorizatsiya kerak' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token yaroqsiz' });
  }
}

async function adminMiddleware(req, res, next) {
  if (!req.user?.userId) return res.status(401).json({ error: 'Avtorizatsiya kerak' });
  // DB — admin huquqining HAQIQIY manbasi. Token eskirgan bo'lishi mumkin
  // (foydalanuvchi hozirgina admin qilingan yoki adminlikdan olingan bo'lishi mumkin),
  // shuning uchun tokenga emas, bazadagi joriy qiymatga tayanamiz.
  const u = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!u?.isAdmin) return res.status(403).json({ error: 'Faqat admin' });
  next();
}

// ==================== AUTH ROUTES ====================

app.post('/api/register', async (req, res) => {
  try {
    let { username, password } = req.body;
    username = (username || '').trim();
    if (username.length < 2) return res.status(400).json({ error: 'Username kamida 2 belgi' });
    if (!password || password.length < 3) return res.status(400).json({ error: 'Parol kamida 3 belgi' });

    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) return res.status(409).json({ error: 'Bu username band' });

    // birinchi foydalanuvchi avtomatik admin
    const userCount = await prisma.user.count();
    const hash = await bcrypt.hash(password, 8);
    const user = await prisma.user.create({
      data: {
        username, password: hash,
        email: `${username.toLowerCase()}@mafia.local`,
        isAdmin: userCount === 0,
        items: DEFAULT_ITEMS,
        stats: { create: {} }
      }
    });
    res.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin, items: normItems(user.items), token: signToken(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Bu username band' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    let { username, password } = req.body;
    username = (username || '').trim();
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (user.isBanned) return res.status(403).json({ error: 'Siz bloklangansiz' });
    const ok = await bcrypt.compare(password || '', user.password);
    if (!ok) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeen: new Date() } }).catch(() => {});
    res.json({ userId: user.id, username: user.username, isAdmin: user.isAdmin, token: signToken(user) });
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

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential yo\'q' });

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
      const userCount = await prisma.user.count();
      const username = await uniqueUsername(fullName.replace(/\s+/g, '') || email.split('@')[0]);
      const randomPass = await bcrypt.hash(Math.random().toString(36) + Date.now(), 8);
      user = await prisma.user.create({
        data: {
          username,
          email,
          password: randomPass,
          avatar: picture,
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
      token: signToken(user)
    });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Bu hisob allaqachon mavjud' });
    res.status(500).json({ error: e.message });
  }
});

// ALOHIDA ADMIN PANEL LOGIN (faqat admin huquqiga ega foydalanuvchilar)
app.post('/api/admin/login', async (req, res) => {
  try {
    let { username, password } = req.body;
    username = (username || '').trim();
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin huquqi yo\'q' });
    if (user.isBanned) return res.status(403).json({ error: 'Hisob bloklangan' });
    const ok = await bcrypt.compare(password || '', user.password);
    if (!ok) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeen: new Date() } }).catch(() => {});
    res.json({ userId: user.id, username: user.username, isAdmin: true, token: signToken(user) });
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
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: 1000 }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🛒 do'kon — tangaga item sotib olish
app.post('/api/shop/buy', authMiddleware, async (req, res) => {
  try {
    const { item } = req.body;
    if (!ITEM_KEYS.includes(item)) return res.status(400).json({ error: 'Noma\'lum buyum' });
    const price = ECONOMY.prices[item];
    const u = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    if ((u.coins ?? 0) < price) return res.status(400).json({ error: 'Tanga yetarli emas' });
    const items = normItems(u.items);
    items[item] = (items[item] || 0) + 1;
    const updated = await prisma.user.update({
      where: { id: u.id },
      data: { coins: { decrement: price }, items }
    });
    res.json({ ok: true, coins: updated.coins, items: normItems(updated.items) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🎁 kunlik bonus — kuniga bir marta
app.post('/api/daily-bonus', authMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    if (u.lastBonusAt && new Date(u.lastBonusAt) >= startOfDay) {
      return res.status(429).json({ error: 'Bugungi bonus allaqachon olingan' });
    }
    const updated = await prisma.user.update({
      where: { id: u.id },
      data: { coins: { increment: ECONOMY.dailyBonus }, lastBonusAt: new Date() }
    });
    res.json({ ok: true, coins: updated.coins, bonus: ECONOMY.dailyBonus });
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

// reyting jadvali (public)
app.get('/api/leaderboard', async (_, res) => {
  try {
    const top = await prisma.userStats.findMany({
      orderBy: { rating: 'desc' }, take: 20,
      include: { user: { select: { username: true } } }
    });
    res.json(top.map(s => ({
      username: s.user.username, rating: s.rating,
      gamesPlayed: s.gamesPlayed, gamesWon: s.gamesWon, winRate: s.winRate
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== GAME REST ROUTES ====================

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// hydrate: redis yo'q bo'lsa postgres dan tiklash (faqat waiting xonalar uchun)
async function getG(gameId) {
  const r = await redis.get(`game:${gameId}`);
  if (r) return JSON.parse(r);
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return null;
  if (game.status === 'waiting') {
    const settings = await getSettings();
    const state = {
      ...game, players: [], phase: 'waiting',
      dayVotes: {}, nightActions: {}, round: 0,
      durations: settings.durations, log: []
    };
    await saveG(gameId, state);
    return state;
  }
  // playing/finished holati yo'qolgan — tugatilgan deb hisoblaymiz
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
    const list = enriched.filter(Boolean);
    await redis.set('cache:games', JSON.stringify(list), 'EX', 3).catch(() => {});
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// yangi xona yaratish (ko'p xona ruxsat etilgan)
app.post('/api/games', authMiddleware, async (req, res) => {
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
        totalPlayers, maxPlayers: 20, minPlayers: settings.minPlayers || 3,
        mafiaCount, sheriffCount, doctorCount, civilCount
      }
    });
    const state = {
      ...game, players: [], phase: 'waiting', roleConfig: roleConfig || null,
      dayVotes: {}, nightActions: {}, round: 0, durations: settings.durations, log: []
    };
    await saveG(game.id, state);
    res.json(game);
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
    io.to(`game:${id}`).emit('game_closed', { message: 'Xona egasi xonani yopdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    await redis.del(`game:${id}`).catch(() => {});
    await prisma.game.delete({ where: { id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const g = await getG(req.params.id);
    if (!g) return res.status(404).json({ error: 'Xona topilmadi yoki tugagan' });
    res.json({ ...g, players: publicPlayers(g.players || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN ROUTES ====================

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
    res.json({ users, banned, admins, totalGames, activeGames, finishedGames, mafiaWins, civilWins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (_, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { stats: true }
    });
    const settings = await getSettings();
    const defaultRoomLimit = settings.dailyRoomLimit || 2;
    const overrides = (await redis.hgetall('roomlimits').catch(() => ({}))) || {};
    res.json(users.map(u => ({
      id: u.id, username: u.username, email: u.email,
      avatar: u.avatar || null,
      isAdmin: u.isAdmin, isBanned: u.isBanned,
      createdAt: u.createdAt, lastSeen: u.lastSeen,
      items: normItems(u.items),
      roomLimit: overrides[u.id] != null ? parseInt(overrides[u.id]) : null, // null = default ishlatiladi
      defaultRoomLimit,
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: 1000 }
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: 'Topilmadi' });
    const updated = await prisma.user.update({ where: { id: u.id }, data: { isBanned: !u.isBanned } });
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
    res.json({ id: req.params.id, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'O\'zingizni o\'chira olmaysiz' });
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/games', authMiddleware, adminMiddleware, async (_, res) => {
  try {
    const games = await prisma.game.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const enriched = await Promise.all(games.map(async g => {
      const raw = await redis.get(`game:${g.id}`);
      const state = raw ? JSON.parse(raw) : null;
      return {
        id: g.id, name: g.name, status: g.status, winner: g.winner,
        totalPlayers: g.totalPlayers, createdAt: g.createdAt, startedAt: g.startedAt, endedAt: g.endedAt,
        hasState: !!state, livePlayers: state?.players?.length || 0, phase: state?.phase || null
      };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// xonani majburan to'xtatish
app.post('/api/admin/games/:id/stop', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.game.update({ where: { id }, data: { status: 'finished', endedAt: new Date() } }).catch(() => {});
    io.to(`game:${id}`).emit('game_closed', { message: 'Admin tomonidan xona yopildi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    await redis.del(`game:${id}`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// xonani butunlay o'chirish
app.delete('/api/admin/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    io.to(`game:${id}`).emit('game_closed', { message: 'Admin xonani o\'chirdi' });
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    await redis.del(`game:${id}`).catch(() => {});
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

// ==================== PER-GAME LOCK ====================
// Bir xona holatini bir vaqtda o'zgartirishdan saqlaydi (race condition oldini oladi)
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  chains.set(key, next.catch(() => {}));
  return next;
}

function publicPlayers(players) {
  return players.map(p => ({
    socketId: p.socketId,
    userId: p.userId,
    username: p.username,
    avatar: p.avatar || null,
    isAlive: p.isAlive,
    connected: p.connected !== false,
    isHost: p.isHost === true,
    role: p.isAlive ? null : p.role
  }));
}

// ==================== ROLLAR (performance_arts) ====================
// taraf: town | mafia | killer | wolf
const ROLE_SIDE = {
  civil: 'town', escort: 'town', sergeant: 'town', komissar: 'town', doctor: 'town', daydi: 'town', afsungar: 'town',
  don: 'mafia', mafia: 'mafia', advokat: 'mafia',
  qotil: 'killer', bori: 'wolf',
  sheriff: 'town', // eski o'yinlar uchun
};
const ROLE_NAMES = {
  civil: '👨🏼 Tinch aholi', escort: '💃 Kezuvchi', sergeant: '👮🏻‍♂️ Serjant',
  komissar: '🕵🏻‍♂️ Komissar', doctor: '👨🏻‍⚕️ Doktor', daydi: '🧙‍♂️ Daydi', afsungar: '🧞‍♂️ Afsungar',
  don: '🤵🏻 Don', mafia: '🤵🏼 Mafiya', advokat: '👨‍💼 Advokat',
  qotil: '🔪 Qotil', bori: '🐺 Bo\'ri', sheriff: '🕵🏻‍♂️ Komissar',
};
function roleName(r) { return ROLE_NAMES[r] || r; }
function sideOf(r) { return ROLE_SIDE[r] || 'town'; }

function checkWin(g) {
  const alive = g.players.filter(p => p.isAlive);
  const town = alive.filter(p => sideOf(p.role) === 'town').length;
  const mafia = alive.filter(p => sideOf(p.role) === 'mafia').length;
  const killer = alive.filter(p => sideOf(p.role) === 'killer').length;
  const wolf = alive.filter(p => sideOf(p.role) === 'wolf').length;
  // 🔪 Qotil faqat yakka qolsa g'olib
  if (killer > 0 && alive.length === killer) return 'killer';
  // betaraflar (qotil/bo'ri) tirik ekan town/mafiya g'alaba qila olmaydi
  if (mafia === 0 && killer === 0 && wolf === 0) return 'town';
  if (killer === 0 && mafia > 0 && mafia >= town + wolf) return 'mafia';
  return null;
}

// o'lim sababiga qarab kim o'ldirgani yorlig'i (tong e'lonida ko'rsatiladi)
const KILLER_LABEL = {
  mafia:    '🔫 Mafiya',
  killer:   '🔪 Qotil',
  komissar: '🕵🏻‍♂️ Komissar',
  afsungar: '🧞‍♂️ Afsungar',
};
function killerLabel(cause) { return KILLER_LABEL[cause] || 'Kimdir'; }

// ochiq voqealar jurnali — hamma tungi/kunduzgi harakatlarni ko'radi
function logEvent(g, icon, text) {
  if (!g.log) g.log = [];
  g.log.push({ round: g.round || 0, icon, text, t: Date.now() });
  if (g.log.length > 120) g.log.shift();
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
async function loadUserItems(userId) {
  if (!userId || String(userId).startsWith('guest-')) return { shield: 0, lupa: 0, life: 0 };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { items: true } }).catch(() => null);
  return normItems(u?.items);
}
async function adjustUserItems(userId, deltas) {
  if (!userId || String(userId).startsWith('guest-')) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { items: true } }).catch(() => null);
  if (!u) return null;
  const items = normItems(u.items);
  for (const [k, v] of Object.entries(deltas)) if (ITEM_KEYS.includes(k)) items[k] = Math.max(0, (items[k] || 0) + v);
  await prisma.user.update({ where: { id: userId }, data: { items } }).catch(() => {});
  return items;
}

// O'yinchilar soniga qarab rollar to'plamini tuzadi (avto, balanslangan).
// Mafiya har doim ozchilik; maxsus rollar va betaraflar o'yin kattalashgani sayin qo'shiladi.
function buildRoleList(n) {
  const roles = [];
  roles.push('komissar');                 // shahar himoyachisi
  roles.push('don');                      // mafiya boshlig'i
  if (n >= 4) roles.push('doctor');
  // qo'shimcha mafiya (don bilan birga ~28%)
  const mafiaSide = Math.max(1, Math.round(n * 0.28));
  for (let i = 1; i < mafiaSide; i++) {
    if (i === mafiaSide - 1 && n >= 8) roles.push('advokat');
    else roles.push('mafia');
  }
  // shahar maxsus rollari (kattalik bo'yicha)
  if (n >= 6) roles.push('sergeant');
  if (n >= 7) roles.push('escort');
  if (n >= 9) roles.push('daydi');
  if (n >= 12) roles.push('afsungar');
  // betaraflar
  if (n >= 8) roles.push('qotil');
  if (n >= 11) roles.push('bori');
  // qolgan joylar — tinch aholi
  while (roles.length < n) roles.push('civil');
  // ortib ketsa kesib tashlaymiz (yuqoridagi tartib muhimroq rollarni saqlaydi)
  roles.length = n;
  return roles;
}

// host xona yaratganda qo'lda tanlay oladigan rollar (civil avtomatik to'ldiriladi)
const SELECTABLE_ROLES = ['komissar', 'sergeant', 'doctor', 'escort', 'daydi', 'afsungar', 'don', 'mafia', 'advokat', 'qotil', 'bori'];

// { role: count } ni tekshirib normalizatsiya qiladi. Yaroqsiz bo'lsa null.
function normalizeRoleConfig(roles, total) {
  if (!roles || typeof roles !== 'object') return null;
  const cfg = {}; let sum = 0;
  for (const r of SELECTABLE_ROLES) {
    const c = Math.max(0, Math.min(total, parseInt(roles[r]) || 0));
    if (c > 0) { cfg[r] = c; sum += c; }
  }
  if (sum === 0 || sum > total) return null;
  const mafiaSide = SELECTABLE_ROLES.filter(r => sideOf(r) === 'mafia').reduce((a, r) => a + (cfg[r] || 0), 0);
  if (mafiaSide < 1) return null;            // kamida 1 mafiya bo'lishi shart
  if (mafiaSide >= total) return null;       // mafiya hammasi bo'lib qolmasin
  cfg.civil = total - sum;                   // qolgani tinch aholi
  return cfg;
}

function assignRoles(players, roleConfig) {
  const n = players.length;
  let roleList = null;
  // host qo'lda rol tanlagan bo'lsa va maxsus rollar soniga sig'sa — o'shani ishlatamiz
  if (roleConfig) {
    const specials = [];
    for (const [role, count] of Object.entries(roleConfig)) {
      if (role === 'civil') continue;
      for (let i = 0; i < count; i++) specials.push(role);
    }
    if (specials.length <= n) {
      roleList = specials.slice();
      while (roleList.length < n) roleList.push('civil');
    }
  }
  // aks holda — o'yinchilar soniga qarab avto balans
  if (!roleList) roleList = buildRoleList(n);
  // aralashtirish
  for (let i = roleList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
  }
  return players.map((p, i) => ({ ...p, role: roleList[i] || 'civil', roleData: {} }));
}

function dur(g, phase) {
  return (g.durations && g.durations[phase]) || DEFAULT_SETTINGS.durations[phase];
}

// ==================== KETMA-KET TUNGI BOSQICHLAR ====================
// Tun navbat bilan o'tadi: avval mafiya kelishadi, keyin komissar, doktor va h.k.
// Har bosqichda faqat o'sha rol harakat qiladi, qolganlar kutadi.
// Rol o'yinda bo'lmasa — qisqa "...siz" o'tish ko'rsatiladi.
const NIGHT_STEPS = [
  { phase: 'night_mafia',    roles: ['don', 'mafia'], dur: 'night_mafia',    noun: 'Mafiya' },
  { phase: 'night_komissar', roles: ['komissar'],     dur: 'night_komissar', noun: 'Komissar' },
  { phase: 'night_doctor',   roles: ['doctor'],       dur: 'night_doctor',   noun: 'Doktor' },
  { phase: 'night_escort',   roles: ['escort'],       dur: 'night_escort',   noun: 'Kezuvchi' },
  { phase: 'night_advokat',  roles: ['advokat'],      dur: 'night_advokat',  noun: 'Advokat' },
  { phase: 'night_qotil',    roles: ['qotil'],        dur: 'night_qotil',    noun: 'Qotil' },
  { phase: 'night_daydi',    roles: ['daydi'],         dur: 'night_daydi',    noun: 'Daydi' },
];
function nightStepByPhase(phase) { return NIGHT_STEPS.find(s => s.phase === phase); }

// shu bosqich roli o'yinda (tirik) bormi?
function stepHasActor(g, step) {
  return g.players.some(p => p.isAlive && step.roles.includes(p.role));
}

// bosqich tugadimi? (rol o'z amalini bajardimi)
// mafiya uchun: barcha tirik mafiya bir XIL nishonga ovoz bergan bo'lsa (konsensus) — erta tugaydi.
// kelisha olmasa — vaqt tugaguncha kutadi, keyin hech kim o'lmaydi.
function nightStepComplete(g, step) {
  const na = g.nightActions || {};
  if (step.phase === 'night_mafia') {
    const aliveMafia = g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia');
    if (!aliveMafia.length) return true;
    const votes = na.mafiaVotes || {};
    const first = votes[aliveMafia[0].socketId];
    return !!first && aliveMafia.every(p => votes[p.socketId] === first);
  }
  const keyByPhase = {
    night_komissar: 'komissar', night_doctor: 'doctor', night_escort: 'escort',
    night_advokat: 'lawyer', night_qotil: 'killer', night_daydi: 'daydi',
  };
  return !!na[keyByPhase[step.phase]];
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
    phase, endsAt, duration: d, round: g.round, players: publicPlayers(g.players), log: g.log
  });

  // kunduz boshlandi — komissarning kechagi tekshiruv natijasini endi yuboramiz
  if (phase === 'day_discussion' && g.nightCheck) {
    const recipients = g.players.filter(p => p.isAlive && (p.role === 'komissar' || p.role === 'sergeant'));
    for (const r of recipients) io.to(r.socketId).emit('sheriff_result', g.nightCheck);
    delete g.nightCheck;
    await saveG(gameId, g);
  }

  if (timers.has(gameId)) clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(() => onPhaseEnd(gameId, phase), d * 1000));
}

async function onPhaseEnd(gameId, phase) {
  const g = await getG(gameId);
  if (!g) return;

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
    if (eliminated) {
      const p = g.players.find(p => p.socketId === eliminated || p.userId === eliminated);
      if (p && p.isAlive) {
        if ((p.items?.life || 0) > 0) {
          // qo'shimcha jon — chiqarilishdan saqlaydi
          p.items.life--;
          await adjustUserItems(p.userId, { life: -1 });
          io.to(p.socketId).emit('your_items', { items: p.items });
          msg = `☀️ ${p.username} chiqarilmoqchi edi, lekin qo'shimcha joni bilan omon qoldi!`;
          result = { eliminated: null, role: null, saved: true };
          logEvent(g, '❤️', `${p.username} qo'shimcha jon bilan ovozdan omon qoldi!`);
        } else {
          p.isAlive = false;
          msg = `☀️ ${p.username} ovoz bilan o'ldirildi — ${roleName(p.role)}`;
          result = { eliminated: p.username, role: p.role };
          logEvent(g, '⚖️', `${p.username} ovoz bilan chiqarildi — u ${roleName(p.role)} edi`);
          // 🗣️ Oxirgi so'z — chiqarilgan o'yinchi day_results davomida bitta ochiq xabar yozadi
          g.lastWordSid = p.socketId;
          io.to(p.socketId).emit('your_last_word', {});
          // 🧞‍♂️ Afsungar ovozда o'ldirilsa — o'zi bilan birovni olib ketadi
          if (p.role === 'afsungar') {
            const victims = g.players.filter(x => x.isAlive && x.socketId !== p.socketId);
            if (victims.length) {
              const v = victims[Math.floor(Math.random() * victims.length)];
              v.isAlive = false;
              msg += ` · 🧞‍♂️ Afsungar ${v.username}ni o'zi bilan olib ketdi!`;
              logEvent(g, '🧞‍♂️', `Afsungar qasos oldi — ${v.username} ham o'ldi (${roleName(v.role)})`);
            }
          }
        }
      }
    } else {
      msg = skipped ? '☀️ Shahar hech kimni chiqarmaslikka qaror qildi'
        : tie ? '☀️ Ovozlar teng — hech kim o\'lmadi'
        : '☀️ Hech kim ovoz bermadi';
      logEvent(g, '🤝', skipped ? 'Ovoz o\'tkazib yuborildi — hech kim chiqarilmadi' : tie ? 'Ovozlar teng — hech kim chiqarilmadi' : 'Hech kim ovoz bermadi');
    }

    g.dayVotes = {};
    await saveG(gameId, g);

    const winner = checkWin(g);
    if (winner) return endGame(gameId, winner);

    io.to(`game:${gameId}`).emit('phase_change', {
      phase: 'day_results', endsAt: Date.now() + dur(g, 'day_results') * 1000,
      duration: dur(g, 'day_results'), round: g.round,
      players: publicPlayers(g.players), message: msg, result, log: g.log
    });
    if (timers.has(gameId)) clearTimeout(timers.get(gameId));
    timers.set(gameId, setTimeout(() => startNight(gameId), dur(g, 'day_results') * 1000));

  } else if (phase === 'night') {
    await processNight(gameId);
  }
}

async function processNight(gameId) {
  const g = await getG(gameId);
  if (!g) return;
  const na = g.nightActions || {};
  const find = (sid) => g.players.find(p => p.socketId === sid);
  const nameOf = (sid) => find(sid)?.username || '—';
  const aliveT = (sid) => { const p = find(sid); return p && p.isAlive ? p : null; };

  logEvent(g, '🌙', `${g.round}-kecha tushdi`);
  const deaths = []; // {sid, cause}

  // 1) 💃 Kezuvchi bloki (Komissarni bloklay olmaydi)
  const blocked = new Set();
  if (na.escort?.target) {
    const t = find(na.escort.target);
    if (t && t.role !== 'komissar') { blocked.add(t.socketId); logEvent(g, '💃', `Kezuvchi ${t.username}ni band qildi`); }
  }
  const notBlocked = (by) => by && !blocked.has(by);

  // 2) 👨‍💼 Advokat himoyasi (mafiyani Komissardan yashiradi)
  const lawyerProtect = (na.lawyer && notBlocked(na.lawyer.by)) ? na.lawyer.target : null;

  // 3) 🤵 Mafiya o'ldirish nishoni — mafialar KELISHISHI shart.
  // Barcha tirik (bloklanmagan) mafiya bir XIL nishonga ovoz bersa — o'sha o'ladi.
  // Kelisha olmasalar (ovozlar bo'linsa) — hech kim o'lmaydi.
  let mafiaKill = null;
  {
    const votes = na.mafiaVotes || {};
    const aliveMafia = g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia');
    const active = aliveMafia.filter(p => !blocked.has(p.socketId)); // kezuvchi bloklaganlar sanalmaydi
    const picks = active.map(p => votes[p.socketId]).filter(Boolean);
    const unanimous = active.length > 0 && picks.length === active.length && picks.every(v => v === picks[0]);
    if (unanimous) {
      const target = aliveT(picks[0]);
      if (target && sideOf(target.role) !== 'mafia') mafiaKill = picks[0];
    } else if (aliveMafia.length && picks.length) {
      // ovoz berishgan, lekin kelisha olmaganlar
      logEvent(g, '🤝', 'Mafiya kelisha olmadi — bu kecha hech kimni o\'ldirmadi');
    }
  }
  if (mafiaKill) deaths.push({ sid: mafiaKill, cause: 'mafia' });

  // 4) 🔪 Qotil o'ldirish
  if (na.killer && notBlocked(na.killer.by)) {
    const t = aliveT(na.killer.target);
    if (t && sideOf(t.role) !== 'killer') deaths.push({ sid: t.socketId, cause: 'killer' });
  }

  // 5) 🕵️ Komissar — tekshirish yoki otish
  if (na.komissar && notBlocked(na.komissar.by)) {
    const kom = find(na.komissar.by);
    const t = find(na.komissar.target);
    if (t) {
      if (na.komissar.type === 'shoot') {
        deaths.push({ sid: t.socketId, cause: 'komissar' });
        logEvent(g, '🔫', `Komissar ${t.username}ga o'q uzdi`);
      } else {
        const seenMafia = sideOf(t.role) === 'mafia' && lawyerProtect !== t.socketId;
        if (kom) { kom.roleData = kom.roleData || {}; kom.roleData.checked = true; }
        // natija KUNDUZI (day_discussion boshlanganda) komissar/serjantga yuboriladi
        g.nightCheck = { username: t.username, isMafia: seenMafia };
        logEvent(g, '🔵', `Komissar kimnidir tekshirdi`);
      }
    }
  }

  // 6) 👨🏻‍⚕️ Doktor davolash nishoni
  const healTarget = (na.doctor && notBlocked(na.doctor.by)) ? na.doctor.target : null;
  if (healTarget) logEvent(g, '💚', `Doktor ${nameOf(healTarget)}nikiga bordi`);

  // 7) 🧙 Daydi guvohligi
  if (na.daydi && notBlocked(na.daydi.by)) logEvent(g, '🧙‍♂️', `Daydi ${nameOf(na.daydi.target)} oldiga bordi`);

  // ===== O'limlarni hal qilamiz =====
  // killed: { name, cause } — tongda "kim kimni o'ldirgani" e'lon qilinadi
  const killed = [], killedNames = [], savedNames = [], processed = new Set();
  for (const d of deaths) {
    const t = aliveT(d.sid);
    if (!t || processed.has(t.socketId)) continue;
    // 🔫 Komissar o'qi — qutqarib bo'lmaydi (qalqon/doktor/qo'shimcha jon ta'sir qilmaydi)
    const unstoppable = d.cause === 'komissar';
    if (!unstoppable && t.shieldActive) { savedNames.push(t.username); logEvent(g, '🛡️', `${t.username} qalqon bilan omon qoldi`); continue; }
    if (!unstoppable && healTarget === t.socketId) { savedNames.push(t.username); logEvent(g, '✅', `Doktor ${t.username}ni qutqardi`); continue; }
    if (!unstoppable && (t.items?.life || 0) > 0) {
      t.items.life--; await adjustUserItems(t.userId, { life: -1 });
      io.to(t.socketId).emit('your_items', { items: t.items });
      savedNames.push(t.username); logEvent(g, '❤️', `${t.username} qo'shimcha jon bilan tirik qoldi`); continue;
    }
    // 🐺 Bo'ri reenkarnatsiyasi
    if (t.role === 'bori') {
      if (d.cause === 'mafia') { t.role = 'mafia'; processed.add(t.socketId); logEvent(g, '🐺', `Bo'ri mafiya o'qidan Mafiyaga aylandi`); io.to(t.socketId).emit('your_role', { role: 'mafia' }); continue; }
      if (d.cause === 'komissar') { t.role = 'sergeant'; processed.add(t.socketId); logEvent(g, '🐺', `Bo'ri Komissar o'qidan Serjantga aylandi`); io.to(t.socketId).emit('your_role', { role: 'sergeant' }); continue; }
      // qotil → o'ladi (pastda)
    }
    // o'ldi
    t.isAlive = false; processed.add(t.socketId);
    killedNames.push(t.username); killed.push({ name: t.username, cause: d.cause });
    logEvent(g, '💀', `${killerLabel(d.cause)} ${t.username}ni o'ldirdi — u ${roleName(t.role)} edi`);
    // 🧞‍♂️ Afsungar — o'ldirgan o'yinchini o'zi bilan olib ketadi
    if (t.role === 'afsungar') {
      let revengeSid = null;
      if (d.cause === 'killer') revengeSid = na.killer?.by;
      else if (d.cause === 'komissar') revengeSid = na.komissar?.by;
      else if (d.cause === 'mafia') { const don = g.players.find(p => p.isAlive && p.role === 'don') || g.players.find(p => p.isAlive && sideOf(p.role) === 'mafia'); revengeSid = don?.socketId; }
      const rv = aliveT(revengeSid);
      if (rv) { rv.isAlive = false; processed.add(rv.socketId); killedNames.push(rv.username); killed.push({ name: rv.username, cause: 'afsungar' }); logEvent(g, '🧞‍♂️', `Afsungar ${rv.username}ni o'zi bilan olib ketdi (${roleName(rv.role)})`); }
    }
  }

  // 👮 Serjant — Komissar o'lgan bo'lsa uning o'rnini egallaydi
  if (!g.players.some(p => p.isAlive && p.role === 'komissar')) {
    const sgt = g.players.find(p => p.isAlive && p.role === 'sergeant');
    if (sgt) { sgt.role = 'komissar'; logEvent(g, '👮🏻‍♂️', `Serjant ${sgt.username} Komissar bo'ldi`); io.to(sgt.socketId).emit('your_role', { role: 'komissar' }); }
  }

  g.players.forEach(p => { p.shieldActive = false; });

  let msg;
  if (killed.length) msg = '🌅 ' + killed.map(k => `${killerLabel(k.cause)} ${k.name}ni o'ldirdi`).join(' · ');
  else if (savedNames.length) msg = '🌅 Hujum bo\'ldi, lekin qutqarildi';
  else { msg = '🌅 Kecha tinch o\'tdi'; logEvent(g, '🕊️', 'Kecha tinch o\'tdi'); }
  const result = { killed: killedNames[0] || null, killedAll: killedNames, killedInfo: killed, saved: savedNames.length > 0 };

  await saveG(gameId, g);
  const winner = checkWin(g);
  if (winner) return endGame(gameId, winner);

  io.to(`game:${gameId}`).emit('phase_change', {
    phase: 'night_results', endsAt: Date.now() + dur(g, 'night_results') * 1000,
    duration: dur(g, 'night_results'), round: g.round,
    players: publicPlayers(g.players), message: msg, result, log: g.log
  });
  if (timers.has(gameId)) clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(() => startPhase(gameId, 'day_discussion'), dur(g, 'night_results') * 1000));
}

// ===== Ketma-ket tunni boshlash =====
async function startNight(gameId) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;
  g.nightActions = {};
  g.nightStep = -1;
  delete g.lastWordSid;
  logEvent(g, '🌙', `${g.round}-kecha tushdi — shahar uxlaydi`);
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
    players: publicPlayers(g.players), log: g.log,
    present, stepNoun: step.noun,
  });

  if (timers.has(gameId)) clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(() => withLock(gameId, () => endNightStep(gameId, idx)), d * 1000));
}

// bosqichni yakunlab keyingisiga o'tadi (vaqt tugaganda yoki rol harakat qilganda)
async function endNightStep(gameId, idx) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;
  if (g.nightStep !== idx) return; // allaqachon o'tib bo'lingan
  if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
  await startNightStep(gameId, idx + 1);
}

async function recordStats(g, winner) {
  for (const p of g.players) {
    if (!p.userId || String(p.userId).startsWith('guest-')) continue;
    const won = winner === sideOf(p.role) || (winner === 'civil' && sideOf(p.role) === 'town');
    const reward = won ? ECONOMY.winReward : ECONOMY.loseReward;
    try {
      await prisma.userStats.upsert({
        where: { userId: p.userId },
        create: { userId: p.userId, gamesPlayed: 1, gamesWon: won ? 1 : 0, winRate: won ? 100 : 0, rating: 1000 + (won ? 25 : -15) },
        update: { gamesPlayed: { increment: 1 }, gamesWon: { increment: won ? 1 : 0 }, rating: { increment: won ? 25 : -15 } }
      });
      const s = await prisma.userStats.findUnique({ where: { userId: p.userId } });
      if (s && s.gamesPlayed > 0) {
        await prisma.userStats.update({
          where: { userId: p.userId },
          data: { winRate: Math.round((s.gamesWon / s.gamesPlayed) * 1000) / 10 }
        });
      }
      // 🪙 tanga mukofoti + o'yin tarixi
      await prisma.user.update({ where: { id: p.userId }, data: { coins: { increment: reward } } });
      await prisma.gameHistory.create({
        data: { userId: p.userId, gameId: g.id, role: p.role || 'civil', won, winner: winner || '', coins: reward }
      });
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
  }[w] || 'O\'yin tugadi';
}

async function endGame(gameId, winner) {
  const g = await getG(gameId);
  if (!g) return;
  g.status = 'finished';
  g.winner = winner;
  g.endedAt = Date.now();
  await saveG(gameId, g);
  prisma.game.update({ where: { id: gameId }, data: { status: 'finished', winner, endedAt: new Date() } }).catch(() => {});
  await recordStats(g, winner);
  io.to(`game:${gameId}`).emit('game_over', {
    winner, players: g.players, log: g.log,
    message: winnerMessage(winner)
  });
  if (timers.has(gameId)) { clearTimeout(timers.get(gameId)); timers.delete(gameId); }
  setTimeout(() => redis.del(`game:${gameId}`).catch(() => {}), 30000);
}

// ==================== SOCKET.IO ====================

const socketData = new Map();

io.on('connection', (socket) => {
  console.log(`✅ ${socket.id}`);

  socket.on('join_game', ({ gameId, userId, username }) => withLock(gameId, async () => {
    try {
      // bloklangan foydalanuvchini tekshirish
      if (userId && !String(userId).startsWith('guest-')) {
        const u = await prisma.user.findUnique({ where: { id: userId } }).catch(() => null);
        if (u?.isBanned) { socket.emit('game_error', { message: 'Siz bloklangansiz' }); return; }
      }

      const key = `game:${gameId}`;
      const g = await getG(gameId);
      if (!g) { socket.emit('game_error', { message: 'O\'yin topilmadi yoki tugagan' }); return; }
      if (!g.players) g.players = [];

      const matchPlayer = () => g.players.find(p =>
        (userId && p.userId === userId) || p.username === username
      );

      if (g.status === 'playing' || g.status === 'finished') {
        const existing = matchPlayer();
        if (existing) {
          existing.socketId = socket.id;
          existing.connected = true;
          socketData.set(socket.id, { userId, username: existing.username, gameId });
          socket.join(key);
          await saveG(gameId, g);
          socket.emit('game_state', { ...g, players: publicPlayers(g.players) });
          socket.emit('your_role', { role: existing.role });
          socket.emit('your_items', { items: existing.items || { shield: 0, lupa: 0, life: 0 } });
          // reconnectda ham mafiyaga sheriklarini qayta yuboramiz (socketId yangilangan bo'lishi mumkin)
          if (sideOf(existing.role) === 'mafia') {
            const mafiaList = g.players.filter(p => sideOf(p.role) === 'mafia').map(p => ({ socketId: p.socketId, username: p.username, role: p.role }));
            socket.emit('mafia_team', { mates: mafiaList });
          }
          if (g.phaseEndsAt && g.status === 'playing') {
            const step = nightStepByPhase(g.phase);
            socket.emit('phase_change', {
              phase: g.phase, endsAt: g.phaseEndsAt,
              duration: (step ? dur(g, step.dur) : dur(g, g.phase)) || 0, round: g.round,
              players: publicPlayers(g.players),
              present: step ? (g.nightPresent !== false) : undefined,
              stepNoun: step ? step.noun : undefined,
            });
          }
          if (g.status === 'finished') {
            socket.emit('game_over', {
              winner: g.winner, players: g.players,
              message: winnerMessage(g.winner)
            });
          }
          io.to(key).emit('game_state', { ...g, players: publicPlayers(g.players) });
          return;
        }
        socket.emit('game_error', { message: 'O\'yin boshlangan — kira olmaysiz' });
        return;
      }

      // LOBBY
      const existing = matchPlayer();
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socketData.set(socket.id, { userId, username: existing.username, gameId });
        socket.join(key);
        await saveG(gameId, g);
        socket.emit('game_state', { ...g, players: publicPlayers(g.players) });
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
      await saveG(gameId, g);
      socketData.set(socket.id, { userId: player.userId, username: player.username, gameId });
      socket.join(key);

      io.to(key).emit('game_state', { ...g, players: publicPlayers(g.players) });
      io.to(key).emit('player_joined', { username: player.username, total: g.players.length });
    } catch (e) {
      console.error('join_game:', e);
      socket.emit('game_error', { message: e.message });
    }
  }));

  socket.on('start_game', ({ gameId }) => withLock(gameId, async () => {
    try {
      const g = await getG(gameId);
      if (!g) return;
      const settings = await getSettings();
      const min = settings.minPlayers || 3;
      if (g.players.length < min) { socket.emit('game_error', { message: `Kamida ${min} o'yinchi` }); return; }
      // faqat host boshlay oladi (host yo'q bo'lsa har kim)
      const starter = g.players.find(p => p.socketId === socket.id);
      if (g.hostId && starter && starter.userId !== g.hostId && !starter.isHost) {
        socket.emit('game_error', { message: 'Faqat xona egasi boshlay oladi' }); return;
      }
      g.players = assignRoles(g.players, g.roleConfig);
      g.status = 'playing';
      g.round = 0; g.nightActions = {}; g.dayVotes = {}; g.log = [];
      // har bir o'yinchining buyumlarini bazadan o'yin holatiga yuklaymiz
      for (const p of g.players) { p.items = await loadUserItems(p.userId); p.shieldActive = false; }
      logEvent(g, '🎭', 'O\'yin boshlandi — rollar tarqatildi');
      await saveG(gameId, g);
      prisma.game.update({ where: { id: gameId }, data: { status: 'playing', startedAt: new Date() } }).catch(() => {});
      const mafiaList = g.players.filter(p => sideOf(p.role) === 'mafia').map(p => ({ socketId: p.socketId, username: p.username, role: p.role }));
      g.players.forEach(p => {
        io.to(p.socketId).emit('your_role', { role: p.role });
        io.to(p.socketId).emit('your_items', { items: p.items });
        // mafiya tomoni (Don, Mafiya, Advokat) bir-birini ko'rsin
        if (sideOf(p.role) === 'mafia') io.to(p.socketId).emit('mafia_team', { mates: mafiaList });
      });
      io.to(`game:${gameId}`).emit('game_starting', {});
      setTimeout(() => startPhase(gameId, 'day_discussion'), 5000);
    } catch (e) { console.error('start_game:', e); }
  }));

  socket.on('day_vote', ({ gameId, targetSocketId }) => withLock(gameId, async () => {
    try {
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
      await saveG(gameId, g);

      const counts = {};
      Object.values(g.dayVotes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const aliveCount = g.players.filter(p => p.isAlive).length;
      io.to(`game:${gameId}`).emit('vote_update', { counts, totalVoters: Object.keys(g.dayVotes).length, aliveCount });
      socket.emit('action_confirmed', { message: targetSocketId === 'skip' ? '⏭ O\'tkazib yuborildi' : '✅ Ovoz berildi' });

      if (Object.keys(g.dayVotes).length >= aliveCount) {
        if (timers.has(gameId)) clearTimeout(timers.get(gameId));
        onPhaseEnd(gameId, 'day_discussion');
      }
    } catch (e) { console.error('day_vote:', e); }
  }));

  socket.on('night_action', ({ gameId, targetSocketId, actionType }) => withLock(gameId, async () => {
    try {
      const g = await getG(gameId);
      if (!g) return;
      const step = nightStepByPhase(g.phase);
      if (!step) return; // hozir tungi harakat fazasi emas
      const player = g.players.find(p => p.socketId === socket.id);
      if (!player || !player.isAlive) return;
      // faqat shu bosqich roli harakat qila oladi
      if (!step.roles.includes(player.role)) { socket.emit('game_error', { message: '⏳ Hozir sizning navbatingiz emas' }); return; }
      if (!g.nightActions) g.nightActions = {};
      const na = g.nightActions;
      const target = g.players.find(p => p.socketId === targetSocketId);
      const targetAlive = target && target.isAlive;

      switch (player.role) {
        case 'don':
        case 'mafia': {
          if (!targetAlive || sideOf(target.role) === 'mafia') { socket.emit('game_error', { message: '❌ Mafiyaga ovoz berib bo\'lmaydi' }); return; }
          if (!na.mafiaVotes) na.mafiaVotes = {};
          na.mafiaVotes[socket.id] = targetSocketId;
          socket.emit('action_confirmed', { message: `🔫 Ovozingiz: ${target.username}` });
          // mafiya sheriklarga joriy ovozlarni ko'rsatamiz (kelishish uchun)
          const mafiaVotesView = {};
          for (const m of g.players.filter(p => p.isAlive && sideOf(p.role) === 'mafia')) {
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
          if (!targetAlive) return;
          const type = actionType === 'shoot' ? 'shoot' : 'check';
          if (type === 'shoot' && !(player.roleData && player.roleData.checked) && (g.round || 1) <= 1) {
            socket.emit('game_error', { message: '❌ Birinchi tun: avval tekshiring, otib bo\'lmaydi' }); return;
          }
          na.komissar = { by: socket.id, type, target: targetSocketId };
          socket.emit('action_confirmed', { message: type === 'shoot' ? `🔫 ${target.username}ga otish` : `🔍 ${target.username}ni tekshirish` });
          break;
        }
        case 'doctor': {
          if (!targetAlive) return;
          if (targetSocketId === socket.id) {
            if (player.roleData?.selfHeal) { socket.emit('game_error', { message: '❌ O\'zingizni faqat bir marta davolaysiz' }); return; }
            player.roleData = player.roleData || {}; player.roleData.selfHeal = true;
          }
          na.doctor = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { message: `💚 ${target.username} davolanadi` });
          break;
        }
        case 'escort': {
          if (!targetAlive || targetSocketId === socket.id) return;
          if (target.role === 'komissar') { socket.emit('game_error', { message: '❌ Komissarni band qila olmaysiz' }); return; }
          na.escort = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { message: `💃 ${target.username} band qilindi` });
          break;
        }
        case 'advokat': {
          if (!targetAlive) return;
          na.lawyer = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { message: `👨‍💼 ${target.username} himoyalanadi` });
          break;
        }
        case 'qotil': {
          if (!targetAlive || targetSocketId === socket.id) return;
          na.killer = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { message: `🔪 ${target.username} nishonda` });
          break;
        }
        case 'daydi': {
          if (!targetAlive || targetSocketId === socket.id) return;
          na.daydi = { by: socket.id, target: targetSocketId };
          socket.emit('action_confirmed', { message: `🧙‍♂️ ${target.username} oldiga bording` });
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

  socket.on('use_item', ({ gameId, item, targetSocketId }) => withLock(gameId, async () => {
    try {
      const g = await getG(gameId);
      if (!g || g.status !== 'playing') return;
      const p = g.players.find(x => x.socketId === socket.id);
      if (!p || !p.isAlive) return;
      if (!p.items) p.items = { shield: 0, lupa: 0, life: 0 };
      if ((p.items[item] || 0) <= 0) { socket.emit('item_result', { item, ok: false, message: '❌ Bu buyum sizda yo\'q' }); return; }

      if (item === 'shield') {
        p.items.shield--;
        p.shieldActive = true;
        await adjustUserItems(p.userId, { shield: -1 });
        socket.emit('item_result', { item, ok: true, message: '🛡️ Qalqon yoqildi — bu kecha mafiyadan himoyalangansiz' });
      } else if (item === 'lupa') {
        const t = g.players.find(x => x.socketId === targetSocketId);
        if (!t) { socket.emit('item_result', { item, ok: false, message: '❌ Avval o\'yinchini tanlang' }); return; }
        p.items.lupa--;
        await adjustUserItems(p.userId, { lupa: -1 });
        socket.emit('item_result', { item, ok: true, target: t.username, role: t.role, message: `🔍 ${t.username} → ${roleName(t.role)}` });
      } else {
        socket.emit('item_result', { item, ok: false, message: 'Bu buyum avtomatik ishlaydi' });
        return;
      }

      await saveG(gameId, g);
      socket.emit('your_items', { items: p.items });
    } catch (e) { console.error('use_item:', e); }
  }));

  socket.on('chat_message', async ({ gameId, message }) => {
    const data = socketData.get(socket.id);
    if (!data) return;
    const text = String(message || '').trim().slice(0, 300);
    if (!text) return;
    const g = await getG(gameId);
    const player = g?.players.find(p => p.socketId === socket.id);
    if (!player) return;

    // 🗣️ Oxirgi so'z — chiqarilgan o'yinchi day_results davomida bitta OCHIQ xabar yozadi
    if (g.lastWordSid && socket.id === g.lastWordSid && g.phase === 'day_results') {
      delete g.lastWordSid;
      await saveG(gameId, g);
      io.to(`game:${gameId}`).emit('chat_message', {
        username: data.username, message: text, channel: 'public', isAlive: false, lastWord: true, timestamp: Date.now()
      });
      return;
    }

    const isNight = String(g.phase || '').startsWith('night');
    // KANALLAR: public (kunduzgi ochiq), mafia (tunda faqat mafiya), dead (o'liklar)
    let channel;
    if (!player.isAlive) channel = 'dead';
    else if (isNight) {
      if (sideOf(player.role) === 'mafia') channel = 'mafia';
      else { socket.emit('game_error', { message: '🌙 Tunda faqat mafiya gaplasha oladi' }); return; }
    } else channel = 'public';

    const payload = { username: data.username, message: text, channel, isAlive: player.isAlive, timestamp: Date.now() };

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

  socket.on('disconnect', async () => {
    console.log(`❌ ${socket.id}`);
    const data = socketData.get(socket.id);
    socketData.delete(socket.id);
    if (!data?.gameId) return;
    await withLock(data.gameId, async () => {
      const g = await getG(data.gameId);
      if (!g) return;
      if (g.status === 'waiting') {
        g.players = g.players.filter(p => p.socketId !== socket.id);
        await saveG(data.gameId, g);
        io.to(`game:${data.gameId}`).emit('game_state', { ...g, players: publicPlayers(g.players) });
        io.to(`game:${data.gameId}`).emit('player_left', { username: data.username });
      } else if (g.status === 'playing') {
        const p = g.players.find(p => p.socketId === socket.id);
        if (p) { p.connected = false; await saveG(data.gameId, g); }
        io.to(`game:${data.gameId}`).emit('player_offline', { username: data.username });
      }
    });
  });
});

// ==================== START ====================

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`
  🎭 MAFIA PLATFORMASI - BACKEND
  ==============================
  🌐 http://localhost:${PORT}
  🏠 Ko'p xona | 👑 Admin panel | 📊 Statistika
  Ready! 🎮
  `);
});

process.on('SIGTERM', () => httpServer.close(() => { prisma.$disconnect(); redis.disconnect(); }));

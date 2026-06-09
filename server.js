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
    night_mafia:    20,
    night_doctor:   20,
    night_sheriff:  20,
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
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Faqat admin' });
  // double-check in DB (token could be stale)
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
    const dailyLimit = settings.dailyRoomLimit || 2;
    const roomsToday = await prisma.game.count({ where: { hostId: u.id, createdAt: { gte: startOfDay } } });
    res.json({
      userId: u.id, username: u.username, isAdmin: u.isAdmin, isBanned: u.isBanned,
      avatar: u.avatar || null,
      items: normItems(items),
      dailyLimit, roomsToday, roomsLeft: Math.max(0, dailyLimit - roomsToday),
      stats: u.stats || { gamesPlayed: 0, gamesWon: 0, winRate: 0, rating: 1000 }
    });
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
    res.json(enriched.filter(Boolean));
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
    const DAILY_LIMIT = settings.dailyRoomLimit || 2;
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({ error: `Kuniga maksimum ${DAILY_LIMIT} ta xona yaratish mumkin. Mavjud xonaga qo'shiling.` });
    }

    let { name, totalPlayers, mafiaCount, sheriffCount, doctorCount, isPrivate } = req.body;
    totalPlayers = Math.max(5, Math.min(20, parseInt(totalPlayers) || 8));
    mafiaCount   = Math.max(1, Math.min(totalPlayers - 2, parseInt(mafiaCount) || Math.ceil(totalPlayers * settings.defaultRoles.mafiaRatio)));
    sheriffCount = Math.max(0, parseInt(sheriffCount ?? settings.defaultRoles.sheriffCount));
    doctorCount  = Math.max(0, parseInt(doctorCount ?? settings.defaultRoles.doctorCount));
    const civilCount = Math.max(0, totalPlayers - mafiaCount - sheriffCount - doctorCount);

    const game = await prisma.game.create({
      data: {
        name: (name || '').trim().slice(0, 40) || `${req.user.username} xonasi`,
        status: 'waiting', hostId: req.user.userId, isPrivate: !!isPrivate,
        totalPlayers, maxPlayers: 20, minPlayers: settings.minPlayers || 3,
        mafiaCount, sheriffCount, doctorCount, civilCount
      }
    });
    const state = {
      ...game, players: [], phase: 'waiting',
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
    res.json(users.map(u => ({
      id: u.id, username: u.username, email: u.email,
      isAdmin: u.isAdmin, isBanned: u.isBanned,
      createdAt: u.createdAt, lastSeen: u.lastSeen,
      items: normItems(u.items),
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
    isAlive: p.isAlive,
    connected: p.connected !== false,
    isHost: p.isHost === true,
    role: p.isAlive ? null : p.role
  }));
}

function checkWin(g) {
  const alive = g.players.filter(p => p.isAlive);
  const mafia = alive.filter(p => p.role === 'mafia').length;
  const civil = alive.filter(p => p.role !== 'mafia').length;
  if (mafia === 0) return 'civil';
  if (mafia >= civil) return 'mafia';
  return null;
}

function roleName(r) {
  return { mafia: 'Mafiya', sheriff: 'Komissar', doctor: 'Doktor', civil: 'Fuqaro' }[r] || r;
}

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

function assignRoles(players, mafiaCount, sheriffCount, doctorCount) {
  const s = [...players].sort(() => Math.random() - 0.5);
  return s.map((p, i) => {
    let role = 'civil';
    if (i < mafiaCount) role = 'mafia';
    else if (i < mafiaCount + sheriffCount) role = 'sheriff';
    else if (i < mafiaCount + sheriffCount + doctorCount) role = 'doctor';
    return { ...p, role };
  });
}

function dur(g, phase) {
  return (g.durations && g.durations[phase]) || DEFAULT_SETTINGS.durations[phase];
}

async function startPhase(gameId, phase) {
  const g = await getG(gameId);
  if (!g || g.status === 'finished') return;

  if (phase === 'night_doctor' && !g.players.some(p => p.isAlive && p.role === 'doctor')) {
    return startPhase(gameId, 'night_sheriff');
  }
  if (phase === 'night_sheriff' && !g.players.some(p => p.isAlive && p.role === 'sheriff')) {
    return processNight(gameId);
  }

  const d = dur(g, phase);
  const endsAt = Date.now() + d * 1000;
  g.phase = phase;
  g.phaseEndsAt = endsAt;

  if (phase === 'day_discussion') {
    g.dayVotes = {};
    g.round = (g.round || 0) + 1;
    g.status = 'playing';
  } else if (phase === 'night_mafia') {
    g.nightActions = {};
  }

  await saveG(gameId, g);
  io.to(`game:${gameId}`).emit('phase_change', {
    phase, endsAt, duration: d, round: g.round, players: publicPlayers(g.players), log: g.log
  });

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
        }
      }
    } else {
      msg = tie ? '☀️ Ovozlar teng — hech kim o\'lmadi' : '☀️ Hech kim ovoz bermadi';
      logEvent(g, '🤝', tie ? 'Ovozlar teng — hech kim chiqarilmadi' : 'Hech kim ovoz bermadi');
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
    timers.set(gameId, setTimeout(() => startPhase(gameId, 'night_mafia'), dur(g, 'day_results') * 1000));

  } else if (phase === 'night_mafia') {
    // mafiya ovozlarini sanaymiz: eng ko'p (yagona) ovoz olgan o'ladi; teng/durang bo'lsa hech kim
    const votes = g.nightActions.mafiaVotes || {};
    const tally = {};
    for (const sid of Object.keys(votes)) {
      const tgt = votes[sid];
      const target = g.players.find(p => p.socketId === tgt);
      if (target && target.isAlive && target.role !== 'mafia') {
        tally[tgt] = (tally[tgt] || 0) + 1;
      }
    }
    let best = null, max = 0, tie = false;
    for (const tgt of Object.keys(tally)) {
      if (tally[tgt] > max) { max = tally[tgt]; best = tgt; tie = false; }
      else if (tally[tgt] === max) { tie = true; }
    }
    g.nightActions.mafiaTarget = (best && !tie) ? best : null;
    await saveG(gameId, g);
    await startPhase(gameId, 'night_doctor');

  } else if (phase === 'night_doctor') {
    await saveG(gameId, g);
    await startPhase(gameId, 'night_sheriff');

  } else if (phase === 'night_sheriff') {
    await saveG(gameId, g);
    await processNight(gameId);
  }
}

async function processNight(gameId) {
  const g = await getG(gameId);
  if (!g) return;
  const { mafiaTarget, doctorTarget, sheriffTarget } = g.nightActions || {};
  let msg, result = { killed: null, saved: false };
  const nameOf = (sid) => g.players.find(p => p.socketId === sid)?.username || '—';

  logEvent(g, '🌙', `${g.round}-kecha tushdi`);

  // 🔵 Komissar tekshiruvi (natija ochiq ko'rsatiladi)
  if (sheriffTarget) {
    const checked = g.players.find(p => p.socketId === sheriffTarget);
    if (checked) logEvent(g, '🔵', `Komissar ${checked.username}ni tekshirdi → ${checked.role === 'mafia' ? '🔴 MAFIYA!' : '🟢 tinch'}`);
  } else if (g.players.some(p => p.isAlive && p.role === 'sheriff')) {
    logEvent(g, '🔵', 'Komissar bu kecha hech kimni tekshirmadi');
  }

  // 💚 Doktor harakati
  if (doctorTarget) {
    logEvent(g, '💚', `Doktor ${nameOf(doctorTarget)}nikiga bordi`);
  } else if (g.players.some(p => p.isAlive && p.role === 'doctor')) {
    logEvent(g, '💚', 'Doktor bu kecha hech kimnikiga bormadi');
  }

  // 🔫 Mafiya hujumi natijasi (qalqon → doktor → qo'shimcha jon ketma-ketligida himoya)
  if (mafiaTarget) {
    const t = g.players.find(p => p.socketId === mafiaTarget);
    if (t && t.isAlive) {
      logEvent(g, '🔫', `Mafiya ${t.username}ga hujum qildi`);
      if (t.shieldActive) {
        msg = `🌙 Mafiya hujum qildi, lekin ${t.username} qalqon bilan himoyalandi!`;
        result.saved = true;
        logEvent(g, '🛡️', `${t.username} qalqon bilan o'limdan qutuldi!`);
      } else if (doctorTarget === mafiaTarget) {
        msg = `🌙 Mafiya hujum qildi, lekin doktor ${t.username}ni qutqardi!`;
        result.saved = true;
        logEvent(g, '✅', `${t.username} doktor tomonidan qutqarildi!`);
      } else if ((t.items?.life || 0) > 0) {
        t.items.life--;
        await adjustUserItems(t.userId, { life: -1 });
        io.to(t.socketId).emit('your_items', { items: t.items });
        msg = `🌙 Mafiya hujum qildi, lekin ${t.username} qo'shimcha joni bilan omon qoldi!`;
        result.saved = true;
        logEvent(g, '❤️', `${t.username} qo'shimcha jon bilan tirik qoldi!`);
      } else {
        t.isAlive = false;
        msg = `🌙 Kechasi ${t.username} o'ldirildi`;
        result.killed = t.username;
        logEvent(g, '💀', `${t.username} o'ldirildi — u ${roleName(t.role)} edi`);
      }
    } else { msg = '🌙 Kecha tinch o\'tdi'; logEvent(g, '🕊️', 'Kecha tinch o\'tdi'); }
  } else { msg = '🌙 Kecha tinch o\'tdi'; logEvent(g, '🕊️', 'Mafiya hech kimga tegmadi'); }

  // qalqonlar bir kecha amal qiladi — tozalaymiz
  g.players.forEach(p => { p.shieldActive = false; });

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

async function recordStats(g, winner) {
  for (const p of g.players) {
    if (!p.userId || String(p.userId).startsWith('guest-')) continue;
    const won = (winner === 'mafia' && p.role === 'mafia') || (winner === 'civil' && p.role !== 'mafia');
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
    } catch {}
  }
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
    message: winner === 'mafia' ? '🔫 Mafiya g\'alaba qildi!' : '🎉 Tinch aholi g\'alaba qildi!'
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
          if (existing.role === 'mafia') {
            const mafiaList = g.players.filter(p => p.role === 'mafia').map(p => ({ socketId: p.socketId, username: p.username }));
            socket.emit('mafia_team', { mates: mafiaList });
          }
          if (g.phaseEndsAt && g.status === 'playing') {
            socket.emit('phase_change', {
              phase: g.phase, endsAt: g.phaseEndsAt,
              duration: dur(g, g.phase) || 0, round: g.round,
              players: publicPlayers(g.players)
            });
          }
          if (g.status === 'finished') {
            socket.emit('game_over', {
              winner: g.winner, players: g.players,
              message: g.winner === 'mafia' ? '🔫 Mafiya g\'alaba qildi!' : '🎉 Tinch aholi g\'alaba qildi!'
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
      const player = {
        socketId: socket.id,
        userId: userId || 'guest-' + socket.id.slice(0, 6),
        username: username || 'O\'yinchi-' + socket.id.slice(0, 4),
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
      g.players = assignRoles(g.players, g.mafiaCount, g.sheriffCount, g.doctorCount);
      g.status = 'playing';
      g.round = 0; g.nightActions = {}; g.dayVotes = {}; g.log = [];
      // har bir o'yinchining buyumlarini bazadan o'yin holatiga yuklaymiz
      for (const p of g.players) { p.items = await loadUserItems(p.userId); p.shieldActive = false; }
      logEvent(g, '🎭', 'O\'yin boshlandi — rollar tarqatildi');
      await saveG(gameId, g);
      prisma.game.update({ where: { id: gameId }, data: { status: 'playing', startedAt: new Date() } }).catch(() => {});
      const mafiaList = g.players.filter(p => p.role === 'mafia').map(p => ({ socketId: p.socketId, username: p.username }));
      g.players.forEach(p => {
        io.to(p.socketId).emit('your_role', { role: p.role });
        io.to(p.socketId).emit('your_items', { items: p.items });
        // mafiyalar bir-birini ko'rsin
        if (p.role === 'mafia') io.to(p.socketId).emit('mafia_team', { mates: mafiaList });
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
      g.dayVotes[socket.id] = targetSocketId;
      await saveG(gameId, g);

      const counts = {};
      Object.values(g.dayVotes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const aliveCount = g.players.filter(p => p.isAlive).length;
      io.to(`game:${gameId}`).emit('vote_update', { counts, totalVoters: Object.keys(g.dayVotes).length, aliveCount });
      socket.emit('action_confirmed', { message: '✅ Ovoz berildi' });

      if (Object.keys(g.dayVotes).length >= aliveCount) {
        if (timers.has(gameId)) clearTimeout(timers.get(gameId));
        onPhaseEnd(gameId, 'day_discussion');
      }
    } catch (e) { console.error('day_vote:', e); }
  }));

  socket.on('night_action', ({ gameId, targetSocketId }) => withLock(gameId, async () => {
    try {
      const g = await getG(gameId);
      if (!g) return;
      const player = g.players.find(p => p.socketId === socket.id);
      if (!player || !player.isAlive) return;
      const phase = g.phase;
      if (!g.nightActions) g.nightActions = {};

      if (phase === 'night_mafia' && player.role === 'mafia') {
        const target = g.players.find(p => p.socketId === targetSocketId);
        // mafiya boshqa mafiyaga ovoz bera olmaydi
        if (!target || !target.isAlive || target.role === 'mafia') {
          socket.emit('game_error', { message: '❌ Mafiyaga ovoz berib bo\'lmaydi' });
          return;
        }
        if (!g.nightActions.mafiaVotes) g.nightActions.mafiaVotes = {};
        g.nightActions.mafiaVotes[socket.id] = targetSocketId;
        socket.emit('action_confirmed', { message: `🔫 Ovozingiz: ${target.username}` });
        await saveG(gameId, g);
        // barcha tirik mafiya ovoz bergan bo'lsa fazani erta tugatamiz
        const aliveMafia = g.players.filter(p => p.isAlive && p.role === 'mafia');
        const voted = aliveMafia.filter(p => g.nightActions.mafiaVotes[p.socketId]);
        if (voted.length >= aliveMafia.length) {
          if (timers.has(gameId)) clearTimeout(timers.get(gameId));
          onPhaseEnd(gameId, phase);
        }
        return;
      }

      if (phase === 'night_doctor' && player.role === 'doctor') {
        g.nightActions.doctorTarget = targetSocketId;
        socket.emit('action_confirmed', { message: '💚 Davolash belgilandi' });
      } else if (phase === 'night_sheriff' && player.role === 'sheriff') {
        g.nightActions.sheriffTarget = targetSocketId;
        const checked = g.players.find(p => p.socketId === targetSocketId);
        if (checked) socket.emit('sheriff_result', { username: checked.username, isMafia: checked.role === 'mafia' });
        socket.emit('action_confirmed', { message: '🔍 Tekshirildi' });
      } else return;

      await saveG(gameId, g);
      if (timers.has(gameId)) clearTimeout(timers.get(gameId));
      onPhaseEnd(gameId, phase);
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
    // o'liklar faqat o'liklar bilan; tiriklar hammasi ko'radi (kechasi ham real-time chat)
    io.to(`game:${gameId}`).emit('chat_message', {
      username: data.username, message: text, isAlive: player.isAlive, timestamp: Date.now()
    });
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

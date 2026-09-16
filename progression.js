// ==================== DARAJA (XP) VA REYTING (ELO) ====================
// Sof modul — IO yo'q, shuning uchun to'g'ridan-to'g'ri testlanadi
// (progression.test.mjs). rules.js bilan bir xil yondashuv.
//
// ATAYLAB IKKI XIL O'LCHOV. Ular turli savolga javob beradi va bir-birini
// almashtira olmaydi:
//
//   XP / DARAJA  — "qancha o'ynagansiz". Hech qachon kamaymaydi. Yangi
//                  o'yinchi yutqazsa ham oldinga siljiydi, ya'ni o'yinni
//                  tashlab ketishga sabab bo'lmaydi.
//   REYTING (Elo) — "qanchalik yaxshi o'ynaysiz". Kamayishi mumkin.
//                  Reyting jadvali shunga quriladi, chunki faqat XP bo'yicha
//                  saralansa jadval "eng ko'p vaqt sarflagan" odamni
//                  ko'rsatadi, eng kuchlisini emas.

// ---------- XP ----------

export const XP = {
  finish: 10,     // o'yinni oxirigacha o'ynagani uchun
  win: 25,        // g'alaba
  survive: 8,     // oxirigacha tirik qolgani uchun
  perRound: 2,    // har bir raund uchun
  maxRounds: 15,  // cho'zilib ketgan o'yin XP fermasiga aylanmasin
};

// Bitta o'yin uchun XP. Hech qachon manfiy bo'lmaydi.
export function xpForGame({ won = false, survived = false, rounds = 0 } = {}) {
  const r = Math.max(0, Math.min(XP.maxRounds, Math.floor(rounds) || 0));
  return XP.finish
    + (won ? XP.win : 0)
    + (survived ? XP.survive : 0)
    + r * XP.perRound;
}

// Daraja egri chizig'i: n-darajaga chiqish uchun 50*(n-1)^2 XP kerak.
// 2-daraja 50 XP, 5-daraja 800, 10-daraja 4050 — boshida tez, keyin sekin.
export function xpForLevel(level) {
  const n = Math.max(1, Math.floor(level) || 1);
  return 50 * (n - 1) * (n - 1);
}

export function levelFromXp(xp) {
  const v = Math.max(0, Math.floor(xp) || 0);
  return Math.floor(Math.sqrt(v / 50)) + 1;
}

// Interfeys uchun: joriy daraja, keyingisigacha qancha qolgani va foiz.
export function levelProgress(xp) {
  const v = Math.max(0, Math.floor(xp) || 0);
  const level = levelFromXp(v);
  const cur = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = next - cur;
  return {
    level,
    xp: v,
    into: v - cur,          // shu darajada to'plangani
    need: span,             // keyingi darajagacha jami kerak
    left: next - v,         // qolgani
    percent: span > 0 ? Math.min(100, Math.round(((v - cur) / span) * 100)) : 100,
  };
}

// ---------- REYTING (Elo) ----------

export const RATING_START = 1000;
export const RATING_FLOOR = 100; // reyting nolga tushib ketmasin

// K-koeffitsient: yangi o'yinchi tez o'z o'rnini topsin, tajribalisi
// bitta o'yindan keskin sakramasin.
export function kFactor(gamesPlayed = 0) {
  const n = Math.max(0, Math.floor(gamesPlayed) || 0);
  if (n < 10) return 40;
  if (n < 30) return 32;
  return 24;
}

// Kutilgan natija: raqib kuchliroq bo'lsa g'alaba qimmatroq turadi.
export function expectedScore(mine, opponent) {
  return 1 / (1 + Math.pow(10, (opponent - mine) / 400));
}

// Bitta o'yin uchun reyting o'zgarishi.
// `opponent` — qolgan o'yinchilarning o'rtacha reytingi.
export function eloDelta({ rating = RATING_START, opponent = RATING_START, won = false, gamesPlayed = 0 } = {}) {
  const k = kFactor(gamesPlayed);
  const exp = expectedScore(rating, opponent);
  const delta = Math.round(k * ((won ? 1 : 0) - exp));
  // Kamida 1 ochko: g'olib hech qachon 0 olmasin, yutqazgan hech qachon
  // yutmasin — aks holda kuchli o'yinchi zaiflarni yengib turib qotib qoladi.
  if (won && delta < 1) return 1;
  if (!won && delta > -1) return -1;
  return delta;
}

export function applyElo(rating, delta) {
  return Math.max(RATING_FLOOR, (rating || RATING_START) + delta);
}

// ---------- LIGALAR ----------
// Nom emas, KALIT qaytariladi — matn frontendda, foydalanuvchi tilida chiziladi.

export const TIERS = [
  { key: 'bronze',   min: 0 },
  { key: 'silver',   min: 900 },
  { key: 'gold',     min: 1100 },
  { key: 'platinum', min: 1300 },
  { key: 'diamond',  min: 1500 },
  { key: 'master',   min: 1700 },
  { key: 'legend',   min: 1900 },
];

export function tierOf(rating) {
  const r = Number.isFinite(rating) ? rating : RATING_START;
  let out = TIERS[0];
  for (const t of TIERS) if (r >= t.min) out = t;
  return out.key;
}

// Ligadagi o'sish foizi — interfeysdagi chiziq uchun.
export function tierProgress(rating) {
  const r = Number.isFinite(rating) ? rating : RATING_START;
  const i = TIERS.findIndex((t) => t.key === tierOf(r));
  const cur = TIERS[i];
  const next = TIERS[i + 1];
  if (!next) return { tier: cur.key, next: null, percent: 100, left: 0 };
  const span = next.min - cur.min;
  return {
    tier: cur.key,
    next: next.key,
    percent: Math.min(100, Math.max(0, Math.round(((r - cur.min) / span) * 100))),
    left: Math.max(0, next.min - r),
  };
}

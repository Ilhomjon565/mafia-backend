// ==================== O'YIN TEMPI VA VAQT CHEGARASI ====================
// O'yin 20-30 daqiqada tugashi kerak. Uzoq o'yinda o'yinchilar yarim yo'lda
// chiqib ketadi, xona "zombi" bo'lib qoladi va guruhda e'lon qilingan natija
// kechqurun emas, yarim tunda chiqadi.
//
// Ikki qatlam:
//   1. TEZLASHUV — SOFT chegaradan keyin har bir faza qisqara boradi.
//      Minimumdan pastga tushmaydi: 20 soniyalik kunduz muhokamasida
//      o'ynash mumkin emas.
//   2. QAT'IY CHEGARA — HARD chegarada o'yin kunduz boshida yakunlanadi.
//      Qoida oddiy: mafiya belgilangan vaqtda shaharni bo'ysundira olmadi —
//      shahar g'olib. Bu mafiyani cho'zishdan qaytaradi.
//
// NEGA ALOHIDA MODUL: bu mantiq bir marta JIMGINA ishlamay qolgan
// (`startedAt` faqat bazaga yozilib, o'yin holatiga tushmagan edi — natijada
// hamma o'yin cheksiz cho'zilaverdi). Alohida modulda u testlar bilan
// qulflangan: chegaralar buzilsa test darhol yiqiladi.

export const GAME_SOFT_MS = 13 * 60 * 1000;   // tezlashuv boshlanishi
export const GAME_HARD_MS = 25 * 60 * 1000;   // qat'iy chegara
// Tezlashuvning eng pastki nuqtasi: faza bazaviy davomiylikning 45% i
export const MIN_SCALE = 0.45;

// Faza uchun eng kichik MA'NOLI davomiylik (soniya).
// Kunduz muhokamasi 45 soniya: bundan kamida bahs ham, ovoz ham sig'maydi.
// Qolgan (tungi) bosqichlar uchun 10 soniya: bitta nishonni bosishga yetadi.
export const PHASE_MIN = { day_discussion: 45, day_results: 5, night_results: 5 };
export const PHASE_MIN_DEFAULT = 10;

// O'yin boshlanganidan beri o'tgan vaqt (ms). `startedAt` yo'q bo'lsa 0 —
// ya'ni o'yin hali boshlanmagan va hech qanday chegara qo'llanmaydi.
export function gameElapsed(startedAt, now = Date.now()) {
  if (!startedAt) return 0;
  const t = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, now - t);
}

// 1.0 (normal) -> MIN_SCALE (HARD chegarada va undan keyin)
export function timeScale(elapsedMs) {
  if (!(elapsedMs > GAME_SOFT_MS)) return 1;
  const k = Math.min(1, (elapsedMs - GAME_SOFT_MS) / (GAME_HARD_MS - GAME_SOFT_MS));
  return 1 - (1 - MIN_SCALE) * k;
}

// Fazaning haqiqiy davomiyligi (soniya).
// `base` — sozlamalardagi qiymat, `elapsedMs` — o'yin boshlanganidan beri.
export function phaseDuration(base, phase, elapsedMs) {
  const b = Number(base) || 0;
  const sc = timeScale(elapsedMs);
  if (sc >= 1) return b;
  // 5 soniyadan qisqa fazalar (natija ekranlari) qisqartirilmaydi:
  // ular allaqachon minimal va yana kesilsa ko'z ilg'amay qoladi.
  const min = PHASE_MIN[phase] ?? (b <= 5 ? b : PHASE_MIN_DEFAULT);
  return Math.max(min, Math.round(b * sc));
}

// Vaqt tugadimi? Tekshiruv KUNDUZ boshida chaqiriladi.
export function isTimeUp(elapsedMs) {
  return elapsedMs >= GAME_HARD_MS;
}

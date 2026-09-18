// ==================== O'YIN YOZUVLARI (shikoyat uchun dalil) ====================
//
// MAQSAD: shikoyat kelganda "kim nima dedi" savoliga aniq javob bo'lsin —
// ovozli chat, matnli chat va o'yin tarixi bilan birga.
//
// DISK — ENG MUHIM CHEKLOV. Ovoz yozuvi disk yeydi, shuning uchun bu yerdagi
// har bir qaror joyni tejashga qaratilgan:
//
//   1. Ovoz FAQAT gapirilayotgan paytda yoziladi. O'yin push-to-talk, ya'ni
//      20 daqiqalik o'yinda odam ko'pi bilan 2-4 daqiqa gapiradi. Mijozdagi
//      MediaRecorder tugma bosilganda `resume`, qo'yib yuborilganda `pause`
//      qiladi — jimlik umuman yozilmaydi.
//   2. Bitrate 16 kbit/s mono Opus — nutq uchun yetarli, musiqa uchun emas.
//      Bu sekundiga 2 KB: 3 daqiqa gap = ~360 KB, 12 kishilik o'yin = ~4 MB.
//   3. Shikoyat BO'LMASA yozuv o'yin tugagach o'chiriladi (qisqa muhlat bilan —
//      o'yinchi natija ekranidan ham shikoyat qilishi mumkin).
//   4. Uch qatlamli chegara: bitta o'yinchi, bitta o'yin va UMUMIY hajm.
//      Chegaradan oshsa yangi bo'laklar QABUL QILINMAYDI (o'yin buzilmaydi).
//   5. Kunlik tozalash: muddati o'tgan yozuvlar o'chadi; umumiy hajm
//      chegaraga yaqinlashsa eng eskisidan boshlab o'chiriladi.
//
// Saqlanadigan narsalar (`<DIR>/<gameId>/`):
//   game.json          — o'yin tarixi: chat, ochiq va maxfiy jurnal, rollar
//   <publicId>.webm    — o'sha o'yinchining mikrofoni (faqat gapirgan paytlari)
//   <publicId>.json    — gap bo'laklarining vaqt belgilari (audio <-> o'yin vaqti)
//   reports.json       — shu o'yinga kelgan shikoyatlar
//
// NEGA SERVERDA ARALASHTIRILMAYDI: ovoz WebRTC mesh orqali to'g'ridan-to'g'ri
// o'yinchilar orasida oqadi, server uni umuman ko'rmaydi (buni faqat SFU qila
// olardi). Shuning uchun har mijoz O'Z mikrofonini yozib yuboradi. Moderatsiya
// uchun bu hatto qulayroq: kim gapirgani aniq, aralashib ketmaydi.

import fs from 'fs';
import path from 'path';

const DIR = process.env.RECORD_DIR || '/srv/mafia/recordings';
// Umumiy chegara. Oshsa yangi yozuv qabul qilinmaydi va eng eskilari o'chadi.
const MAX_TOTAL_MB = Math.max(5, parseInt(process.env.RECORD_MAX_MB || '1500'));
// Bitta o'yin uchun chegara (12 kishi × ~4 MB dan ancha keng zaxira bilan)
const MAX_GAME_MB = Math.max(2, parseInt(process.env.RECORD_GAME_MB || '30'));
// Bitta o'yinchi uchun chegara — mikrofoni ochiq qolgan odam butun kvotani yemasin
const MAX_USER_MB = Math.max(1, parseInt(process.env.RECORD_USER_MB || '6'));
// Shikoyat bor yozuv shuncha kun saqlanadi
const KEEP_DAYS = Math.max(1, parseInt(process.env.RECORD_KEEP_DAYS || '14'));
// Bitta bo'lak chegarasi (nginx client_max_body_size 2m)
export const MAX_CHUNK = 512 * 1024;
// Ruxsat etilgan ovoz kengaytmalari. Chrome/Firefox webm, Safari mp4 beradi.
export const ALLOWED_EXT = ['webm', 'mp4'];

const MB = 1024 * 1024;
export const LIMITS = {
  dir: DIR,
  maxTotalMb: MAX_TOTAL_MB,
  maxGameMb: MAX_GAME_MB,
  maxUserMb: MAX_USER_MB,
  keepDays: KEEP_DAYS,
};

// Yoqilgan/o'chirilgan: VOICE_RECORD=0 butunlay o'chiradi
export const ON = process.env.VOICE_RECORD !== '0';

// ---------- hisob-kitob ----------
// Umumiy hajmni HAR YOZUVDA qayta hisoblash (butun katalogni aylanib chiqish)
// qimmat, shuning uchun u xotirada yuritiladi va vaqti-vaqti bilan
// haqiqiy holat bilan solishtiriladi (drift bo'lmasin).
let totalBytes = 0;
let ready = false;

// Yo'l bo'ylab chiqib ketishning oldini oladi.
//
// DIQQAT: faqat belgilarni filtrlash YETARLI EMAS edi. Nuqta ruxsat etilgan
// belgilar ichida bo'lgani uchun `safeName('..')` '..' ni O'ZGARTIRMASDAN
// qaytarardi va `path.join(DIR, '..')` OTA-KATALOGGA olib chiqardi:
//   GET  /api/admin/evidence/../file/backend.env  -> sirlarni o'qish
//   DELETE /api/admin/evidence/..                 -> butun /srv/mafia o'chishi
// Shuning uchun '.', '..' va tarkibida '..' bo'lgan nom BUTUNLAY rad etiladi.
function safeName(v) {
  const s = String(v || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  if (!s || s === '.' || s === '..' || s.includes('..')) return '';
  return s;
}
// IKKINCHI QATLAM: nom tozalangan bo'lsa ham, natija HAR DOIM ildiz katalog
// ICHIDA ekani tekshiriladi. Bitta qatlamga ishonib bo'lmaydi — yuqoridagi
// nuqson aynan shundan kelib chiqqan.
function gameDir(gameId) {
  const id = safeName(gameId);
  if (!id) return null;
  const root = path.resolve(DIR);
  const p = path.resolve(root, id);
  if (!p.startsWith(root + path.sep)) return null;
  return p;
}
function dirSize(dir) {
  let n = 0;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    try { n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
  }
  return n;
}

export function init() {
  if (!ON) return { ok: false, reason: 'off' };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    totalBytes = dirSize(DIR);
    ready = true;
    return { ok: true, totalMb: Math.round(totalBytes / MB) };
  } catch (e) {
    console.error('recordings.init:', e?.message || e);
    ready = false;
    return { ok: false, reason: e?.message };
  }
}

// Xotiradagi hisob haqiqiy holatdan uzoqlashib ketmasin
export function resync() {
  if (!ready) return;
  try { totalBytes = dirSize(DIR); } catch {}
}

export function stats() {
  let games = 0;
  try { games = fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch {}
  return {
    yoqilgan: ON && ready,
    hajmMb: Math.round((totalBytes / MB) * 10) / 10,
    chegaraMb: MAX_TOTAL_MB,
    foizi: Math.round((totalBytes / (MAX_TOTAL_MB * MB)) * 100),
    oyinlar: games,
    kun: KEEP_DAYS,
  };
}

// ---------- o'yin yozuvi ----------

// O'yin boshlandi — katalog ochiladi.
export function open(gameId) {
  if (!ON || !ready) return false;
  const d = gameDir(gameId);
  if (!d) return false;
  // Kamida BITTA o'yinchiga yetadigan joy qolmasa — yangi yozuv boshlanmaydi.
  // Faqat "to'liq to'lganda" tekshirish yetarli emas edi: chegaraga yaqin
  // holatda katalog ochilaverib, unga hech narsa sig'masdi va diskda bo'sh
  // "dalil" kataloglari to'planardi. O'yinning o'zi baribir ishlayveradi.
  if (totalBytes + MAX_USER_MB * MB > MAX_TOTAL_MB * MB) return false;
  try { fs.mkdirSync(d, { recursive: true }); return true; } catch { return false; }
}

export function isOpen(gameId) {
  const d = gameDir(gameId);
  if (!d) return false;
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

// Ovoz bo'lagini qo'shadi. Qaytadi: { ok, code }
// MediaRecorder bo'laklari KETMA-KET ulanadi: birinchisida sarlavha bor,
// qolganlari davomi. Shuning uchun tartib muhim — mijoz ularni navbat bilan,
// bittalab yuboradi.
export function append(gameId, key, buf, ext = 'webm') {
  if (!ON || !ready) return { ok: false, code: 'off' };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, code: 'empty' };
  if (buf.length > MAX_CHUNK) return { ok: false, code: 'chunkTooBig' };
  const d = gameDir(gameId);
  const k = safeName(key);
  // Kengaytma QAT'IY oq ro'yxatda. Ilgari mijoz istalgan 1-5 belgili
  // kengaytma yubora olardi va HAR BIRI alohida fayl bo'lgani uchun
  // o'yinchi kvotasi (MAX_USER_MB) qayta-qayta nolga qaytardi: bitta odam
  // 6 MB o'rniga butun o'yin budjetini (30 MB) yeb, QOLGANLARNING ovozli
  // dalilini yo'q qilardi.
  const e = ALLOWED_EXT.includes(String(ext)) ? String(ext) : 'webm';
  if (!d || !k) return { ok: false, code: 'badId' };
  if (!isOpen(gameId)) return { ok: false, code: 'notOpen' };

  // Uch qatlamli chegara — biri ham buzilmasin
  if (totalBytes + buf.length > MAX_TOTAL_MB * MB) return { ok: false, code: 'diskFull' };
  const gSize = dirSize(d);
  if (gSize + buf.length > MAX_GAME_MB * MB) return { ok: false, code: 'gameFull' };

  const file = path.join(d, k + '.' + e);
  // Kvota FAYL emas, O'YINCHI (kalit) bo'yicha hisoblanadi: bir kalitning
  // barcha fayllari qo'shiladi. Aks holda kengaytmani almashtirib chegarani
  // aylanib o'tish mumkin edi.
  let uSize = 0;
  try {
    for (const f of fs.readdirSync(d)) {
      if (f === k || f.startsWith(k + '.')) {
        try { uSize += fs.statSync(path.join(d, f)).size; } catch {}
      }
    }
  } catch {}
  if (uSize + buf.length > MAX_USER_MB * MB) return { ok: false, code: 'userFull' };

  try {
    fs.appendFileSync(file, buf);
    totalBytes += buf.length;
    return { ok: true, bytes: uSize + buf.length };
  } catch (err) {
    console.error('recordings.append:', err?.message || err);
    return { ok: false, code: 'io' };
  }
}

// Kichik JSON yozuvlar (o'yin tarixi, vaqt belgilari, shikoyatlar)
export function saveJson(gameId, name, obj) {
  if (!ON || !ready) return false;
  const d = gameDir(gameId);
  const n = safeName(name);
  if (!d || !n) return false;
  try {
    fs.mkdirSync(d, { recursive: true });
    const body = Buffer.from(JSON.stringify(obj, null, 1), 'utf8');
    // JSON hajmi ham hisobga olinadi (kichik, lekin hisob to'g'ri bo'lsin)
    const file = path.join(d, n.endsWith('.json') ? n : n + '.json');
    let old = 0;
    try { old = fs.statSync(file).size; } catch {}
    fs.writeFileSync(file, body);
    totalBytes += body.length - old;
    return true;
  } catch (e) {
    console.error('recordings.saveJson:', e?.message || e);
    return false;
  }
}

export function readJson(gameId, name) {
  const d = gameDir(gameId);
  const n = safeName(name);
  if (!d || !n) return null;
  try {
    const file = path.join(d, n.endsWith('.json') ? n : n + '.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// Yozuvni butunlay o'chiradi
export function drop(gameId) {
  const d = gameDir(gameId);
  if (!d) return false;
  let size = 0;
  try { size = dirSize(d); } catch {}
  try {
    fs.rmSync(d, { recursive: true, force: true });
    totalBytes = Math.max(0, totalBytes - size);
    return true;
  } catch (e) {
    console.error('recordings.drop:', e?.message || e);
    return false;
  }
}

// O'yin katalogidagi fayllar ro'yxati (admin uchun)
export function files(gameId) {
  const d = gameDir(gameId);
  if (!d) return [];
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(path.join(d, f.name)).size; } catch {}
        return { name: f.name, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// Bitta faylga XAVFSIZ yo'l (katalogdan chiqib ketib bo'lmaydi)
export function filePath(gameId, name) {
  const d = gameDir(gameId);
  const n = safeName(name);
  if (!d || !n) return null;
  const p = path.join(d, n);
  // Ikki qatlamli himoya: nom tozalangan VA natija katalog ichida
  if (!p.startsWith(d + path.sep)) return null;
  try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
  return p;
}

// Saqlangan o'yinlar ro'yxati (eng yangisi birinchi)
export function list(limit = 200) {
  try {
    return fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(DIR, d.name);
        let at = 0;
        try { at = fs.statSync(full).mtimeMs; } catch {}
        return { gameId: d.name, at, size: dirSize(full) };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  } catch { return []; }
}

// ---------- tozalash ----------
// Ikki sabab bilan o'chiramiz: (1) muddati o'tgan, (2) umumiy hajm chegaraga
// yaqinlashgan — bunda eng ESKISIDAN boshlab o'chiriladi.
//
// `keepIds` — hozir ketayotgan (hali tugamagan) o'yinlar: ular tegilmaydi.
export function sweep(keepIds = new Set()) {
  if (!ON || !ready) return { ochirildi: 0, sabab: 'off' };
  let removed = 0;
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const rows = list(10000);

  for (const r of rows) {
    if (keepIds.has(r.gameId)) continue;
    if (r.at && r.at < cutoff) { if (drop(r.gameId)) removed++; }
  }

  // Hajm bo'yicha: 90% dan oshsa 75% ga tushguncha eskilarini o'chiramiz
  const high = MAX_TOTAL_MB * MB * 0.9;
  const low = MAX_TOTAL_MB * MB * 0.75;
  if (totalBytes > high) {
    const left = list(10000).filter((r) => !keepIds.has(r.gameId)).sort((a, b) => a.at - b.at);
    for (const r of left) {
      if (totalBytes <= low) break;
      if (drop(r.gameId)) removed++;
    }
  }
  return { ochirildi: removed, hajmMb: Math.round((totalBytes / MB) * 10) / 10 };
}

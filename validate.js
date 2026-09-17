// ==================== MATN TEKSHIRUVI VA TOZALASH ====================
// Bu modul IKKI vazifani bajaradi:
//   1. Taxallus (nikname) qoidalari — uzunlik va ruxsat etilgan belgilar.
//   2. Barcha kelgan matndan burchakli qavslarni (`<`, `>`) olib tashlash.
//
// NEGA `<` va `>` BUTUNLAY TAQIQLANADI
// React matnni o'zi qalqonlaydi, ya'ni `<script>` chatga yozilsa u KOD
// sifatida ishlamaydi — oddiy matn bo'lib ko'rinadi. Demak hujum allaqachon
// ishlamaydi. Lekin himoya bir qatlamga tayanmasligi kerak: ertaga kimdir
// biror joyda `dangerouslySetInnerHTML` ishlatsa yoki matn PDF/HTML
// hisobotga tushsa, o'sha bitta joy teshik bo'lib qolardi. Shuning uchun
// qavslar SERVERGA KIRISHDA olib tashlanadi — bironta yo'l qolmasin.
//
// "AYLANMA YO'LLAR" YOPILGAN:
//   - to'liq kenglikdagi belgilar (`＜`, `＞`) — NFKC normalizatsiyasi
//     ularni oddiy `<`, `>` ga aylantiradi va keyin ular olib tashlanadi;
//   - HTML mohiyatlari (`&lt;`, `&#60;`, `&#x3C;`, `&GT;` ...) — ular ham
//     qirqiladi, aks holda keyinchalik dekodlangan joyda qayta qavs
//     bo'lib chiqardi;
//   - ko'rinmas belgilar (zero-width, BOM) — ular bilan `<scr[ZWSP]ipt>`
//     kabi hiylalar qilinadi, shuning uchun tashlab yuboriladi.
//
// `〈`, `⟨`, `‹` kabi tipografik qavslar ATAYLAB qoldiriladi: ular HTML da
// hech qanday ma'noga ega emas (teg yasay olmaydi) va matematik matnda
// kerak bo'lishi mumkin.

export const NICK_MIN = 3;
export const NICK_MAX = 16;

// Ko'rinmas belgilar: zero-width space/joiner, BOM, soft hyphen, RTL/LTR
// belgilari. Ular matnni ko'zga bir xil ko'rsatib, ichida boshqa narsa
// yashirishga imkon beradi.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

// Qavslarning HTML mohiyat shakllari (o'lchamga befarq).
const ENTITY = /&(?:lt|gt|#0*(?:60|62)|#x0*3[cCeE]);?/gi;

// Matnni XAVFSIZ ko'rinishga keltiradi. Tartib MUHIM:
//   1) NFKC — to'liq kenglikdagi va boshqa muqobil shakllar oddiyga tushadi;
//   2) ko'rinmas belgilar olib tashlanadi;
//   3) mohiyat shakllari qirqiladi;
//   4) qavslarning o'zi qirqiladi;
//   5) ketma-ket bo'shliqlar bittaga tushadi va chetlari kesiladi.
export function cleanText(input, { maxLen = 0 } = {}) {
  let s = String(input ?? '');
  try { s = s.normalize('NFKC'); } catch {}
  s = s.replace(INVISIBLE, '');
  s = s.replace(ENTITY, '');
  s = s.replace(/[<>]/g, '');
  s = s.replace(/[\t\f\v]+/g, ' ');
  s = s.replace(/ {2,}/g, ' ').trim();
  if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

// Matnda qavs (yoki uning yashirin shakli) bormi? Faqat tekshirish uchun —
// log va statistika uchun kerak bo'ladi.
export function hasAngle(input) {
  const s = String(input ?? '');
  let n = s;
  try { n = n.normalize('NFKC'); } catch {}
  n = n.replace(INVISIBLE, '');
  return /[<>]/.test(n) || ENTITY.test(n);
}

// Obyekt/massiv ichidagi HAMMA satrni tozalaydi (joyida, rekursiv).
// Chuqurlik cheklangan: hujumchi 10 000 qatlamli JSON yuborib stekni
// to'ldirib qo'ymasligi kerak.
// ==================== CHAT TARKIBI ====================
// Ochiq chatda eng ko'p uchraydigan suiiste'mol — reklama, tashqi havola,
// telegram kanaliga chaqiriq va telefon raqami. Ilgari xabar matniga HECH
// QANDAY tarkib tekshiruvi yo'q edi (faqat uzunlik va HTML tozalash), ya'ni
// xona begona reklama maydoni bo'lib qolardi va o'yinchida shikoyat qilish
// yo'li ham yo'q edi.
//
// Sof funksiya — testlari validate.test.mjs da.
// `recent` — shu o'yinchining oxirgi xabarlari (takror/spam uchun).
//
// DIQQAT: o'yinda raqam KO'P ishlatiladi ("3 ga beraman", "5-raqam shubhali"),
// shuning uchun telefon qoidasi kamida 7 ta ketma-ket raqamni talab qiladi.
const LINKY = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|wa\.me\/|\b[a-z0-9-]{2,}\.(uz|com|ru|net|org|me|io|co|info|site|online|xyz)\b)/i;
// 9 ta raqam — O'zbekiston raqamining uzunligi (901234567). 7 chegarasi
// haqiqiy raqamni to'sish uchun kerak emas edi, lekin o'yindagi oddiy uzun
// sonni (sana, hisob, xona raqami) to'sib qo'yardi.
const PHONE = /(?:\+?\d[\s\-().]*){9,}/;

export function checkChat(text, recent = []) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, code: 'empty' };
  if (LINKY.test(t)) return { ok: false, code: 'link' };
  if (PHONE.test(t.replace(/[^\d+\s\-().]/g, ''))) return { ok: false, code: 'phone' };
  // Bir xil xabarni qayta-qayta yozish — eng oddiy spam shakli
  const norm = t.toLowerCase().replace(/\s+/g, ' ');
  if (recent.some((r) => String(r).toLowerCase().replace(/\s+/g, ' ') === norm)) {
    return { ok: false, code: 'repeat' };
  }
  // Bitta belgini cho'zish ("aaaaaaaaaaa") — ekranni to'ldirish usuli
  if (/(.)\1{9,}/.test(t)) return { ok: false, code: 'flood' };
  return { ok: true, value: t };
}

export function cleanDeep(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return cleanText(value, { maxLen: 4000 });
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 500; i++) value[i] = cleanDeep(value[i], depth + 1);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = cleanDeep(value[k], depth + 1);
    return value;
  }
  return value;
}

// ---------- TAXALLUS ----------
//
// Qoidalar (sabablari bilan):
//   3-16 belgi      — 1-2 belgili taxallus o'yin doirasida tanib bo'lmaydi,
//                     16 dan uzuni esa o'yinchi kartasiga sig'maydi va
//                     ro'yxatlarni buzadi;
//   boshi va oxiri  — harf yoki raqam: ".", "_", "-" bilan boshlangan nom
//                     ro'yxatlarda ko'rinmas bo'lib ketadi;
//   ketma-ket ajratgich yo'q — "a__b" va "a_b" ni ko'z bilan ajratib
//                     bo'lmaydi, ya'ni boshqa o'yinchini nusxalash yo'li;
//   BITTA yozuv tizimi — lotin YOKI kirill, aralash emas. "Аdmin" da
//                     birinchi harf kirill bo'lsa, u lotin "Admin" dan
//                     farq qilmaydi ko'zga: bu klassik nusxalash hiylasi;
//   faqat raqam emas — "12345" foydalanuvchi ID siga o'xshaydi;
//   band nomlar yo'q — "admin", "mafia", "bot" kabi nomlar rasmiy
//                     ko'rinadi va ishonchni suiiste'mol qilish uchun
//                     ishlatiladi.
//
// O'zbek apostroflari (', ʻ, ‘, ’) HARF deb qabul qilinadi — "G'ayrat",
// "To'lqin" kabi ismlar yozilishi kerak.
const APOSTROPHE = "['ʻʼ‘’`´]";
const SEP = '[_.\\-]';
const RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'moder', 'mod', 'root', 'system',
  'mafia', 'mafiya', 'mafiagame', 'mafiagameuz', 'support', 'help',
  'bot', 'server', 'official', 'owner', 'staff', 'null', 'undefined',
  'me', 'you', 'anonim', 'anonymous', 'guest', 'mehmon',
]);

const reEdge = /^[\p{L}\p{N}]/u;
const reEdgeEnd = /[\p{L}\p{N}]$/u;
const reSepTwice = new RegExp(SEP + '{2,}');
const reApos = new RegExp(APOSTROPHE, 'g');
const reSepAll = new RegExp(SEP, 'g');
const reLatin = /^[A-Za-z0-9]+$/;
const reCyr = /^[Ѐ-ӿ0-9]+$/;
const reDigitsOnly = new RegExp('^[0-9' + SEP.slice(1, -1) + ']+$');

// `{ ok, value }` yoki `{ ok: false, code }` qaytaradi.
// `code` — mijoz o'z tilida xabar ko'rsatishi uchun (matn serverda
// yozilmaydi: uch tilli xabar frontendda turadi).
export function validateNick(input) {
  const s = cleanText(input, { maxLen: 64 });
  if (!s) return { ok: false, code: 'empty' };
  if (s.length < NICK_MIN) return { ok: false, code: 'short' };
  if (s.length > NICK_MAX) return { ok: false, code: 'long' };
  if (!reEdge.test(s) || !reEdgeEnd.test(s)) return { ok: false, code: 'edge' };
  if (reSepTwice.test(s)) return { ok: false, code: 'sep' };

  // Yozuv tizimini tekshirish uchun ajratgich va apostroflarni olib tashlaymiz
  const body = s.replace(reApos, '').replace(reSepAll, '');
  if (!body) return { ok: false, code: 'chars' };
  const latin = reLatin.test(body);
  const cyr = reCyr.test(body);
  if (!latin && !cyr) return { ok: false, code: 'chars' };
  if (reDigitsOnly.test(s.replace(reApos, ''))) return { ok: false, code: 'digits' };
  if (RESERVED.has(s.toLowerCase().replace(reApos, '').replace(reSepAll, ''))) {
    return { ok: false, code: 'reserved' };
  }
  return { ok: true, value: s };
}

// Xona nomi: taxallusdan yumshoqroq (bo'shliq, tinish belgilari va emoji
// mumkin), lekin qavslar bo'lmaydi va uzunligi cheklangan.
export const ROOM_NAME_MIN = 2;
export const ROOM_NAME_MAX = 40;
export function validateRoomName(input) {
  const s = cleanText(input, { maxLen: ROOM_NAME_MAX });
  if (!s) return { ok: false, code: 'empty' };
  if (s.length < ROOM_NAME_MIN) return { ok: false, code: 'short' };
  // Kamida bitta harf yoki raqam bo'lsin: "!!!" yoki "..." nom emas
  if (!/[\p{L}\p{N}]/u.test(s)) return { ok: false, code: 'chars' };
  return { ok: true, value: s };
}

// ==================== ONLAYN KO'RSATKICHI ====================
// Yangi platformaning eng katta muammosi — "bo'sh restoran": o'yinchi kirib,
// "0 kishi onlayn" ni ko'radi va qaytib ketadi. Shuning uchun ko'rsatkichga
// bazaviy egri chiziq qo'shiladi.
//
// NEGA SOAT BO'YICHA, doimiy raqam emas: haqiqiy saytda tunda 03:00 da ham
// 220 kishi turmaydi. Doimiy raqam birinchi kuzatuvchi odamni shubhalantiradi,
// soatga qarab o'zgaruvchi raqam esa tabiiy ko'rinadi.
//
// QIYMAT VAQTDAN HISOBLANADI (Math.random() yo'q). Bu muhim:
//  - uchta frontend instansiyasi ham bir xil son ko'rsatadi;
//  - 10 soniyalik kesh bilan ziddiyat bo'lmaydi;
//  - sahifa yangilanganda raqam sakramaydi.

// Har soat uchun taxminiy onlayn (indeks = Toshkent vaqti bo'yicha soat)
export const ONLINE_CURVE = [
  148, 116, 92, 78, 74, 82,       // 00-05  tun: eng kam 04:00 da
  98, 124, 146, 158, 164, 170,    // 06-11  ertalab o'sish
  176, 172, 166, 172, 186, 202,   // 12-17  kunduz
  218, 231, 234, 226, 204, 176,   // 18-23  kechqurun: eng gavjum 20:00
];

// Toshkent = UTC+5, yoz/qish o'zgarishi yo'q.
const TASHKENT_OFFSET_MS = 5 * 3600 * 1000;

// `enabled` false bo'lsa 0 qaytaradi — ya'ni faqat haqiqiy onlayn ko'rinadi.
export function fakeOnlineBase(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  const t = new Date(now + TASHKENT_OFFSET_MS);
  const h = t.getUTCHours(), m = t.getUTCMinutes();
  const a = ONLINE_CURVE[h], b = ONLINE_CURVE[(h + 1) % 24];
  const base = a + (b - a) * (m / 60);   // soatlar orasida silliq o'tish

  // Sekin tebranish: uch xil davrli sinus qo'shiladi, natija uzluksiz —
  // raqam "tirik" ko'rinadi, lekin sakramaydi. Amplituda ~±10.
  const min = Math.floor(now / 60000);
  const wave = Math.sin(min / 7.3) * 4.5 + Math.sin(min / 2.9) * 2.5 + Math.sin(min / 17) * 3;

  return Math.max(35, Math.round(base + wave));
}

// Ro'yxatdan o'tganlar soni ham onlayn bilan mos bo'lishi kerak: 220 kishi
// onlayn bo'lsa, umumiy 300 ta hisob g'alati ko'rinadi. Koeffitsiyent ~23
// (odatiy o'yin saytlarida onlayn/jami nisbati 3-6%).
export function fakePlayersBase(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  // Kun bo'yi o'zgarmasin: sana bo'yicha sekin o'sadigan son.
  const days = Math.floor((now + TASHKENT_OFFSET_MS) / 86400000);
  return 4200 + days * 17 % 900;
}

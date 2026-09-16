// ==================== SAYT FAOLLIGI KO'RSATKICHLARI ====================
// Yangi platformaning eng katta muammosi — "bo'sh restoran": o'yinchi kirib,
// "0 kishi onlayn, 0 xona" ni ko'radi va qaytib ketadi. Shu sababli
// ko'rsatkichlarga bazaviy qiymat qo'shiladi.
//
// IKKI QAT'IY QOIDA:
//  1. HAQIQIY faollik har doim USTIGA qo'shiladi. Yangi hisob ro'yxatdan
//     o'tsa — umumiy son bittaga ko'payadi; odam saytga kirsa — onlayn
//     bittaga ko'payadi. Soxta qism buni yashirmaydi.
//  2. Son HECH QACHON kamaymaydi. Ilgari kunlik o'sish `% 900` bilan
//     hisoblanardi va son bir kun 4400, ertasiga 4100 bo'lib TUSHIB ketardi —
//     buni sezgan odam darhol soxta ekanini tushunadi.
//
// Qiymatlar VAQTdan hisoblanadi (Math.random() yo'q): uchta frontend
// instansiyasi ham, 10 soniyalik kesh ham bir xil son ko'rsatadi va raqam
// sahifa yangilanganda sakramaydi.

// Toshkent = UTC+5, yoz/qish o'zgarishi yo'q.
const TZ_MS = 5 * 3600 * 1000;
// Sayt bitta serverga ko'chgan kun — o'sish shu sanadan hisoblanadi.
const EPOCH = Date.UTC(2026, 8, 15);

const daysSince = (now) => Math.max(0, Math.floor((now + TZ_MS - EPOCH) / 86400000));

// ---------- onlayn ----------

// Har soat uchun taxminiy onlayn (indeks = Toshkent vaqti bo'yicha soat).
// Diapazon 50-150: tunda eng kam, kechqurun 20:00 da eng gavjum.
export const ONLINE_CURVE = [
  96, 78, 62, 54, 50, 55,        // 00-05  tun
  64, 78, 88, 95, 99, 103,       // 06-11  ertalab
  107, 105, 101, 105, 114, 124,  // 12-17  kunduz
  136, 147, 150, 143, 128, 110,  // 18-23  kechqurun
];

export function fakeOnlineBase(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  const t = new Date(now + TZ_MS);
  const h = t.getUTCHours(), m = t.getUTCMinutes();
  const a = ONLINE_CURVE[h], b = ONLINE_CURVE[(h + 1) % 24];
  const base = a + (b - a) * (m / 60);   // soatlar orasida silliq o'tish

  // Sekin tebranish: uch xil davrli sinus, natija uzluksiz — raqam "tirik"
  // ko'rinadi, lekin sakramaydi. Amplituda ~±6 (diapazon kichik bo'lgani uchun).
  const min = Math.floor(now / 60000);
  const wave = Math.sin(min / 7.3) * 2.8 + Math.sin(min / 2.9) * 1.6 + Math.sin(min / 17) * 1.8;

  return Math.max(28, Math.round(base + wave));
}

// ---------- ro'yxatdan o'tganlar ----------

// 1300 dan boshlanadi va kundan kunga sekin o'sadi. Kamaymaydi.
export function fakePlayersBase(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  return 1300 + daysSince(now) * 4;
}

// ---------- o'ynalgan o'yinlar ----------

// 30 dan boshlanadi. Kun bo'yi ham sekin o'sadi (o'yinlar tugab turadi),
// lekin hech qachon kamaymaydi: kun ichidagi o'sish soatga bog'langan.
export function fakeGamesPlayed(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  const d = daysSince(now);
  const hour = new Date(now + TZ_MS).getUTCHours();
  return 30 + d * 11 + Math.floor(hour / 2);
}

// ---------- lobbidagi xonalar ----------

// Xona nomlari — haqiqiy o'yinchilar yozadigan uslubda.
const ROOM_NAMES = [
  'Tungi shahar', 'Tez o\'yin', 'Faqat tajribalilar', 'Kim mafiya?',
  'Do\'stlar davrasi', 'Mafiya 12', 'Kechki o\'yin', 'Toshkent',
  'Yangi boshlovchilar', 'Klassik', 'Ovozli chat bor', 'Qizg\'in jang',
  'Sokin xona', 'Tezkor', 'Katta o\'yin', 'Mafia UZ', 'Kim kim?',
  'Shahar uxlaydi', 'Tunda ov', 'Oltin xona',
];
const PLAYER_NAMES = [
  'Sardor', 'Aziza', 'Bekzod', 'Malika', 'Jasur', 'Nilufar', 'Otabek',
  'Zuhra', 'Kamola', 'Temur', 'Doston', 'Elyor', 'Javohir', 'Mirzo',
  'aziz_99', 'bobur7', 'jasurbek', 'temurxon', 'malika_x', 'nodirbek',
  'Sanjar', 'Ulugbek', 'Xurshid', 'Feruza', 'Sevara', 'sherzod',
];

// Deterministik hash — bir xil kirish har doim bir xil natija beradi.
function h32(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0);
}

// Lobbi uchun soxta xonalar.
//
// HAMMASI TO'LGAN yoki JANGDA — ya'ni ularga qo'shilib bo'lmaydi. Bu ataylab:
// soxta xonaning ID si haqiqiy emas, unga kirmoqchi bo'lgan odam "Xona
// topilmadi" xatosini ko'rardi. Frontend to'lgan/jangda xonaning tugmasini
// o'zi bloklaydi, shuning uchun bunday holat yuzaga kelmaydi.
//
// To'plam har 7 daqiqada yangilanadi: xonalar "tugaydi", o'rniga boshqasi
// "ochiladi" — lobbi jonli ko'rinadi.
// Ishlatilmagan nom tanlaydi (ro'yxat tugasa oxirgisini qaytaradi).
function pickName(used, seed) {
  for (let k = 0; k < ROOM_NAMES.length; k++) {
    const nm = ROOM_NAMES[(seed + k) % ROOM_NAMES.length];
    if (!used.has(nm)) { used.add(nm); return nm; }
  }
  return ROOM_NAMES[seed % ROOM_NAMES.length];
}

export function fakeRooms(now = Date.now(), enabled = true) {
  if (!enabled) return [];
  const slot = Math.floor(now / (7 * 60000));
  const count = 5 + (h32(slot) % 6);            // 5-10 ta
  const out = [];
  // Nomlar takrorlanmasin: lobbida ikkita "Mafia UZ" turgani g'alati ko'rinadi
  const usedNames = new Set();
  for (let i = 0; i < count; i++) {
    // DIQQAT: `>>>` (unsigned), `>>` EMAS. h32() 32-bitli musbat son qaytaradi,
    // lekin `>>` uni ishorali deb hisoblaydi va 2^31 dan katta qiymatlarda
    // MANFIY natija beradi. JS'da manfiy son bilan `%` ham manfiy chiqadi,
    // natijada `ROOM_NAMES[-5]` = undefined bo'lib, xonalar nomsiz qolardi.
    const s = h32(slot * 977 + i * 31);
    const total = [8, 9, 10, 10, 12, 12, 14, 16][s % 8];
    // 70% jangda, 30% to'lgan va boshlanishini kutmoqda
    const playing = ((s >>> 3) % 10) < 7;
    const mafiaCount = Math.max(1, Math.round(total * 0.3));
    const players = [];
    const shift = s % PLAYER_NAMES.length;
    for (let k = 0; k < total; k++) {
      players.push({
        userId: 'c' + (h32(slot * 7919 + i * 101 + k) >>> 0).toString(16).padStart(8, '0') + i + k,
        username: PLAYER_NAMES[(shift + k * 7) % PLAYER_NAMES.length],
        isAlive: true,
      });
    }
    out.push({
      id: 'c' + (h32(slot * 104729 + i) >>> 0).toString(16).padStart(8, '0') + 'x' + i,
      name: pickName(usedNames, (s >>> 7)),
      status: playing ? 'playing' : 'waiting',
      totalPlayers: total,
      mafiaCount,
      sheriffCount: 1,
      doctorCount: 1,
      civilCount: Math.max(0, total - mafiaCount - 2),
      hostId: 'fake',
      createdAt: new Date(now - ((s % 25) + 2) * 60000).toISOString(),
      phase: playing ? 'day_discussion' : 'waiting',
      players,               // to'liq — ya'ni xona TO'LGAN
    });
  }
  return out;
}

// ---------- botlarning o'zaro o'yinlari ----------

// Sayt faol ko'rinishi uchun kuniga 10-15 marta FAQAT BOTLAR o'ynaydigan
// o'yin o'tkaziladi. Bu soxta xonadan ko'ra ishonchliroq: o'yin haqiqatan
// o'ynaladi, lobbida jonli "jangda" xonasi turadi, natija bazaga tushadi va
// "o'ynalgan o'yinlar" hisobi o'sadi.
//
// Jadval SANAdan hisoblanadi (tasodifiy emas): server qayta ishga tushsa ham
// o'sha kunning jadvali o'zgarmaydi va o'yin ikki marta boshlanmaydi.
// Vaqtlar 10:30-23:45 oralig'ida — odamlar saytda bo'lgan paytda.
export function botGameSchedule(now = Date.now()) {
  const day = Math.floor((now + TZ_MS) / 86400000);
  const n = 10 + (hashDay(day) % 6);             // kuniga 10-15 ta
  const START = 10.5, END = 23.75;
  const step = (END - START) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Slot ichida tasodifiy nuqta — o'yinlar aniq bir xil vaqtda boshlanmasin.
    // Jitter step'ning yarmidan oshmaydi: aks holda ketma-ket ikki o'yin
    // bir vaqtga to'g'ri kelib qolardi.
    const jitter = (hashDay(day * 131 + i * 17) % 1000) / 1000 * step * 0.5;
    out.push(+(START + i * step + jitter).toFixed(3));
  }
  return out;
}

function hashDay(n) {
  let x = (n | 0) ^ 0x6d2b79f5;
  x = Math.imul(x ^ (x >>> 15), 1 | x);
  x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
  return ((x ^ (x >>> 14)) >>> 0);
}

// Hozir boshlanishi kerak bo'lgan slot indeksini qaytaradi (yoki -1).
// `startedSlots` — bugun allaqachon boshlangan slotlar (Redis'dan).
//
// 40 daqiqalik "oyna": server o'chib qolgan bo'lsa ham o'yin o'tkazib
// yuborilmaydi, lekin kechqurun boshlangan o'yin ertalab qayta boshlanmaydi.
export function dueBotGameSlot(now = Date.now(), startedSlots = []) {
  const t = new Date(now + TZ_MS);
  const hourNow = t.getUTCHours() + t.getUTCMinutes() / 60;
  const slots = botGameSchedule(now);
  for (let i = 0; i < slots.length; i++) {
    if (startedSlots.includes(i)) continue;
    const diff = hourNow - slots[i];
    if (diff >= 0 && diff <= 0.667) return i;    // 0-40 daqiqa ichida
  }
  return -1;
}

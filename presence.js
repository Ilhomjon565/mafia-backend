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
// Kechqurun 20:00 da eng gavjum (~150), 01:00-06:00 da esa 5-10 kishi.
// Nega tunda shunchalik kam: "yarim kechada 60 kishi onlayn" degan raqamni
// o'zbek auditoriyasi darhol soxta deb biladi — o'yinchilar kechqurun
// yig'iladi, tunda esa faqat bir-ikki uyqusiz qoladi.
export const ONLINE_CURVE = [
  28, 9, 7, 6, 6, 8,             // 00-05  tun (01-05 → 5-10)
  10, 24, 40, 56, 72, 84,        // 06-11  ertalab
  92, 88, 84, 92, 104, 118,      // 12-17  kunduz
  132, 145, 150, 140, 104, 58,   // 18-23  kechqurun
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

  // Tebranish BAZAGA nisbatan kichrayadi: tunda baza 6 bo'lganda ±6 tebranish
  // sonni 0 ga (yoki manfiyga) tushirib, "onlayn 0" ko'rsatib qo'yardi.
  const amp = Math.min(1, base / 40);

  return Math.max(3, Math.round(base + wave * amp));
}

// ---------- ro'yxatdan o'tganlar ----------

// 1300 dan boshlanadi va kundan kunga sekin o'sadi. Kamaymaydi.
export function fakePlayersBase(now = Date.now(), enabled = true) {
  if (!enabled) return 0;
  return 1300 + daysSince(now) * 4;
}

// ---------- o'ynalgan o'yinlar ----------

// SON HAQIQIY: har tugagan o'yin (botlar o'zaro o'ynagani ham) bazada yozuv
// qoldiradi va /api/stats shu yozuvlarni sanaydi. Ya'ni raqam kundan kunga
// o'sadi, lekin o'sish SUN'IY emas — o'ynalgan o'yinlardan kelib chiqadi.
//
// Bu yerda faqat QOTIB QOLGAN bazaviy qiymat qoladi: sayt hozirgi serverga
// ko'chishidan oldingi o'yinlar bazada yo'q. Ilgari bu qiymat kuniga +11
// o'sib turardi — o'sishning katta qismi sun'iy edi. Qiymat o'sishning
// OXIRGI nuqtasidan olindi: aks holda ko'rsatkich bir kunda tushib ketardi
// ("son hech qachon kamaymaydi" qoidasi).
const GAMES_BASE = 63;
export function fakeGamesPlayed(now = Date.now(), enabled = true) {
  return enabled ? GAMES_BASE : 0;
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

// ==================== XONA NOMI GENERATORI ====================
// Bot o'yinlari uchun. Ilgari nom doim `${host} xonasi` edi va lobbi
// ro'yxati bir xil qolipdan yasalganday ko'rinardi — odam yozgan nom
// bunday bir xil bo'lmaydi.
//
// Shuning uchun bir nechta QOLIP aralashtiriladi: taxallus + qo'shimcha,
// shahar nomi, mavzu, raqam. Emoji ishlatilmaydi va nom 🤖 bilan
// boshlanmaydi — server bot rejimini (vsBots) aynan shu belgidan taniydi.
const ROOM_TOPICS = [
  'Tungi shahar', 'Kim mafiya?', 'Kechki o\'yin', 'Klassik', 'Tezkor o\'yin',
  'Sokin xona', 'Qizg\'in jang', 'Shahar uxlaydi', 'Tunda ov', 'Oltin xona',
  'Do\'stlar davrasi', 'Faqat tajribalilar', 'Yangi boshlovchilar',
  'Ovozli chat bor', 'Katta o\'yin', 'Kim kim?', 'Tun bo\'yi',
  'Oqshom o\'yini', 'Mafiya kechasi', 'Sirli xona', 'Ochiq jang',
  'Shubhali xona', 'Yarim tunda', 'Toshbo\'ron', 'Jimjit tun',
];
const ROOM_CITIES = [
  'Toshkent', 'Samarqand', 'Buxoro', 'Andijon', 'Farg\'ona', 'Namangan',
  'Xiva', 'Nukus', 'Qo\'qon', 'Jizzax', 'Navoiy', 'Termiz', 'Guliston',
  'Urganch', 'Qarshi', 'Chirchiq', 'Marg\'ilon', 'Shahrisabz',
];
const ROOM_SUFFIX = ['xonasi', 'davrasi', 'o\'yini', 'jangi', 'kechasi', 'stoli'];

// Ochiq xonada har qancha vaqtda bitta kirish/chiqish hodisasi bo'ladi.
// 22 soniya: lobbi ro'yxati 6 soniyada yangilanadi, ya'ni o'yinchi bir
// xonani kuzatib turganda har 3-4 yangilanishda yangi hodisa ko'radi —
// jonli, lekin bezovta qiladigan darajada tez emas.
const EVENT_MS = 22000;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// `host` — xona ochgan (bot) taxallusi, `used` — hozir ochiq xonalar nomlari.
// Takrorlanmaslikka 12 marta urinib ko'radi, keyin nom oxiriga raqam qo'shadi.
export function randomRoomName(host = '', used = []) {
  const taken = new Set(used.map((n) => String(n || '').trim().toLowerCase()));
  const h = String(host || '').trim();
  const make = () => {
    const r = Math.random();
    if (h && r < 0.34) return `${h} ${pick(ROOM_SUFFIX)}`;
    if (r < 0.62) return pick(ROOM_TOPICS);
    if (r < 0.78) return `${pick(ROOM_CITIES)} ${pick(['mafiyasi', 'kechasi', 'xonasi'])}`;
    if (r < 0.9) return `${pick(ROOM_TOPICS)} ${2 + Math.floor(Math.random() * 20)}`;
    return h ? `${h} bilan o\'ynaymiz` : pick(ROOM_TOPICS);
  };
  for (let i = 0; i < 12; i++) {
    const nm = make().slice(0, 40).trim();
    if (nm && !taken.has(nm.toLowerCase())) return nm;
  }
  return `${pick(ROOM_TOPICS)} ${1 + Math.floor(Math.random() * 99)}`.slice(0, 40);
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
    // Xonalarning 45% i OCHIQ: 2-4 joy bo'sh, ya'ni odam kirib o'ynay oladi.
    // Ilgari hammasi to'la yoki jangda edi va lobbiga qaragan odam "hech
    // qayerga kira olmayman" degan xulosaga kelardi. Bunday xonaga bosilganda
    // server HAQIQIY bot xonasi yaratib beradi (/api/games/:id/open).
    const open = ((s >>> 3) % 100) < 45;
    // Qolganlarining 70% i jangda, 30% i to'lib boshlanishini kutmoqda
    const playing = !open && ((s >>> 11) % 10) < 7;
    const free = open ? 2 + ((s >>> 17) % 3) : 0;
    let filled = Math.max(3, total - free);

    // ===== JONLI HARAKAT (faqat ochiq xonalarda) =====
    // Ochiq xona muzlab turmasligi kerak: odamlar kirib-chiqib turadi.
    // Har ~22 soniyada bitta hodisa bo'ladi (kirdi yoki chiqdi) va
    // o'yinchi soni shunga qarab bir-ikkiga o'zgaradi.
    //
    // Hammasi VAQTdan hisoblanadi (Math.random() yo'q): uchta frontend
    // instansiyasi ham, 2 soniyalik kesh ham AYNI natijani beradi —
    // aks holda ro'yxat har yangilanishda sakrab turardi.
    const events = [];
    if (open) {
      const tick = Math.floor(now / EVENT_MS);
      let delta = 0;
      // Oxirgi uch hodisa: birinchisi eng yangi
      for (let k = 0; k < 3; k++) {
        const e = h32(slot * 7919 + i * 131 + (tick - k) * 17);
        const join = (e % 100) < 58;          // 58% kirdi, 42% chiqdi
        const name = PLAYER_NAMES[(e >>> 6) % PLAYER_NAMES.length];
        // Hodisa qancha vaqt oldin bo'lgani (sekund)
        const ago = Math.floor((now - (tick - k) * EVENT_MS) / 1000);
        events.push({ n: name, t: join ? 'join' : 'leave', s: Math.max(1, ago) });
        if (k === 0) delta = join ? 1 : -1;
      }
      // Son chegaradan chiqmasin: xona to'lib ketmasin va bo'shab qolmasin
      filled = Math.min(total - 1, Math.max(3, filled + delta));
    }
    const mafiaCount = Math.max(1, Math.round(total * 0.3));
    const players = [];
    const shift = s % PLAYER_NAMES.length;
    for (let k = 0; k < filled; k++) {
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
      // Frontend shu belgiga qarab "ochish" so'rovini yuboradi
      fake: true,
      totalPlayers: total,
      mafiaCount,
      sheriffCount: 1,
      doctorCount: 1,
      civilCount: Math.max(0, total - mafiaCount - 2),
      hostId: 'fake',
      createdAt: new Date(now - ((s % 25) + 2) * 60000).toISOString(),
      phase: playing ? 'day_discussion' : 'waiting',
      players,               // `open` bo'lsa joy bor, aks holda xona to'lgan
      events,                // lobbi kartasidagi "kim kirdi / kim chiqdi"
                             // (jangdagi xonada bo'sh: u yerda harakat yo'q)
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
  // Kuniga 4-10 ta: botlar o'zaro o'yini "sayt tirik" hissi uchun kerak,
  // lekin u lobbining asosiy mazmuni bo'lib qolmasligi kerak. Odam kirib
  // o'ynaydigan xonalar bundan tashqari (soxta xonaga bosilganda haqiqiy
  // xona yaratiladi) va ular hisobga kirmaydi.
  const n = 4 + (hashDay(day) % 7);             // kuniga 4-10 ta
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

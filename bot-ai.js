// ==================== BOTLARNING QARORLARI ====================
// Maqsad: bot HAQIQIY O'YINCHIGA o'xshab o'ynasin. Ilgari botlar butunlay
// tasodifiy ovoz berardi (`pickRandom`) va buni sezish juda oson edi:
//  - hech qachon ko'pchilikka qo'shilmaydi;
//  - mafiya bot o'z sherigiga ovoz beradi;
//  - komissar bir odamni ikki marta tekshiradi;
//  - hamma bir vaqtda, 2-4 soniyada ovoz beradi.
//
// Bu modul SOF funksiyalardan iborat (tashqi holatga tegmaydi) — shuning uchun
// uni test qilish oson: bot-ai.test.mjs ga qarang.
//
// ASOSIY G'OYA: bot "bilim" bilan emas, TAXMIN bilan ishlaydi. Har o'yinchiga
// shubha bali yig'iladi (ochiq ma'lumotdan: kim kimga ovoz berdi, chetlatilgan
// odam aslida kim edi), ustiga botning o'z "xarakteri" qo'shiladi. Natijada
// har bot boshqacha o'ynaydi va tashqaridan qarab bot ekanini aytish qiyin.

import crypto from 'crypto';
// Profil rasmlari alohida modulda (9 xil turkum) — avatar.js
import { botAvatarUrl } from './avatar.js';

// ---------- yordamchi ----------

// Deterministik tasodif: bitta o'yinchi bitta o'yin davomida BIR XIL xarakterga
// ega bo'lishi kerak (server qayta ishga tushsa ham). Math.random() bunga yaramaydi.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (arr, r = Math.random()) => (arr.length ? arr[Math.floor(r * arr.length) % arr.length] : null);

// Vaznli tanlov: [{ v, w }] — w qanchalik katta bo'lsa, tanlanish ehtimoli yuqori.
// Har doim eng yuqori ballni tanlamaymiz: odam ham har safar "eng to'g'ri"
// qarorni qabul qilmaydi, va aks holda botlar bir xil ovoz berib qolardi.
export function weightedPick(items, rnd = Math.random) {
  const list = items.filter(i => i && i.w > 0);
  if (!list.length) return null;
  const total = list.reduce((a, i) => a + i.w, 0);
  let x = rnd() * total;
  for (const i of list) { x -= i.w; if (x <= 0) return i.v; }
  return list[list.length - 1].v;
}

// ---------- xarakter ----------

// Har bot uchun o'yin boshida bir marta hisoblanadi. `seed` — userId (barqaror).
//
// speed      0..1  qanchalik tez qaror qiladi (0 = fazaning oxirida)
// activity   0..1  umuman ovoz berish ehtimoli (past bo'lsa "AFK" ga o'xshaydi).
//                  Diapazon ataylab tor (0.86-1): simulyatsiyada botlar ko'p
//                  ovoz bermaganda shahar hech kimni chetlatmasdan faqat
//                  yo'qotardi va mafiya 90% g'alaba qozonardi.
// bandwagon  0..1  ko'pchilik ovoz bergan odamga qo'shilish moyilligi
// noise      0..1  mantiqsiz/tasodifiy qaror ehtimoli (odam ham xato qiladi)
// ping       int   soxta ping uchun bazaviy qiymat (ms)
export function makePersona(seed) {
  const a = hashStr(seed + ':a'), b = hashStr(seed + ':b');
  const c = hashStr(seed + ':c'), d = hashStr(seed + ':d');
  const e = hashStr(seed + ':e');
  return {
    speed: clamp(0.15 + a * 0.85, 0.15, 1),
    activity: clamp(0.86 + b * 0.14, 0.86, 1),
    bandwagon: clamp(0.15 + c * 0.6, 0.15, 0.75),
    noise: clamp(0.04 + d * 0.16, 0.04, 0.2),
    // Real o'yinchilarning pingi: ko'pchiligi 25-90 ms, ba'zilari mobil
    // internetda 150-260 ms. Shu taqsimotni takrorlaymiz.
    ping: e < 0.72 ? Math.round(24 + e * 90) : Math.round(140 + (e - 0.72) * 430),
  };
}

// Ovoz berish kechikishi. Haqiqiy o'yinchilar bir vaqtda ovoz bermaydi:
// kimdir 3 soniyada, kimdir fazaning oxirida "shoshib" bosadi.
// `dur` — fazaning to'liq uzunligi (ms).
export function voteDelayMs(persona, dur = 60000, rnd = Math.random) {
  const min = 2500;
  // tez bot fazaning boshida, sekin bot oxiriga yaqin
  const window = Math.max(6000, dur - 9000);
  const base = min + (1 - persona.speed) * window;
  // ±25% tabiiy tarqoqlik
  const jitter = base * 0.25 * (rnd() * 2 - 1);
  return Math.round(clamp(base + jitter, min, Math.max(min, dur - 3500)));
}

// Soxta ping — har o'lchashda biroz tebranadi, aks holda qotib qolgan raqam
// bot ekanini oshkor qiladi.
export function fakePing(persona, rnd = Math.random) {
  const jitter = Math.round((rnd() * 2 - 1) * Math.max(4, persona.ping * 0.18));
  return Math.max(12, persona.ping + jitter);
}

// ---------- shubha ballari ----------

// OCHIQ ma'lumotdan yig'iladigan ball. Bu "jamoatchilik fikri" — barcha botlar
// uchun umumiy, chunki hamma bir xil narsani ko'rib turadi.
//
// events — o'yin tarixi: { type, ... }
//   'vote'    { round, from, to }              kunduzgi ovoz
//   'lynched' { round, target, wasMafia }      chetlatilgan va u aslida kim edi
//   'killed'  { round, target }                tunda o'ldirilgan
//   'claim'   { round, from, target }          "men tekshirdim: X mafiya"
//   'clear'   { round, from, target }          "men tekshirdim: X tinch"

export function buildSuspicion(events = [], players = []) {
  const s = {};
  const add = (sid, n) => { if (sid) s[sid] = (s[sid] || 0) + n; };
  for (const p of players) s[p.socketId] = 0;

  // MUHIM: "kimga ko'p ovoz berilgan bo'lsa u shubhali" qoidasi ATAYLAB YO'Q.
  // Simulyatsiyada (bot-sim.test.mjs) u mafiyaga XIZMAT QILARDI: mafiya uyushib
  // tinch aholini ayblaydi, o'sha odamning bali ko'tariladi, shahar qo'shilib
  // uni o'zi chetlatadi. Chetlatish aniqligi 30% (= tasodifiy) da qolib,
  // shahar deyarli hech qachon yutmasdi.
  //
  // Shuning uchun shubha faqat NATIJALARdan hisoblanadi: chetlatilgan odam
  // aslida kim edi, tunda kim o'ldirildi. Bularni mafiya soxtalashtira olmaydi.
  const lastRound = events.reduce((m, e) => Math.max(m, e.round || 0), 0);

  // 2) Chetlatilgan odam TINCH AHOLI bo'lib chiqsa — unga ovoz berganlar
  //    shubha tortadi. Bu haqiqiy o'yinchilarning eng ko'p ishlatadigan
  //    mantig'i: "sen tinch aholini o'ldirishga urindingmi — demak mafiyasan".
  for (const e of events) {
    if (e.type !== 'lynched' || e.wasMafia) continue;
    for (const v of events) {
      if (v.type === 'vote' && v.round === e.round && v.to === e.target) add(v.from, 3);
    }
  }

  // 3) Chetlatilgan odam MAFIYA bo'lsa — unga ovoz berganlar ishonch qozonadi
  for (const e of events) {
    if (e.type !== 'lynched' || !e.wasMafia) continue;
    for (const v of events) {
      if (v.type === 'vote' && v.round === e.round && v.to === e.target) add(v.from, -1.6);
    }
  }

  // 4) Tunda o'ldirilgan odam mafiya emas edi (mafiya o'zini o'ldirmaydi) —
  //    unga ovoz bergan odamlar ham shubhali
  for (const e of events) {
    if (e.type !== 'killed') continue;
    for (const v of events) {
      if (v.type === 'vote' && v.round <= e.round && v.to === e.target) add(v.from, 1.6);
    }
  }

  // 5) ISHONCHLI odamning fikri og'irroq. Haqiqiy o'yinda ham shunday:
  //    mafiyani to'g'ri topgan odamga keyingi safar ishonadilar va uning
  //    ayblovi jamoani harakatga keltiradi.
  //
  //    Bu mexanizm komissar botga "ochilish" imkonini beradi: u tekshirib
  //    bilgan mafiyaga ovoz beradi, o'sha odam mafiya bo'lib chiqadi, komissar
  //    ishonch qozonadi va keyingi raundda shahar uning ovoziga qo'shiladi.
  //    Busiz komissar bir ovozli ozchilik bo'lib qolardi va shahar hech qachon
  //    yutmasdi (simulyatsiyada shahar g'alabasi 10% edi).
  const trust = { ...s };
  const lastVotes = events.filter(e => e.type === 'vote' && e.round === lastRound);
  for (const v of lastVotes) {
    if (!v.to || v.to === 'skip') continue;
    const cred = -(trust[v.from] || 0);          // manfiy shubha = ishonch
    if (cred > 0.5) add(v.to, Math.min(2.5, cred * 0.9));
  }

  // 8) KOMISSAR TOZALAGAN ODAMLAR. Haqiqiy o'yinda komissar nafaqat mafiyani
  //    fosh qiladi, balki "men X ni tekshirdim, u tinch" ham deydi. Bu shahar
  //    uchun juda qimmatli: shubha qolgan odamlarga TO'PLANADI va har tun
  //    nomzodlar doirasi torayadi.
  //
  //    Busiz botlar har raund 9-10 odam orasidan tasodifiy tanlardi va
  //    chetlatish aniqligi tasodifiy darajada (30%) qolib ketardi.
  for (const e of events) {
    if (e.type !== 'clear' || !e.target) continue;
    s[e.target] = Math.min(s[e.target] || 0, -2.5);
  }

  // 7) MAFIYANI HIMOYA QILGANLAR — o'yinchilar ishlatadigan eng kuchli mantiq.
  //    Mafiya o'z sherigiga ovoz bermaydi. Shuning uchun chetlatilgan odam
  //    mafiya bo'lib chiqsa, o'sha raundda unga ovoz BERMAGAN odamlar
  //    shubha tortadi: ehtimol ular uni himoya qilgan.
  //
  //    Bu qoida mafiya jamoasini bosqichma-bosqich ochadi va shahar uchun
  //    haqiqiy "tergov" imkonini beradi (bot-sim.test.mjs da shahar
  //    g'alabasi 17% dan ~40% ga ko'tarildi).
  for (const e of events) {
    if (e.type !== 'lynched' || !e.wasMafia) continue;
    const roundVotes = events.filter(v => v.type === 'vote' && v.round === e.round);
    const forHim = new Set(roundVotes.filter(v => v.to === e.target).map(v => v.from));
    for (const v of roundVotes) {
      if (v.from === e.target) continue;          // o'zini hisoblamaymiz
      if (!forHim.has(v.from)) add(v.from, 1.3);  // mafiyani himoya qilgan
    }
  }

  // 6) KOMISSAR DA'VOSI — o'yinning eng muhim mexanikasi.
  //    Haqiqiy mafiyada komissar mafiyani topgach "ochiladi": men tekshirdim,
  //    X mafiya. Shahar unga ishonadi va birgalikda ovoz beradi. Botlar chatda
  //    gaplashmaydi, lekin bu MEXANIKA baribir kerak — usiz komissar bir ovozli
  //    ozchilik bo'lib qoladi va shahar deyarli hech qachon yutmaydi
  //    (bot-sim.test.mjs: da'vosiz shahar g'alabasi ~9%, bilan ~40%).
  //
  //    Da'vo qilgan odam O'ZI ham nishonga aylanadi: mafiya uni darhol
  //    o'ldirishga harakat qiladi — xuddi haqiqiy o'yinda bo'lgani kabi.
  for (const e of events) {
    if (e.type !== 'claim' || !e.target) continue;
    const age = lastRound - (e.round || 0);
    add(e.target, 6 / (1 + age * 0.6));
  }
  return s;
}

// ---------- kunduzgi ovoz ----------

// ctx:
//   me        { socketId, role }
//   alive     [{ socketId, username, role }]   — role FAQAT bot o'zi biladigan joyda
//   mates     [socketId]      mafiya sheriklari (mafiya bot uchun)
//   checked   { sid: 'mafia'|'town' }   komissar bot tekshirgan natijalar
//   suspicion { sid: ball }
//   votes     { from: to }    HOZIRGI raunddagi ovozlar (bandwagon uchun)
//   persona
export function chooseDayVote(ctx, rnd = Math.random) {
  const { me, alive = [], mates = [], checked = {}, suspicion = {}, votes = {}, persona } = ctx;
  const p = persona || makePersona(me?.socketId || 'x');

  // "AFK" — ba'zi o'yinchilar umuman ovoz bermaydi
  if (rnd() > p.activity) return null;

  const others = alive.filter(x => x.socketId !== me.socketId);
  if (!others.length) return 'skip';

  // hozirgi ovozlar: kim nechta ovoz oldi
  const tally = {};
  for (const to of Object.values(votes)) if (to && to !== 'skip') tally[to] = (tally[to] || 0) + 1;
  const leader = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

  const isMafia = mates.length > 0 || ctx.iAmMafia === true;

  // Komissar ANIQ tekshirib topgan mafiya — bu taxmin emas, bilim. Shuning
  // uchun u vazn jadvalidan chetda: deyarli har doim nishon bo'ladi.
  // Qolgan ~15% da bot ovozini yashiradi — haqiqiy komissar ham o'zini
  // birinchi kundan ochib qo'ymaslik uchun ba'zan kutadi.
  const known = others.filter(o => checked[o.socketId] === 'mafia');
  if (known.length && rnd() < 0.85) return pick(known.map(o => o.socketId), rnd());

  const cand = others.map(o => {
    let w = 0.35 + (suspicion[o.socketId] || 0);       // bazaviy + jamoatchilik fikri

    // komissar bot: tekshirgan natija hamma narsadan ustun
    if (checked[o.socketId] === 'mafia') w += 14;
    if (checked[o.socketId] === 'town') w = 0.05;

    // Mafiya bot sherigini himoya qiladi — LEKIN har doim emas. Odam mafiya
    // ham xato qiladi: shubha tortmaslik uchun ba'zan sherigiga ovoz beradi
    // yoki oddiy e'tiborsizlik qiladi. Bu ehtimol `noise` ga bog'langan:
    // botlar xatosiz o'ynaganda shahar ularni hech qachon fosh qila olmasdi.
    if (isMafia && mates.includes(o.socketId)) w = rnd() < p.noise * 0.7 ? 0.5 : 0;

    // bandwagon: ko'pchilik tanlagan odamga qo'shilish
    if (leader && leader[0] === o.socketId) w += leader[1] * 2.0 * p.bandwagon;

    // qasos: menga ovoz bergan odam
    if (votes[o.socketId] === me.socketId) w += 1.4;

    return { v: o.socketId, w: Math.max(0, w) };
  });

  // Mafiya bot jamoatchilik fikriga qo'shilishni afzal ko'radi: o'zini
  // ko'rsatmasdan tinch aholini yo'q qilishning eng xavfsiz yo'li.
  if (isMafia && leader && !mates.includes(leader[0]) && rnd() < 0.34 + p.bandwagon * 0.2) {
    return leader[0];
  }

  // "mantiqsiz" qaror — odam ham ba'zan shunday qiladi
  if (rnd() < p.noise) return pick(others.map(o => o.socketId), rnd());

  // hech kim shubhali bo'lmasa — o'tkazib yuborish
  const best = weightedPick(cand, rnd);
  if (!best) return 'skip';

  // Birinchi raundda ma'lumot yo'q — ba'zilar o'tkazib yuboradi. Lekin
  // ehtimol KICHIK: shahar umuman chetlatmasa, u har raund faqat yo'qotadi
  // va mafiya avtomatik g'alaba qozonadi (bot-sim.test.mjs da tekshirilgan).
  if ((ctx.round || 1) <= 1 && rnd() < 0.12) return 'skip';
  return best;
}

// ---------- tungi harakat ----------

// Har rol uchun nishon tanlash. `memory` — shu botning shaxsiy xotirasi:
//   { checkedSids: [], healedLast: sid, blockedLast: sid }
export function chooseNightTarget(ctx, rnd = Math.random) {
  const { role, me, alive = [], mates = [], memory = {}, suspicion = {}, killedTargets = [] } = ctx;
  const p = ctx.persona || makePersona(me?.socketId || 'x');
  const others = alive.filter(x => x.socketId !== me.socketId);
  const notMates = others.filter(x => !mates.includes(x.socketId));

  switch (role) {
    // Mafiya: eng "xavfli" tinch aholini yo'q qiladi. Xavfli = faol, ko'p
    // ovoz beradigan, jamoani boshqaradigan odam (komissar ko'pincha shunday).
    case 'don':
    case 'mafia':
    case 'advokat': {
      if (!notMates.length) return null;
      // Mafiya ham faqat OCHIQ ma'lumotni ko'radi: u komissar kim ekanini
      // bilmaydi va nishonni taxmin bilan tanlaydi. Shuning uchun tanlovning
      // katta qismi tasodifiy, "ishonchli odamni o'ldirish" esa faqat kichik
      // moyillik. Ilgari bu moyillik juda kuchli edi va mafiya har tuni
      // shaharning eng qimmatli o'yinchisini yo'q qilardi — simulyatsiyada
      // shahar g'alabasi 20% dan oshmasdi.
      const cand = notMates.map(o => ({
        v: o.socketId,
        w: 1 + Math.max(0, 1.3 - (suspicion[o.socketId] || 0)) * 0.7
             + (ctx.voteWeight?.[o.socketId] || 0) * 0.3,
      }));
      return weightedPick(cand, rnd) || pick(notMates.map(o => o.socketId), rnd());
    }

    // Komissar: TEKSHIRILMAGANLARDAN tanlaydi. Ilgari bir odamni qayta-qayta
    // tekshirib, ochiq bot ekanini ko'rsatardi.
    case 'komissar':
    case 'sergeant': {
      const seen = new Set(memory.checkedSids || []);
      const fresh = others.filter(o => !seen.has(o.socketId));
      const pool = fresh.length ? fresh : others;
      const cand = pool.map(o => ({ v: o.socketId, w: 1 + (suspicion[o.socketId] || 0) * 1.5 }));
      return weightedPick(cand, rnd) || pick(pool.map(o => o.socketId), rnd());
    }

    // Doktor: kechagi hujum nishonini yoki o'zini himoya qiladi, lekin
    // KETMA-KET bir odamni davolamaydi (o'yin qoidasi va odamiy mantiq).
    case 'doctor': {
      const pool = alive.filter(o => o.socketId !== memory.healedLast);
      if (!pool.length) return null;
      const cand = pool.map(o => {
        let w = 1;
        if (killedTargets.includes(o.socketId)) w += 3;       // kecha unga hujum bo'lgan
        if (o.socketId === me.socketId) w += 1.6;             // o'zini ham himoya qiladi
        w += Math.max(0, 2 - (suspicion[o.socketId] || 0));   // ishonchli odamni saqlash
        // "Men komissarman" degan odam — mafiyaning birinchi nishoni, shuning
        // uchun doktor uni himoya qilishga harakat qiladi. Haqiqiy o'yinda ham
        // komissar ochilgan zahoti doktor uni "yopadi".
        if (ctx.claimers?.includes(o.socketId)) w += 5;
        return { v: o.socketId, w };
      });
      return weightedPick(cand, rnd);
    }

    // Kezuvchi (escort): eng shubhali odamni band qiladi — shunda u tunda
    // harakat qila olmaydi.
    case 'escort': {
      const pool = others.filter(o => o.socketId !== memory.blockedLast);
      if (!pool.length) return null;
      const cand = pool.map(o => ({ v: o.socketId, w: 1 + (suspicion[o.socketId] || 0) * 2 }));
      return weightedPick(cand, rnd);
    }

    // Qotil: hech kimga tegishli emas, eng faol odamni nishonga oladi
    case 'qotil': {
      if (!others.length) return null;
      const cand = others.map(o => ({ v: o.socketId, w: 1 + (ctx.voteWeight?.[o.socketId] || 0) }));
      return weightedPick(cand, rnd);
    }

    // Daydi (kuzatuvchi): kimni kuzatishi muhim emas, shubhaliga qaraydi
    case 'daydi':
    case 'afsungar':
    case 'bori': {
      if (!others.length) return null;
      const cand = others.map(o => ({ v: o.socketId, w: 1 + (suspicion[o.socketId] || 0) }));
      return weightedPick(cand, rnd);
    }

    default:
      return others.length ? pick(others.map(o => o.socketId), rnd()) : null;
  }
}

// Kim qanchalik "faol" — mafiya va qotil uchun nishon tanlashda ishlatiladi.
// Ko'p ovoz bergan / ko'p ovoz olgan odam jamoada ko'zga tashlanadi.
export function buildVoteWeight(events = []) {
  const w = {};
  for (const e of events) {
    if (e.type !== 'vote') continue;
    if (e.from) w[e.from] = (w[e.from] || 0) + 0.6;
    if (e.to && e.to !== 'skip') w[e.to] = (w[e.to] || 0) + 0.4;
  }
  return w;
}

// ---------- xonani to'ldiruvchi botlar ----------

// Taxalluslar ATAYLAB xilma-xil: faqat toza ismlar bo'lsa (Aziz, Bobur, ...)
// bir xil uslub darhol ko'zga tashlanadi. Haqiqiy o'yinchilar taxallusi
// aralash bo'ladi — ism, kichik harf, raqam, qisqartma.
export const BOT_NAMES = [
  'Aziz', 'Bobur', 'Davron', 'Eldor', 'Farrux', 'Gulnoza', 'Hasan', 'Jasur',
  'Kamol', 'Laziz', 'Madina', 'Nodira', 'Olim', 'Sardor', 'Umid', 'Zafar',
  'Shoxrux', 'Dilshod', 'Bekzod', 'Nurbek', 'Oybek', 'Rustam', 'Sanjar',
  'Temur', 'Ulugbek', 'Xurshid', 'Yusuf', 'Zohid', 'Aziza', 'Dildora',
  'Kamola', 'Malika', 'Nilufar', 'Sevara', 'Zuhra', 'Feruza',
  'aziz_99', 'bobur7', 'jasurbek', 'sardor_01', 'temurxon', 'malika_x',
  'nodirbek', 'shoxrux13', 'davronchik', 'olimjon', 'zafar2007', 'umidbek',
  'lazizzz', 'kamron', 'sherzod', 'asadbek', 'ibrohim', 'muhammad',
  'Doston', 'Elyor', 'Javohir', 'Mirzo', 'Ravshan', 'Sherali', 'Tohir',
  'Vali', 'Anvar', 'Behruz', 'Diyor', 'Farhod', 'Gayrat', 'Ilhom',
  'xoja', 'palvon', 'mergen', 'qora_ot', 'tunchi', 'oqshom',
];

// Socket.io ID siga o'xshash tasodifiy satr — bot socketId'i "bot-3" bo'lsa,
// brauzer konsolini ochgan odam darhol tushunib qolardi.
export function fakeSocketId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < 16; i++) out += abc[crypto.randomInt(abc.length)];
  return out + 'AAA' + abc[crypto.randomInt(abc.length)];
}
// Prisma cuid()'ga o'xshash ID — mijozga SHU yuboriladi (publicPlayers).
// Server ichida bot userId'i 'bot-' bilan boshlanadi (isRealUser shunga
// tayanadi va botlar uchun DB yozuvlari yaratilmaydi), lekin tashqariga
// chiqadigan ID oddiy foydalanuvchi ID'sidan farq qilmasligi kerak.
export function fakePublicId() {
  return 'c' + crypto.randomBytes(12).toString('hex');
}

// Xonani to'ldiruvchi botlar. `count` — nechta kerak.
// `vsBots` o'yinlaridan farqi: nom oldiga 🤖 QO'YILMAYDI va ular
// oddiy o'yinchi sifatida ko'rinadi.
export function makeFillerBots(gameId, count, usedNames = []) {
  const taken = new Set(usedNames.map(n => String(n).toLowerCase()));
  const pool = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
  // Fisher-Yates — `sort(() => Math.random() - 0.5)` teng taqsimlamaydi
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const now = Date.now();
  const bots = [];
  for (let i = 0; i < count; i++) {
    const userId = 'bot-' + gameId.slice(0, 6) + '-' + i + '-' + crypto.randomBytes(3).toString('hex');
    const publicId = fakePublicId();
    bots.push({
      socketId: fakeSocketId(),
      userId,
      publicId,
      username: pool[i] || ('mafia' + crypto.randomInt(1000, 9999)),
      avatar: botAvatarUrl(publicId), role: null, isAlive: true, connected: true, isHost: false,
      isBot: true,
      // Haqiqiy qo'shilish vaqti server tomonda yoziladi: botlar xonaga
      // bittalab, 2-9 soniya oralig'ida kiradi (server.js: scheduleBotJoins).
      joinedAt: now,
      persona: makePersona(userId),
      mem: {},        // komissar/doktor/escort xotirasi
    });
  }
  return bots;
}

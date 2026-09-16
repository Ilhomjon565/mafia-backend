// ==================== BOTLAR BILAN TO'LIQ O'YIN SIMULYATSIYASI ====================
// Alohida funksiyalarni tekshirish yetarli emas: bot mantiqi o'yin DAVOMIDA
// ma'noli ishlashi kerak. Bu yerda soddalashtirilgan mafiya o'yini yuzlab marta
// o'ynaladi va natija tekshiriladi:
//   - o'yin tugaydimi (cheksiz aylanib qolmaydimi);
//   - g'alaba nisbati muvozanatdami (bir tomon doim yutmasligi kerak);
//   - komissar tekshiruvi HAQIQATAN foyda beradimi (tasodifiy o'yindan yaxshiroq).
//
// DIQQAT: bu yerda o'yin qoidalari SODDALASHTIRILGAN (haqiqiy server mantig'i
// emas) — maqsad bot QARORLARINI tekshirish, qoidalarni emas. Qoidalar
// rules.test.mjs da alohida sinaladi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePersona, buildSuspicion, buildVoteWeight, chooseDayVote, chooseNightTarget } from './bot-ai.js';

const MAFIA_ROLES = ['don', 'mafia', 'advokat'];
const sideOf = (r) => (MAFIA_ROLES.includes(r) ? 'mafia' : 'town');

// Bitta o'yin. `smart` false bo'lsa botlar tasodifiy o'ynaydi — taqqoslash uchun.
function playGame(seed, { players = 10, mafia = 3, smart = true, maxRounds = 20 } = {}) {
  // --- rollarni tarqatamiz ---
  const roles = [];
  for (let i = 0; i < mafia; i++) roles.push(i === 0 ? 'don' : 'mafia');
  roles.push('komissar', 'doctor');
  while (roles.length < players) roles.push('civil');

  // deterministik aralashtirish (seed bo'yicha)
  let rs = seed * 2654435761 % 2147483647;
  const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  const ps = roles.map((role, i) => ({
    socketId: 'p' + i, username: 'p' + i, role, isAlive: true,
    persona: makePersona('sim' + seed + '-' + i),
    mem: {},
  }));

  const events = [];
  let round = 0;

  const alive = () => ps.filter(p => p.isAlive);
  const aliveMafia = () => alive().filter(p => sideOf(p.role) === 'mafia');
  const aliveTown = () => alive().filter(p => sideOf(p.role) === 'town');

  const ctxFor = (bot, votes) => ({
    me: { socketId: bot.socketId, role: bot.role },
    role: bot.role,
    alive: alive().map(p => ({ socketId: p.socketId, username: p.username })),
    mates: sideOf(bot.role) === 'mafia' ? aliveMafia().map(p => p.socketId) : [],
    iAmMafia: sideOf(bot.role) === 'mafia',
    checked: bot.mem.checked || {},
    memory: bot.mem,
    suspicion: smart ? buildSuspicion(events, ps) : {},
    voteWeight: smart ? buildVoteWeight(events) : {},
    killedTargets: [],
    claimers: events.filter(e => e.type === 'claim').map(e => e.from),
    votes,
    round,
    persona: bot.persona,
  });

  while (round < maxRounds) {
    round++;

    // ---------- KUNDUZ: ovoz ----------
    const votes = {};
    // tartib aralash bo'lsin: kim birinchi ovoz bergani bandwagon'ga ta'sir qiladi
    const order = [...alive()].sort(() => rnd() - 0.5);
    for (const bot of order) {
      const v = smart
        ? chooseDayVote(ctxFor(bot, votes), rnd)
        : (rnd() < 0.12 ? 'skip' : (alive().filter(p => p !== bot)[Math.floor(rnd() * (alive().length - 1))]?.socketId || 'skip'));
      if (v === null) continue;                 // AFK
      votes[bot.socketId] = v;
      events.push({ type: 'vote', round, from: bot.socketId, to: v });
    }

    // eng ko'p ovoz
    const tally = {};
    for (const to of Object.values(votes)) if (to && to !== 'skip') tally[to] = (tally[to] || 0) + 1;
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
      const out = ps.find(p => p.socketId === sorted[0][0]);
      if (out && out.isAlive) {
        out.isAlive = false;
        events.push({ type: 'lynched', round, target: out.socketId, wasMafia: sideOf(out.role) === 'mafia' });
      }
    }

    if (!aliveMafia().length) return { winner: 'town', round, events };
    if (aliveMafia().length * 2 >= alive().length) return { winner: 'mafia', round, events };

    // ---------- KECHA ----------
    // mafiya
    const lead = aliveMafia()[0];
    if (lead) {
      const t = smart
        ? chooseNightTarget(ctxFor(lead, {}), rnd)
        : aliveTown()[Math.floor(rnd() * aliveTown().length)]?.socketId;
      const victim = ps.find(p => p.socketId === t);
      // doktor himoyasi
      const doc = alive().find(p => p.role === 'doctor');
      let healed = null;
      if (doc) {
        healed = smart ? chooseNightTarget({ ...ctxFor(doc, {}), killedTargets: [] }, rnd)
          : alive()[Math.floor(rnd() * alive().length)]?.socketId;
        doc.mem.healedLast = healed;
      }
      if (victim && victim.isAlive && sideOf(victim.role) !== 'mafia' && victim.socketId !== healed) {
        victim.isAlive = false;
        events.push({ type: 'killed', round, target: victim.socketId });
      }
    }

    // komissar tekshiradi
    const kom = alive().find(p => p.role === 'komissar');
    if (kom) {
      const t = smart ? chooseNightTarget(ctxFor(kom, {}), rnd)
        : alive().filter(p => p !== kom)[Math.floor(rnd() * (alive().length - 1))]?.socketId;
      if (t) {
        kom.mem.checkedSids = [...(kom.mem.checkedSids || []), t];
        const tp = ps.find(p => p.socketId === t);
        if (smart && tp) {
          const isM = sideOf(tp.role) === 'mafia';
          kom.mem.checked = { ...(kom.mem.checked || {}), [t]: isM ? 'mafia' : 'town' };
          // Mafiyani topdi — ertasi kuni "ochiladi" (server ham shunday qiladi)
          events.push({ type: isM ? 'claim' : 'clear', round: round + 1, from: kom.socketId, target: t });
        }
      }
    }

    if (!aliveMafia().length) return { winner: 'town', round, events };
    if (aliveMafia().length * 2 >= alive().length) return { winner: 'mafia', round, events };
  }
  return { winner: 'draw', round, events };
}

function runMany(n, opts) {
  const out = { town: 0, mafia: 0, draw: 0, rounds: 0 };
  for (let i = 1; i <= n; i++) {
    const r = playGame(i, opts);
    out[r.winner]++;
    out.rounds += r.round;
  }
  out.avgRounds = out.rounds / n;
  return out;
}

// ---------- testlar ----------

test('o\'yin har doim tugaydi (cheksiz aylanmaydi)', () => {
  const r = runMany(150);
  assert.equal(r.draw, 0, `${r.draw} o'yin 20 raundda tugamadi`);
  assert.ok(r.avgRounds >= 2 && r.avgRounds <= 12, 'o\'rtacha raund: ' + r.avgRounds.toFixed(1));
});

// DIQQAT — bu raqam nimani o'lchaydi: botlar FAQAT BIR-BIRI bilan o'ynaganda.
// Bunday o'yinda mafiya ustun, va sababi o'yin matematikasi:
//   - 3 mafiya / 10 o'yinchida shahar har raund 2 kishi yo'qotadi (chetlatish
//     + tungi o'lim), mafiya esa 0-1 ta;
//   - o'yin o'rtacha 3.3 raundda tugaydi, ya'ni botlar ma'lumot to'plashga
//     ulgurmaydi (1-raund har doim ma'lumotsiz);
//   - botlar gaplashmaydi, haqiqiy o'yinchilar esa nutqdan ma'lumot oladi.
//
// HAQIQIY xonada bu ko'rsatkich hal qiluvchi emas: u yerda odamlar bor, ular
// ovozli chatda muhokama qiladi va botlar ularning ovoziga QO'SHILADI —
// fayl oxiridagi "odam o'yinga ta'sir qiladi" testlari shuni tekshiradi.
test("g'alaba muvozanatda — bir tomon HAR DOIM yutmaydi", () => {
  const r = runMany(400);
  const townPct = r.town / (r.town + r.mafia) * 100;
  assert.ok(townPct > 12 && townPct < 88,
    `shahar g'alabasi ${townPct.toFixed(1)}% (shahar ${r.town}, mafiya ${r.mafia})`);
});

test('AQLLI botlar tasodifiy botlardan yaxshiroq o\'ynaydi', () => {
  // Bir xil urug'lar bilan: aqlli shahar mafiyani ko'proq topishi kerak
  const smart = runMany(400, { smart: true });
  const dumb = runMany(400, { smart: false });
  const sp = smart.town / (smart.town + smart.mafia);
  const dp = dumb.town / (dumb.town + dumb.mafia);
  assert.ok(sp > dp,
    `aqlli shahar (${(sp * 100).toFixed(1)}%) tasodifiydan (${(dp * 100).toFixed(1)}%) yaxshi bo'lishi kerak`);
});

test('katta xonada ham ishlaydi (16 o\'yinchi, 5 mafiya)', () => {
  const r = runMany(120, { players: 16, mafia: 5 });
  assert.equal(r.draw, 0);
  const townPct = r.town / (r.town + r.mafia) * 100;
  assert.ok(townPct > 3 && townPct < 97, 'katta xonada muvozanat: ' + townPct.toFixed(1) + '%');
});

test('kichik xonada ham ishlaydi (5 o\'yinchi, 1 mafiya)', () => {
  const r = runMany(120, { players: 5, mafia: 1 });
  assert.equal(r.draw, 0);
});

test('botlar bir xil odamga yopishib qolmaydi', () => {
  // 30 o'yinda chetlatilganlar xilma-xil bo'lishi kerak
  const first = new Set();
  for (let i = 1; i <= 30; i++) {
    const r = playGame(i);
    const firstLynch = r.events.find(e => e.type === 'lynched');
    if (firstLynch) first.add(firstLynch.target);
  }
  assert.ok(first.size >= 5, 'birinchi chetlatilganlar juda bir xil: ' + first.size);
});

test('ovozlar tarqoq — hamma bir odamga tashlanmaydi', () => {
  const r = playGame(7);
  const round1 = r.events.filter(e => e.type === 'vote' && e.round === 1);
  const targets = new Set(round1.map(e => e.to));
  assert.ok(targets.size >= 2,
    'birinchi raundda hamma bitta odamga ovoz berdi — bu bot ekanini oshkor qiladi');
});

// ---------- ENG MUHIM TEST: odam o'yinchi o'yinga ta'sir qiladi ----------
// Haqiqiy xonada odam ovozli chatda gapiradi va boshqalarni ishontiradi.
// Botlar buni "eshitmaydi", lekin ular ODAMNING OVOZINI ko'radi va unga
// qo'shiladi (bandwagon). Ya'ni to'g'ri o'ynagan odam botlarni o'z ortidan
// yetaklay oladi — o'yin uning uchun adolatli bo'ladi.
test("odam o'yinchi ovozi botlarni ortidan yetaklaydi", () => {
  const ALIVE10 = Array.from({ length: 8 }, (_, i) => ({ socketId: 'b' + i, username: 'b' + i }));
  ALIVE10.push({ socketId: 'human', username: 'Odam' });
  const target = 'b3';

  // Odam allaqachon ovoz bergan; botlar shundan keyin qaror qiladi
  let joined = 0, total = 0;
  for (let i = 0; i < 8; i++) {
    const bot = { socketId: 'b' + i, role: 'civil' };
    const ctx = {
      me: bot, role: 'civil', alive: ALIVE10, mates: [], checked: {},
      suspicion: {}, votes: { human: target }, round: 2,
      persona: makePersona('human-test-' + i),
    };
    for (let k = 0; k < 60; k++) {
      const v = chooseDayVote(ctx, Math.random);
      if (v !== null && v !== 'skip') { total++; if (v === target) joined++; }
    }
  }
  const pct = joined / total * 100;
  // Tasodifiy tanlovda ~12.5% (8 nomzoddan 1) bo'lardi
  assert.ok(pct > 20, `odamning ovoziga qo'shilish ${pct.toFixed(1)}% — juda kam, botlar odamni e'tiborsiz qoldiradi`);
});

test("botlar odamni ko'r-ko'rona ham quvmaydi", () => {
  // Agar odam ovozi 100% ergashtirsa, o'yin ma'nosini yo'qotadi:
  // bitta odam butun xonani boshqarib olardi.
  const ALIVE = Array.from({ length: 9 }, (_, i) => ({ socketId: 'b' + i, username: 'b' + i }));
  ALIVE.push({ socketId: 'human', username: 'Odam' });
  let joined = 0, total = 0;
  for (let i = 0; i < 9; i++) {
    const ctx = {
      me: { socketId: 'b' + i, role: 'civil' }, role: 'civil', alive: ALIVE, mates: [],
      checked: {}, suspicion: {}, votes: { human: 'b5' }, round: 2,
      persona: makePersona('blind-' + i),
    };
    for (let k = 0; k < 60; k++) {
      const v = chooseDayVote(ctx, Math.random);
      if (v !== null && v !== 'skip') { total++; if (v === 'b5') joined++; }
    }
  }
  const pct = joined / total * 100;
  assert.ok(pct < 75, `odamga qo'shilish ${pct.toFixed(1)}% — botlar mustaqil fikrsiz qoldi`);
});

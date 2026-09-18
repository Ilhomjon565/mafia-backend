// bot-ai.js testlari: bot qarorlari HAQIQIY o'yinchiga o'xshashini tekshiradi.
// Tasodifiylik bor, shuning uchun ehtimolli tekshiruvlar ko'p marta takrorlanadi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makePersona, voteDelayMs, fakePing, buildSuspicion,
  buildVoteWeight, chooseDayVote, chooseNightTarget, weightedPick,
  makeFillerBots, BOT_NAMES,
  nightDelayMs, botChatLine, chooseChatAct, typingMs,
  styleLine, mentionedPlayers, classifyChat, chooseReaction, chooseDayOpener, pickSpeakers, LINE_KINDS,
  isWaitAsk, isWaitYes, isWaitNo,
} from './bot-ai.js';

const P = (sid, role) => ({ socketId: sid, username: sid, role });
const ALIVE = ['a', 'b', 'c', 'd', 'e'].map(s => P(s));

// deterministik "tasodif" — takrorlanadigan test uchun
function seq(values) { let i = 0; return () => values[i++ % values.length]; }

// ---------- xarakter ----------

test('makePersona bir xil seed uchun bir xil natija beradi', () => {
  const a = makePersona('u1'), b = makePersona('u1'), c = makePersona('u2');
  assert.deepEqual(a, b, 'bir xil userId -> bir xil xarakter (server restartida ham)');
  assert.notDeepEqual(a, c, 'boshqa userId -> boshqa xarakter');
});

test('xarakter qiymatlari chegaralar ichida', () => {
  for (let i = 0; i < 200; i++) {
    const p = makePersona('user' + i);
    assert.ok(p.speed > 0 && p.speed <= 1);
    assert.ok(p.activity >= 0.72 && p.activity <= 1);
    assert.ok(p.bandwagon >= 0.15 && p.bandwagon <= 0.75);
    assert.ok(p.noise >= 0.04 && p.noise <= 0.2);
    assert.ok(p.ping >= 24 && p.ping <= 265, 'ping real diapazonda: ' + p.ping);
  }
});

test('botlar bir vaqtda ovoz bermaydi', () => {
  const delays = new Set();
  for (let i = 0; i < 40; i++) {
    delays.add(voteDelayMs(makePersona('u' + i), 60000, () => 0.5));
  }
  assert.ok(delays.size > 25, 'kechikishlar tarqoq bo\'lishi kerak, bor: ' + delays.size);
});

test('kechikish faza ichida qoladi', () => {
  for (const dur of [20000, 45000, 90000]) {
    for (let i = 0; i < 50; i++) {
      const d = voteDelayMs(makePersona('x' + i), dur, Math.random);
      assert.ok(d >= 2500, 'juda tez: ' + d);
      assert.ok(d <= dur - 3000, `faza tugashidan oldin ovoz berishi kerak (${d} / ${dur})`);
    }
  }
});

test('fakePing tebranadi, lekin haqiqatga o\'xshaydi', () => {
  const p = makePersona('pinger');
  const vals = new Set();
  for (let i = 0; i < 30; i++) vals.add(fakePing(p, Math.random));
  assert.ok(vals.size > 10, 'ping qotib qolmasligi kerak');
  for (const v of vals) assert.ok(v >= 12 && v < 400, 'ping haqiqatga o\'xshamaydi: ' + v);
});

// ---------- shubha ballari ----------

test('tinch aholini chetlatganlar shubha ballini oladi', () => {
  const events = [
    { type: 'vote', round: 1, from: 'a', to: 'c' },
    { type: 'vote', round: 1, from: 'b', to: 'c' },
    { type: 'vote', round: 1, from: 'd', to: 'e' },
    { type: 'lynched', round: 1, target: 'c', wasMafia: false },
  ];
  const s = buildSuspicion(events, ALIVE);
  assert.ok(s.a > s.d, 'tinch aholiga ovoz bergan a, e ga ovoz bergan d dan shubhaliroq');
  assert.ok(s.b > s.d);
});

test('mafiyani topganlar ishonch qozonadi', () => {
  const events = [
    { type: 'vote', round: 1, from: 'a', to: 'c' },
    { type: 'lynched', round: 1, target: 'c', wasMafia: true },
  ];
  const s = buildSuspicion(events, ALIVE);
  assert.ok(s.a < 0, 'mafiyani topgan odamning bali manfiy bo\'lishi kerak: ' + s.a);
});

test('shubha faqat NATIJALARdan hisoblanadi, ovoz sonidan emas', () => {
  // Uch kishi "b" ga ovoz berdi, lekin natija hali yo'q. Mafiya uyushib bir
  // odamni ayblasa, shahar avtomatik unga qo'shilmasligi kerak.
  const s = buildSuspicion([
    { type: 'vote', round: 1, from: 'a', to: 'b' },
    { type: 'vote', round: 1, from: 'c', to: 'b' },
    { type: 'vote', round: 1, from: 'd', to: 'b' },
  ], ALIVE);
  assert.equal(s.b || 0, 0, 'ovoz olgani uchun shubha ortmasligi kerak (mafiya manipulyatsiyasi)');
});

test("chetlatilgan mafiyani himoya qilganlar fosh bo'ladi", () => {
  // "c" mafiya bo'lib chiqdi. "a" unga ovoz bergan, "d" esa bermagan.
  const s = buildSuspicion([
    { type: 'vote', round: 1, from: 'a', to: 'c' },
    { type: 'vote', round: 1, from: 'b', to: 'c' },
    { type: 'vote', round: 1, from: 'd', to: 'e' },
    { type: 'lynched', round: 1, target: 'c', wasMafia: true },
  ], ALIVE);
  assert.ok(s.d > s.a, "mafiyaga ovoz bermagan d shubhaliroq bo'lishi kerak");
});

test("komissar tozalagan odam ishonchli bo'ladi", () => {
  const s = buildSuspicion([
    { type: 'vote', round: 1, from: 'a', to: 'b' },
    { type: 'clear', round: 2, from: 'k', target: 'b' },
  ], ALIVE);
  assert.ok(s.b <= -2, 'tozalangan odam ishonch olishi kerak: ' + s.b);
});

test("komissar da'vosi nishonni keskin shubhali qiladi", () => {
  const s = buildSuspicion([
    { type: 'claim', round: 2, from: 'k', target: 'd' },
  ], ALIVE);
  assert.ok(s.d > 4, "da'vo kuchli signal bo'lishi kerak: " + s.d);
});

// ---------- kunduzgi ovoz ----------

test('mafiya bot sherigiga HECH QACHON ovoz bermaydi', () => {
  const ctx = {
    me: P('a', 'mafia'), alive: ALIVE, mates: ['a', 'b'],
    suspicion: { b: 99 },              // sherik eng shubhali bo'lsa ham
    votes: {}, round: 2,
    persona: { speed: 0.5, activity: 1, bandwagon: 0.3, noise: 0, ping: 50 },
  };
  for (let i = 0; i < 300; i++) {
    const v = chooseDayVote(ctx, Math.random);
    assert.notEqual(v, 'b', 'mafiya sherigiga ovoz berdi');
  }
});

test('komissar tekshirib topgan mafiyaga ovoz beradi', () => {
  const ctx = {
    me: P('a', 'komissar'), alive: ALIVE, mates: [],
    checked: { d: 'mafia', b: 'town' },
    suspicion: { b: 5, c: 4 },        // jamoatchilik boshqa odamni shubhalaydi
    votes: {}, round: 2,
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  let hit = 0;
  for (let i = 0; i < 200; i++) if (chooseDayVote(ctx, Math.random) === 'd') hit++;
  assert.ok(hit > 150, 'tekshirilgan mafiyaga ovoz berish ustun bo\'lishi kerak: ' + hit + '/200');
});

test('komissar tinch deb bilgan odamga ovoz bermaydi (deyarli)', () => {
  const ctx = {
    me: P('a', 'komissar'), alive: ALIVE, mates: [],
    checked: { b: 'town' }, suspicion: { b: 8 },
    votes: {}, round: 2,
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  let hit = 0;
  for (let i = 0; i < 300; i++) if (chooseDayVote(ctx, Math.random) === 'b') hit++;
  assert.ok(hit < 20, 'tekshirilgan tinch aholiga ovoz berish kamayishi kerak: ' + hit + '/300');
});

test('bandwagon: ko\'pchilik tanlagan odamga qo\'shiladi', () => {
  const base = {
    me: P('a'), alive: ALIVE, mates: [], suspicion: {}, round: 2,
    votes: { b: 'c', d: 'c', e: 'c' },     // uchtasi c ga ovoz bergan
  };
  const high = { ...base, persona: { speed: 0.5, activity: 1, bandwagon: 0.75, noise: 0, ping: 50 } };
  const low = { ...base, persona: { speed: 0.5, activity: 1, bandwagon: 0.15, noise: 0, ping: 50 } };
  const count = (ctx) => {
    let n = 0;
    for (let i = 0; i < 400; i++) if (chooseDayVote(ctx, Math.random) === 'c') n++;
    return n;
  };
  assert.ok(count(high) > count(low), 'bandwagon yuqori bot ko\'pchilikka ko\'proq qo\'shiladi');
});

test('AFK: activity past bot ba\'zan umuman ovoz bermaydi', () => {
  const ctx = {
    me: P('a'), alive: ALIVE, mates: [], suspicion: {}, votes: {}, round: 2,
    persona: { speed: 0.5, activity: 0.75, bandwagon: 0.3, noise: 0, ping: 50 },
  };
  let skipped = 0;
  for (let i = 0; i < 400; i++) if (chooseDayVote(ctx, Math.random) === null) skipped++;
  assert.ok(skipped > 40 && skipped < 200, 'AFK ehtimoli haqiqatga o\'xshash: ' + skipped + '/400');
});

test('bot o\'ziga ovoz bermaydi', () => {
  const ctx = {
    me: P('a'), alive: ALIVE, mates: [], suspicion: { a: 50 },
    votes: {}, round: 2,
    persona: { speed: 0.5, activity: 1, bandwagon: 0.3, noise: 0.2, ping: 50 },
  };
  for (let i = 0; i < 300; i++) {
    assert.notEqual(chooseDayVote(ctx, Math.random), 'a', 'bot o\'ziga ovoz berdi');
  }
});

// ---------- tungi harakat ----------

test('komissar bir odamni ikki marta tekshirmaydi', () => {
  const ctx = {
    role: 'komissar', me: P('a', 'komissar'), alive: ALIVE, mates: [],
    memory: { checkedSids: ['b', 'c'] }, suspicion: { b: 10, c: 10 },
  };
  for (let i = 0; i < 300; i++) {
    const t = chooseNightTarget(ctx, Math.random);
    assert.ok(t === 'd' || t === 'e', 'tekshirilmagan odamni tanlashi kerak, tanladi: ' + t);
  }
});

test('hammasi tekshirilgan bo\'lsa komissar qotib qolmaydi', () => {
  const ctx = {
    role: 'komissar', me: P('a', 'komissar'), alive: ALIVE, mates: [],
    memory: { checkedSids: ['b', 'c', 'd', 'e'] }, suspicion: {},
  };
  const t = chooseNightTarget(ctx, Math.random);
  assert.ok(t && t !== 'a', 'nishon bo\'lishi kerak');
});

test('doktor ketma-ket bir odamni davolamaydi', () => {
  const ctx = {
    role: 'doctor', me: P('a', 'doctor'), alive: ALIVE, mates: [],
    memory: { healedLast: 'b' }, killedTargets: ['b'], suspicion: {},
  };
  for (let i = 0; i < 200; i++) {
    assert.notEqual(chooseNightTarget(ctx, Math.random), 'b', 'o\'yin qoidasi buzildi');
  }
});

test('mafiya sherigini o\'ldirmaydi', () => {
  const ctx = {
    role: 'mafia', me: P('a', 'mafia'), alive: ALIVE, mates: ['a', 'b'],
    memory: {}, suspicion: {}, voteWeight: { b: 99 },
  };
  for (let i = 0; i < 300; i++) {
    const t = chooseNightTarget(ctx, Math.random);
    assert.notEqual(t, 'b', 'mafiya sherigini nishonga oldi');
    assert.notEqual(t, 'a', 'mafiya o\'zini nishonga oldi');
  }
});

test('mafiya ishonch qozongan odamni nishonga oladi', () => {
  // suspicion past = jamoa ishonadi = mafiya uchun xavfli
  const ctx = {
    role: 'don', me: P('a', 'don'), alive: ALIVE, mates: ['a'],
    memory: {}, suspicion: { b: 0, c: 8, d: 8, e: 8 }, voteWeight: {},
  };
  let b = 0;
  for (let i = 0; i < 400; i++) if (chooseNightTarget(ctx, Math.random) === 'b') b++;
  assert.ok(b > 130, 'ishonchli o\'yinchi ko\'proq nishonga olinishi kerak: ' + b + '/400');
});

test('escort ketma-ket bir odamni bloklamaydi', () => {
  const ctx = {
    role: 'escort', me: P('a', 'escort'), alive: ALIVE, mates: [],
    memory: { blockedLast: 'c' }, suspicion: { c: 20 },
  };
  for (let i = 0; i < 200; i++) {
    assert.notEqual(chooseNightTarget(ctx, Math.random), 'c');
  }
});

test('noma\'lum rol ham nishon qaytaradi (qotib qolmaydi)', () => {
  const t = chooseNightTarget({
    role: 'yangi_rol', me: P('a'), alive: ALIVE, mates: [], memory: {}, suspicion: {},
  }, Math.random);
  assert.ok(t && t !== 'a');
});

test('bitta tirik qolganda tungi harakat null bo\'ladi', () => {
  const t = chooseNightTarget({
    role: 'mafia', me: P('a', 'mafia'), alive: [P('a')], mates: ['a'], memory: {}, suspicion: {},
  }, Math.random);
  assert.equal(t, null);
});

// ---------- yordamchilar ----------

test('weightedPick vaznga qarab tanlaydi', () => {
  const items = [{ v: 'x', w: 9 }, { v: 'y', w: 1 }];
  let x = 0;
  for (let i = 0; i < 1000; i++) if (weightedPick(items, Math.random) === 'x') x++;
  assert.ok(x > 820 && x < 970, 'taqsimot vaznga mos emas: ' + x + '/1000');
});

test('weightedPick bo\'sh/nolga chidamli', () => {
  assert.equal(weightedPick([], Math.random), null);
  assert.equal(weightedPick([{ v: 'a', w: 0 }], Math.random), null);
});

test('buildVoteWeight faol o\'yinchini ajratadi', () => {
  const w = buildVoteWeight([
    { type: 'vote', round: 1, from: 'a', to: 'b' },
    { type: 'vote', round: 2, from: 'a', to: 'c' },
    { type: 'vote', round: 1, from: 'd', to: 'b' },
  ]);
  assert.ok(w.a > w.d, 'ko\'p ovoz bergan a faolroq');
});

test('bo\'sh tarix bilan ham ishlaydi', () => {
  assert.deepEqual(buildVoteWeight([]), {});
  const s = buildSuspicion([], ALIVE);
  assert.equal(Object.values(s).filter(v => v !== 0).length, 0);
});

// ---------- xonani to'ldiruvchi botlar ----------

test('botlar soni aniq, ismlar takrorlanmaydi', () => {
  const bots = makeFillerBots('game123456', 7, ['Ilhomjon']);
  assert.equal(bots.length, 7);
  const names = bots.map(b => b.username);
  assert.equal(new Set(names).size, 7, 'ismlar takrorlandi: ' + names.join(', '));
});

test('bot ekanini oshkor qiladigan belgi YO\'Q', () => {
  const bots = makeFillerBots('g1', 12, []);
  for (const b of bots) {
    // DIQQAT: oddiy /bot/i QOIDA EMAS — ro'yxatda 'Botir' bor va u haqiqiy
    // o'zbek ismi. U bot ekanini oshkor qilmaydi, lekin test har safar
    // tasodifan tanlanganda yiqilardi (deploy darvozasi shu testda).
    // Shuning uchun faqat HAQIQIY belgilar tekshiriladi: yakka 'bot' so'zi,
    // raqam bilan birga ('bot7') yoki ajratgich bilan ('bot_1', 'mafia-bot').
    assert.ok(!/(^|[^a-z])bot([^a-z]|$)/i.test(b.username),
      'ismda yakka "bot" so\'zi bor: ' + b.username);
    assert.ok(!/bot\s*[-_]?\s*\d/i.test(b.username),
      'ismda "bot+raqam" bor: ' + b.username);
    assert.ok(!b.username.includes('🤖'), 'ismda robot emojisi bor');
    assert.ok(!/^bot-/.test(b.socketId), 'socketId bot ekanini ko\'rsatadi: ' + b.socketId);
    assert.ok(!/bot/i.test(b.publicId), 'publicId bot ekanini ko\'rsatadi: ' + b.publicId);
    assert.ok(b.publicId.startsWith('c'), 'publicId cuid ga o\'xshashi kerak: ' + b.publicId);
    assert.ok(b.socketId.length >= 18, 'socketId socket.io formatiga o\'xshamaydi');
  }
});

test('server ichida bot sifatida taniladi', () => {
  const bots = makeFillerBots('g1', 3, []);
  for (const b of bots) {
    assert.equal(b.isBot, true, 'server mantiqi shunga tayanadi');
    assert.ok(String(b.userId).startsWith('bot-'), 'isRealUser() shu prefiksga tayanadi');
    assert.ok(b.persona && typeof b.persona.speed === 'number', 'xarakter berilishi kerak');
  }
});

test("qo'shilish vaqti server tomonda beriladi", () => {
  // Botlar xonaga bittalab kiradi (server.js: scheduleBotJoins), shuning uchun
  // bu yerda faqat boshlang'ich qiymat bo'ladi.
  const bots = makeFillerBots('g1', 8, []);
  const now = Date.now();
  for (const b of bots) {
    assert.ok(typeof b.joinedAt === "number", "joinedAt bolishi kerak");
    assert.ok(Math.abs(now - b.joinedAt) < 5000, "kelajakda yoki juda eski bolmasin");
  }
});

test('host taxallusi takrorlanmaydi', () => {
  const bots = makeFillerBots('g1', 5, ['Sardor', 'aziz_99']);
  const names = bots.map(b => b.username.toLowerCase());
  assert.ok(!names.includes('sardor'), 'host ismi bilan bir xil bot paydo bo\'ldi');
  assert.ok(!names.includes('aziz_99'));
});

test('ismlar tugasa ham ishlaydi (zaxira nom)', () => {
  const bots = makeFillerBots('g1', BOT_NAMES.length + 5, []);
  assert.equal(bots.length, BOT_NAMES.length + 5);
  assert.equal(new Set(bots.map(b => b.username)).size, bots.length, 'zaxira nomlar ham takrorlanmasligi kerak');
});

test('nol bot so\'ralsa bo\'sh ro\'yxat', () => {
  assert.deepEqual(makeFillerBots('g1', 0, []), []);
});


// ==================== TUNGI KECHIKISH ====================
// Ilgari BARCHA botlar, rollar va tunlar uchun bitta tor oyna (2.0-4.5s)
// ishlatilardi: 20-25 soniyalik bosqich har safar hisoblagichning 10-22% ida
// yopilardi va progress-bar aynan bir joyda o'lardi.

test('tungi kechikish bosqich ichida qoladi', () => {
  for (const speed of [0.15, 0.5, 1]) {
    for (const stepMs of [8000, 20000, 25000]) {
      for (let i = 0; i < 200; i++) {
        const d = nightDelayMs({ speed }, stepMs);
        assert.ok(d >= 1500, 'juda tez: ' + d);
        assert.ok(d < stepMs, 'bosqichdan chiqib ketdi: ' + d + ' >= ' + stepMs);
      }
    }
  }
});

test('tez bot sekin botdan oldin harakat qiladi', () => {
  const avg = (speed) => {
    let sum = 0;
    for (let i = 0; i < 400; i++) sum += nightDelayMs({ speed }, 25000);
    return sum / 400;
  };
  assert.ok(avg(1) < avg(0.15) - 3000, 'xarakter kechikishga ta\'sir qilmadi');
});

test('kechikish QOTIB qolmaydi — 2.0-4.5s oynasi qaytmasin', () => {
  // Eski xulqning regressiyaga qaytmasligi uchun: 25 soniyalik bosqichda
  // sekin bot 4.5 soniyadan ancha kech harakat qilishi kerak.
  const vals = new Set();
  for (let i = 0; i < 200; i++) vals.add(nightDelayMs({ speed: 0.2 }, 25000));
  const min = Math.min(...vals);
  assert.ok(min > 5000, 'sekin bot hali ham 2-4.5s oynasida: ' + min);
});

// ==================== BOTLARNING GAPI ====================

test('ibora nom bilan to\'ldiriladi va joy belgisi qolmaydi', () => {
  for (let i = 0; i < 300; i++) {
    const l = botChatLine('accuse', { n: 'Aziz' });
    assert.ok(l && l.text, 'ibora qaytmadi');
    assert.ok(!l.text.includes('{n}'), 'joy belgisi qoldi: ' + l.text);
    assert.ok(l.text.includes('Aziz'), 'nom qo\'yilmadi: ' + l.text);
  }
});

test('nom yo\'q bo\'lsa nom talab qiladigan ibora ishlatilmaydi', () => {
  for (let i = 0; i < 300; i++) {
    const l = botChatLine('agree', {});
    // `agree` ning HAMMA iborasi nom talab qiladi — demak null qaytishi kerak
    assert.equal(l, null, 'nomsiz ibora chiqdi: ' + (l && l.text));
  }
});

test('takror gap qaytmaydi — bot ekanini oshkor qiladi', () => {
  const said = [];
  for (let i = 0; i < 8; i++) {
    const l = botChatLine('open', {}, said);
    assert.ok(l, 'ibora tugab qoldi');
    assert.ok(!said.includes(l.key), 'takror ibora: ' + l.key);
    said.push(l.key);
  }
});

test('iboralar imlo jihatdan "telefonda yozilgan" — bosh harf yo\'q', () => {
  // Ideal imlo o'zi shubha tug'diradi: gap kichik harfda va nuqtasiz bo'lsin.
  for (const kind of ['open', 'accuse', 'agree', 'defend', 'skip', 'lastWord']) {
    for (let i = 0; i < 60; i++) {
      const l = botChatLine(kind, { n: 'Aziz' });
      if (!l) continue;
      const first = l.key[0];
      assert.equal(first, first.toLowerCase(), 'bosh harf bilan: ' + l.key);
      assert.ok(!/[.!?]$/.test(l.key), 'tinish belgisi bilan tugadi: ' + l.key);
    }
  }
});

test('mafiya bot sherigini AYBLAMAYDI', () => {
  const ctx = {
    me: { socketId: 'a', role: 'mafia' },
    alive: [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'c' }, { socketId: 'd' }],
    mates: ['a', 'b'],
    iAmMafia: true,
    suspicion: { b: 9 },            // sherigi eng shubhali ko'rinadi
    votes: {}, round: 3, memory: {},
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  for (let i = 0; i < 400; i++) {
    const act = chooseChatAct(ctx, Math.random);
    if (act && act.targetSid) assert.notEqual(act.targetSid, 'b', 'sherigini ayblab qo\'ydi');
  }
});

test('komissar bot topgan mafiyasini e\'lon qiladi', () => {
  const ctx = {
    me: { socketId: 'a', role: 'komissar' },
    alive: [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'c' }],
    mates: [], iAmMafia: false,
    suspicion: {}, votes: {}, round: 2,
    memory: { checked: { b: 'mafia' } },
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  const act = chooseChatAct(ctx, Math.random);
  assert.equal(act.kind, 'claim');
  assert.equal(act.targetSid, 'b');
  // Bir marta e'lon qilingandan keyin takrorlamaydi
  const ctx2 = { ...ctx, memory: { checked: { b: 'mafia' }, claimedSids: ['b'] } };
  const act2 = chooseChatAct(ctx2, Math.random);
  assert.notEqual(act2 && act2.kind, 'claim', 'bir xil da\'voni takrorladi');
});

test('o\'ziga ovoz kelsa bot himoyalanadi', () => {
  const ctx = {
    me: { socketId: 'a', role: 'civil' },
    alive: [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'c' }],
    mates: [], suspicion: {}, round: 3, memory: {},
    votes: { b: 'a', c: 'a' },       // ikkovi menga ovoz bergan
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  let defended = 0;
  for (let i = 0; i < 400; i++) if (chooseChatAct(ctx, Math.random)?.kind === 'defend') defended++;
  assert.ok(defended > 200, 'o\'zini himoya qilmadi: ' + defended + '/400');
});

test('yozish vaqti gap uzunligiga bog\'liq va cheklangan', () => {
  const short = typingMs('ok', () => 0.5);
  const long = typingMs('hamma tayyor bosa bosdm menimcha boshlaymiz', () => 0.5);
  assert.ok(long > short, 'uzun gap tezroq yozildi');
  assert.ok(short >= 900, 'juda tez: ' + short);
  assert.ok(typingMs('x'.repeat(300)) <= 12000, 'juda sekin');
});

// ==================== ADVOKAT ====================
// Ilgari advokat don/mafia bilan bir guruhda edi va `notMates` dan tanlardi,
// ya'ni HAR DOIM mafiya BO'LMAGAN odamni "himoya" qilib, Komissardan
// yashirish qobiliyatini butunlay behuda sarflardi.

test('advokat sherigini (yoki o\'zini) himoya qiladi', () => {
  const ctx = {
    role: 'advokat',
    me: { socketId: 'a', role: 'advokat' },
    alive: [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'c' }, { socketId: 'd' }],
    mates: ['a', 'b'],
    suspicion: { b: 3, c: 9 },
    memory: {},
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  for (let i = 0; i < 300; i++) {
    const t = chooseNightTarget(ctx, Math.random);
    assert.ok(['a', 'b'].includes(t), 'mafiya bo\'lmagan odamni himoya qildi: ' + t);
  }
});

test('doktor bot o\'zini davolash huquqini ikki marta ishlatmaydi', () => {
  const ctx = {
    role: 'doctor',
    me: { socketId: 'a', role: 'doctor' },
    alive: [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'c' }],
    mates: [], suspicion: {}, killedTargets: [],
    memory: { selfHeal: true },     // huquq allaqachon sarflangan
    persona: { speed: 0.5, activity: 1, bandwagon: 0.2, noise: 0, ping: 50 },
  };
  for (let i = 0; i < 300; i++) {
    assert.notEqual(chooseNightTarget(ctx, Math.random), 'a', 'o\'zini qayta davoladi');
  }
});


// ==================== ODAM GAPIGA JAVOB (2026-09-18) ====================
// Talab: botlar chatda "o'z gapini gapirib" turmasin — odamning gapini
// eshitsin. Ayblangan bot javob bersin, salomga salom, komissar da'vosiga
// savol, mafiya kanalida sherik rozilik bildirsin.

const ROSTER = [
  { socketId: 'a', username: 'Aziz', seat: 1 },
  { socketId: 'b', username: 'bobur7', seat: 2 },
  { socketId: 'c', username: 'Shahnoza', seat: 3 },
  { socketId: 'h', username: 'ilhom', seat: 4 },
];

test('xabarda tilga olingan o\'yinchi topiladi — ism va o\'rin raqami bilan', () => {
  const m = (t, o) => mentionedPlayers(t, ROSTER, { authorSid: 'h', ...o });
  assert.deepEqual(m('Aziz mafiya'), ['a']);
  assert.deepEqual(m('aziz shubhali'), ['a'], 'katta-kichik harf');
  assert.deepEqual(m('menimcha 2 mafiya'), ['b'], "o'rin raqami");
  assert.deepEqual(m('3 ga beraman'), ['c']);
  assert.deepEqual(m('bobur mafiya'), ['b'], 'taxallusning ildizi (bobur7 -> bobur)');
  assert.deepEqual(m('ilhom men emasman'), [], "muallifning o'zi hisoblanmaydi");
  assert.deepEqual(m('salom hammaga'), []);
  // Kutish xonasida raqam kimnidir chaqirish emas
  assert.deepEqual(m('2 kishi kerak', { seats: false }), []);
  // Ikki kishi birga
  assert.deepEqual(m('Aziz va 3 shubhali').sort(), ['a', 'c']);
});

test('xabar turi tasniflanadi', () => {
  const T = { 'salom': 'greet', 'Assalomu alaykum': 'greet', 'men komissarman Aziz mafiya': 'claim',
    'tekshirdim 3 qora': 'claim', 'skip qilaylik': 'skip', 'Aziz mafiya': 'accuse',
    '3 ga beraman': 'accuse', 'kim mafiya?': 'question', 'nima gap': 'other', 'goo': 'other' };
  for (const [t, k] of Object.entries(T)) assert.equal(classifyChat(t), k, t);
});

const alive = ROSTER.map(r => ({ socketId: r.socketId, username: r.username }));
const base = (over = {}) => ({
  kind: 'accuse', targets: ['a'], authorSid: 'h', me: { socketId: 'a', role: 'civil' },
  mates: [], iAmMafia: false, alive, suspicion: {}, persona: makePersona('a'), phase: 'day_discussion', ...over,
});

test('AYBLANGAN bot hech qachon jim turmaydi: himoya yoki qarshi ayblov', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const r = chooseReaction(base());
    assert.ok(r, 'jim turdi');
    assert.ok(['defend', 'counter'].includes(r.kind), r.kind);
    if (r.kind === 'counter') assert.equal(r.targetSid, 'h', 'qarshi ayblov ayblovchiga qaratilmadi');
    seen.add(r.kind);
  }
  assert.ok(seen.has('defend') && seen.has('counter'), 'ikkala javob turi ham uchrashi kerak');
});

test('mafiya bot sherigi ayblanganda unga QO\'SHILMAYDI', () => {
  for (let i = 0; i < 300; i++) {
    const r = chooseReaction(base({ targets: ['b'], me: { socketId: 'a', role: 'mafia' }, mates: ['a', 'b'], iAmMafia: true }));
    if (r) assert.notEqual(r.kind, 'agree', 'sherigiga qarshi qo\'shildi');
    if (r) assert.equal(r.kind, 'disagree');
  }
});

test('komissar da\'vosi sherigiga tegsa mafiya bot shubha bildiradi', () => {
  for (let i = 0; i < 200; i++) {
    const r = chooseReaction(base({ kind: 'claim', targets: ['b'], me: { socketId: 'a', role: 'mafia' }, mates: ['a', 'b'], iAmMafia: true }));
    assert.ok(r && r.kind === 'doubtClaim', JSON.stringify(r));
  }
});

test("tinch bot komissar da'vosiga savol beradi yoki qo'shiladi", () => {
  const kinds = new Set();
  for (let i = 0; i < 400; i++) {
    const r = chooseReaction(base({ kind: 'claim', targets: ['b'] }));
    if (r) kinds.add(r.kind);
  }
  assert.ok(kinds.has('askClaim') || kinds.has('agree'), [...kinds].join(','));
  assert.ok(!kinds.has('doubtClaim'), 'tinch bot da\'voga shubha bildirmaydi');
});

test('kutish xonasida faqat salomga javob', () => {
  for (let i = 0; i < 200; i++) {
    const r = chooseReaction(base({ kind: 'greet', targets: [], phase: 'waiting' }));
    if (r) assert.equal(r.kind, 'greetReply');
    assert.equal(chooseReaction(base({ kind: 'accuse', targets: ['a'], phase: 'waiting' })), null, 'kutish xonasida ayblovga javob');
  }
});

test('hech kimga tegmagan oddiy gapga bot jim turadi', () => {
  for (let i = 0; i < 200; i++) assert.equal(chooseReaction(base({ kind: 'other', targets: [] })), null);
});

test('kun boshidagi gap OLDINGI natijaga qaraydi', () => {
  const me = { socketId: 'a', role: 'civil' };
  let town = 0, maf = 0, kill = 0, none = 0;
  for (let i = 0; i < 300; i++) {
    const r1 = chooseDayOpener({ me, mates: [], last: { lynched: { sid: 'b', wasMafia: false }, killed: [], anyNight: true } });
    if (r1.kind === 'afterLynchTown') { town++; assert.equal(r1.targetSid, 'b'); }
    const r2 = chooseDayOpener({ me, mates: [], last: { lynched: { sid: 'b', wasMafia: true }, killed: [], anyNight: true } });
    if (r2.kind === 'afterLynchMafia') maf++;
    const r3 = chooseDayOpener({ me, mates: [], last: { lynched: null, killed: ['c'], anyNight: true } });
    if (r3.kind === 'afterKill') { kill++; assert.equal(r3.targetSid, 'c'); }
    const r4 = chooseDayOpener({ me, mates: [], last: { lynched: null, killed: [], anyNight: true } });
    if (r4.kind === 'noKill') none++;
  }
  // lynched + tinch tun bo'lsa 'noKill' ham raqobatlashadi (3 : 2 : 1.2), shuning uchun ~48%
  assert.ok(town > 100 && maf > 100 && kill > 150 && none > 150, [town, maf, kill, none].join(','));
  assert.equal(chooseDayOpener({ me, mates: [], last: null }).kind, 'open');
});

test("mafiya bot chetlatilgan SHERIGI haqida \"zo'r\" demaydi", () => {
  for (let i = 0; i < 200; i++) {
    const r = chooseDayOpener({ me: { socketId: 'a', role: 'mafia' }, mates: ['a', 'b'], iAmMafia: true,
      last: { lynched: { sid: 'b', wasMafia: true }, killed: [], anyNight: true } });
    assert.notEqual(r.kind, 'afterLynchMafia');
  }
});

test('yozish uslubi: kalit o\'zgarmaydi, faqat matn', () => {
  assert.equal(styleLine('men tinchman', { style: 0 }, () => 0.01), 'men tinchman');
  const s1 = styleLine('men tinchman', { style: 1 }, () => 0.01);
  assert.ok(/^men tinchman\)+$/.test(s1), s1);
  const s2 = styleLine('men tinchman', { style: 2 }, () => 0.01);
  assert.equal(s2, 'men tinchman...');
  // Uslub HAR DOIM emas — aks holda u ham naqsh bo'lardi
  assert.equal(styleLine('men tinchman', { style: 1 }, () => 0.9), 'men tinchman');
});

test('har ibora turida yetarli xilma-xillik bor', () => {
  for (const k of LINE_KINDS) {
    const keys = new Set();
    for (let i = 0; i < 400; i++) { const l = botChatLine(k, { n: 'Aziz' }); if (l) keys.add(l.key); }
    assert.ok(keys.size >= 6, k + ': faqat ' + keys.size + ' ta ibora');
    for (const key of keys) {
      assert.equal(key[0], key[0].toLowerCase(), 'bosh harf: ' + key);
      assert.ok(!/[.!?]$/.test(key), 'tinish belgisi bilan tugadi: ' + key);
    }
  }
});

test('nechta bot gapiradi: kamida 2, ko\'pi bilan 7', () => {
  const bots = (n) => Array.from({ length: n }, (_, i) => ({ persona: makePersona('sp' + i) }));
  for (let i = 0; i < 100; i++) {
    const a = pickSpeakers(bots(12));
    assert.ok(a.length >= 2 && a.length <= 7, 'soni: ' + a.length);
    assert.equal(pickSpeakers(bots(1)).length, 1);
    assert.equal(pickSpeakers([]).length, 0);
  }
  // Gapdon bot ko'proq tanlanadi
  const quiet = { persona: { chatty: 0.3 } }, loud = { persona: { chatty: 1 } };
  let q = 0, l = 0;
  for (let i = 0; i < 2000; i++) {
    const r = pickSpeakers([quiet, loud, { persona: { chatty: 0.6 } }, { persona: { chatty: 0.6 } }]);
    if (r.includes(quiet)) q++; if (r.includes(loud)) l++;
  }
  assert.ok(l > q * 1.3, 'gapdon bot kamgap botdan ko\'p tanlanmadi: ' + l + ' vs ' + q);
});

test('xarakter: chatty va style chegarada, faollik oshdi', () => {
  for (let i = 0; i < 200; i++) {
    const p = makePersona('x' + i);
    assert.ok(p.chatty >= 0.3 && p.chatty <= 1, 'chatty: ' + p.chatty);
    assert.ok([0, 1, 2].includes(p.style), 'style: ' + p.style);
    assert.ok(p.activity >= 0.9, 'activity: ' + p.activity);
  }
});


// ==================== OQLASH (clear) — 2026-09-18 auditi ====================
// "tekshirdim 3 tinch" — bu AYBLOV emas, komissarning oqlashi. Ilgari 'claim'
// deb tasniflanib tarixga ayblov bo'lib tushar va botlar aynan oqlangan odamga
// shubha qilardi.

test("komissarning 'tinch/oq' gapi oqlash deb tasniflanadi", () => {
  for (const t of ['tekshirdim 3 tinch', 'men kom man 3 oq chiqdi', 'komissarman Aziz toza', 'проверил 4 мирный', 'checked Aziz innocent']) {
    assert.equal(classifyChat(t), 'clear', t);
  }
  for (const t of ['men komissarman 3 mafiya', 'tekshirdim Aziz qora', 'комиссар: 5 мафия', 'I am the cop, 3 is mafia']) {
    assert.equal(classifyChat(t), 'claim', t);
  }
});

test('oqlashga bot himoyalanmaydi va ayblov iborasi ishlatmaydi', () => {
  const alive = [{ socketId: 'a' }, { socketId: 'b' }, { socketId: 'h' }];
  for (let i = 0; i < 300; i++) {
    // meni oqladi
    const r1 = chooseReaction({ kind: 'clear', targets: ['a'], authorSid: 'h', me: { socketId: 'a', role: 'civil' },
      mates: [], iAmMafia: false, alive, suspicion: {}, persona: makePersona('a'), phase: 'day_discussion' });
    assert.ok(!r1 || ['askClaim', 'doubtClaim'].includes(r1.kind), JSON.stringify(r1));
    if (r1) assert.equal(r1.targetSid, null, 'oqlashda nomli ibora (ayblov) chiqdi');
    // mafiya bot: sherigi oqlandi — indamaydi yoki shubha bildiradi, hech qachon qo'shilmaydi
    const r2 = chooseReaction({ kind: 'clear', targets: ['b'], authorSid: 'h', me: { socketId: 'a', role: 'mafia' },
      mates: ['a', 'b'], iAmMafia: true, alive, suspicion: {}, persona: makePersona('a'), phase: 'day_discussion' });
    assert.ok(!r2 || ['askClaim', 'doubtClaim'].includes(r2.kind), JSON.stringify(r2));
  }
});


// ==================== KUTISH XONASI: shoshilmang, yana odam keladi ====================
// Foydalanuvchi talabi: "bosmay turing / yana bir kishi bor" desa o'yin
// boshlanmasin — 10-15 s kutib xona egasi so'rasin. Eng nozik joyi:
// "boshlamay turing" ichida "boshla" bor va u ilgari START deb tushunilardi.

test("kutish so'zlari tanilib, START so'zlari bilan aralashmaydi", () => {
  const kut = ['shoshilmang', 'Shoshmang!', 'bosmay turing', 'bosmay turila', 'bosmang', 'bosmaylik',
    'boshlamay turila', 'boshlamay turinglar', 'boshlamang', 'boshlamela', 'kutib turing', 'kuting',
    'kutila', 'yana odam bor', 'yana bir kishi bor', 'yana 2 kishi keladi', 'dostim kiradi',
    "do'stim kelyapti", 'ukam kiradi', 'hozir keladi', 'chaqirdim', "to'xtang", 'toxtab turing',
    '1 minut', 'bir daqiqa', 'sal kuting', 'biroz turing', 'hali erta', 'wait', 'подожди', 'не начинайте',
    'ещё один человек', 'yana bitta odam kiradi', 'kutamiz'];
  for (const t of kut) assert.equal(isWaitAsk(t), true, 'kutish deb tanilmadi: ' + t);
  const bosh = ['boshlaymiz', 'boshla', 'goo', 'bosdim', 'bosing', 'ketdik', 'salom', 'kim mafiya',
    'kutmaymiz', 'boshlang endi', 'start', 'davay', 'men tayyor'];
  for (const t of bosh) assert.equal(isWaitAsk(t), false, 'START gapi kutish deb tanildi: ' + t);
});

test("egasi so'raganidan keyingi javoblar: ha/yo'q", () => {
  const ha = ['xa kiradi', 'kradi', 'kiradi hoz', 'hoz', 'hozir', 'ha', 'xa', 'ok', 'keladi', 'kelyapti',
    'chaqirdim', 'yozdim unga', 'kut', 'сейчас зайдёт', 'yes coming', 'bir daqiqa', 'bosmay turing'];
  for (const t of ha) assert.equal(isWaitYes(t), true, "'ha' deb tanilmadi: " + t);
  const yoq = ["yo'q", 'yoq', 'kelmaydi', 'kirmadi', 'нет', 'no', 'boshla', 'bosing'];
  for (const t of yoq) assert.equal(isWaitNo(t), true, "'yo'q' deb tanilmadi: " + t);
  for (const t of ['xa kiradi', 'kiradi', 'salom', 'hozir']) assert.equal(isWaitNo(t), false, "'ha' gapi 'yo'q' bo'ldi: " + t);
});

test('kutish iboralari mavjud va nomsiz', () => {
  for (const k of ['waitAck', 'waitAsk', 'waitStart']) {
    const keys = new Set();
    for (let i = 0; i < 300; i++) { const l = botChatLine(k, {}); if (l) keys.add(l.key); }
    assert.ok(keys.size >= 6, k + ': ' + keys.size);
    for (const key of keys) assert.ok(!key.includes('{n}'), k + ' nom talab qiladi: ' + key);
  }
});

// O'yin qoidalari testlari: node --test rules.test.mjs
// Maqsad — ROLES.md dagi qoidalar kodda aynan bajarilishini kafolatlash va
// o'yinni muzlatib qo'yadigan holatlarni (deadlock) qaytib kirib qolishidan saqlash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sideOf, checkWin, isWinner,
  buildRoleList, normalizeRoleConfig, fitRolesToCount, assignRoles,
  NIGHT_STEPS, nightStepByPhase, stepHasActor, nightStepComplete,
  SELECTABLE_ROLES, UNIQUE_ROLES, MAFIA_VOTERS,
} from './rules.js';

// qisqa yordamchi: rollar ro'yxatidan o'yin holati yasaydi
const G = (roles, opts = {}) => ({
  players: roles.map((r, i) => ({
    socketId: 's' + i,
    username: 'p' + i,
    role: typeof r === 'string' ? r : r.role,
    isAlive: typeof r === 'string' ? true : r.isAlive !== false,
    connected: typeof r === 'string' ? true : r.connected !== false,
  })),
  ...opts,
});

// ==================== TOMONLAR ====================

test('sideOf: har bir rol to\'g\'ri tomonga tegishli', () => {
  for (const r of ['civil', 'escort', 'sergeant', 'komissar', 'doctor', 'daydi', 'afsungar']) {
    assert.equal(sideOf(r), 'town', r);
  }
  for (const r of ['don', 'mafia', 'advokat']) assert.equal(sideOf(r), 'mafia', r);
  assert.equal(sideOf('qotil'), 'killer');
  assert.equal(sideOf('bori'), 'wolf');
  assert.equal(sideOf('nomalum'), 'town'); // xavfsiz zaxira
});

// ==================== G'ALABA SHARTLARI ====================

test('checkWin: shahar barcha mafiyani yo\'q qilsa yutadi', () => {
  assert.equal(checkWin(G(['civil', 'komissar', 'doctor'])), 'town');
});

test('checkWin: mafiya soni qolganlarga tenglashsa yutadi', () => {
  assert.equal(checkWin(G(['don', 'civil'])), 'mafia');            // 1 vs 1
  assert.equal(checkWin(G(['don', 'mafia', 'civil'])), 'mafia');   // 2 vs 1
  assert.equal(checkWin(G(['don', 'civil', 'civil'])), null);      // 1 vs 2 — davom etadi
});

test('checkWin: Advokat ham mafiya sifatida sanaladi', () => {
  assert.equal(checkWin(G(['advokat', 'civil'])), 'mafia');
});

test('checkWin: Qotil faqat yakkama-yakka qolganda yutadi', () => {
  assert.equal(checkWin(G(['qotil'])), 'killer');
  assert.equal(checkWin(G(['qotil', 'civil'])), null);   // hali tugamaydi
  assert.equal(checkWin(G(['qotil', 'don'])), null);     // qotil tirik — hech kim yutmaydi
});

test('checkWin: qotil tirik ekan mafiya g\'alaba qila olmaydi', () => {
  assert.equal(checkWin(G(['don', 'mafia', 'qotil'])), null);
});

// --- DEADLOCK himoyasi: bu holatlar ilgari o'yinni abadiy muzlatib qo'yardi ---

test('checkWin: faqat Bo\'ri qolsa — bo\'ri yutadi (ilgari null qaytarib o\'yin muzlardi)', () => {
  assert.equal(checkWin(G(['bori'])), 'wolf');
  assert.equal(checkWin(G(['bori', 'bori'])), 'wolf');
});

test('checkWin: hech kim qolmasa — durang (ilgari null edi)', () => {
  assert.equal(checkWin(G([])), 'draw');
  assert.equal(checkWin(G([{ role: 'civil', isAlive: false }])), 'draw');
});

test('checkWin: tirik Bo\'ri shahar g\'alabasiga to\'sqinlik qilmaydi', () => {
  // ilgari 1 tinch aholi + 1 bo'ri holatida o'yin cheksiz aylanardi
  assert.equal(checkWin(G(['civil', 'bori'])), 'town');
  assert.equal(checkWin(G(['civil', 'civil', 'bori'])), 'town');
});

test('checkWin: har qanday tirik tarkib uchun hech qachon cheksiz qolmaydi', () => {
  // 1..4 o'yinchili barcha kombinatsiyalar: o'yin yo tugaydi, yo mantiqan davom etadi
  const roles = ['civil', 'don', 'qotil', 'bori', 'komissar', 'advokat'];
  let checked = 0;
  const walk = (cur, depth) => {
    if (cur.length) {
      const r = checkWin(G(cur));
      assert.ok(r === null || ['town', 'mafia', 'killer', 'wolf', 'draw'].includes(r),
        `kutilmagan natija: ${r} (${cur.join(',')})`);
      // town yoki mafia bo'lmasa ham, qotil/bo'ri holatlari aniq yakunlanishi kerak
      const alive = cur.length;
      const killers = cur.filter(x => sideOf(x) === 'killer').length;
      const wolves = cur.filter(x => sideOf(x) === 'wolf').length;
      if (killers === alive) assert.equal(r, 'killer', cur.join(','));
      if (wolves === alive) assert.equal(r, 'wolf', cur.join(','));
      checked++;
    }
    if (depth === 0) return;
    for (const r of roles) walk([...cur, r], depth - 1);
  };
  walk([], 4);
  assert.ok(checked > 1000, 'yetarlicha kombinatsiya tekshirildi');
});

// ==================== KIM G'OLIB ====================

test('isWinner: tomon bo\'yicha to\'g\'ri hisoblanadi', () => {
  assert.equal(isWinner('don', 'mafia', true), true);
  assert.equal(isWinner('advokat', 'mafia', false), true);   // o'lgan bo'lsa ham jamoa yutdi
  assert.equal(isWinner('civil', 'mafia', true), false);
  assert.equal(isWinner('komissar', 'town', false), true);
  assert.equal(isWinner('qotil', 'killer', true), true);
  assert.equal(isWinner('qotil', 'town', true), false);
});

test('isWinner: eski "civil" g\'olib kodi ham town deb qabul qilinadi', () => {
  assert.equal(isWinner('doctor', 'civil', true), true);
});

test('isWinner: Bo\'ri omon qolsa g\'olib, o\'lsa yo\'q', () => {
  assert.equal(isWinner('bori', 'town', true), true);
  assert.equal(isWinner('bori', 'town', false), false);
  assert.equal(isWinner('bori', 'mafia', true), true);
  assert.equal(isWinner('bori', 'wolf', false), true);  // bo'ri tomoni yutgan holat
});

test('isWinner: durangda hech kim yutmaydi', () => {
  for (const r of ['civil', 'don', 'qotil', 'bori']) assert.equal(isWinner(r, 'draw', true), false);
});

// ==================== ROL BALANSI ====================

test('buildRoleList: har bir o\'yinchiga aynan bitta rol beradi', () => {
  for (let n = 3; n <= 20; n++) {
    const list = buildRoleList(n);
    assert.equal(list.length, n, `n=${n}`);
    assert.ok(list.every(r => typeof r === 'string' && r.length));
  }
});

test('buildRoleList: mafiya har doim ozchilik', () => {
  for (let n = 3; n <= 20; n++) {
    const list = buildRoleList(n);
    const mafia = list.filter(r => sideOf(r) === 'mafia').length;
    assert.ok(mafia >= 1, `n=${n}: kamida bitta mafiya kerak`);
    assert.ok(mafia * 2 < n || n <= 3, `n=${n}: mafiya ${mafia} — ozchilik emas`);
  }
});

test('buildRoleList: noyob rollar takrorlanmaydi', () => {
  for (let n = 3; n <= 20; n++) {
    const list = buildRoleList(n);
    for (const r of UNIQUE_ROLES) {
      assert.ok(list.filter(x => x === r).length <= 1, `n=${n}: ${r} takrorlandi`);
    }
  }
});

test('buildRoleList: Serjant faqat Komissar bilan birga chiqadi', () => {
  for (let n = 3; n <= 20; n++) {
    const list = buildRoleList(n);
    if (list.includes('sergeant')) assert.ok(list.includes('komissar'), `n=${n}`);
  }
});

// ==================== QO'LDA ROL TANLASH ====================

test('normalizeRoleConfig: mafiyasiz konfiguratsiya rad etiladi', () => {
  assert.equal(normalizeRoleConfig({ komissar: 1, doctor: 1 }, 8), null);
});

test('normalizeRoleConfig: mafiya ko\'pchilik bo\'lsa rad etiladi', () => {
  assert.equal(normalizeRoleConfig({ don: 1, mafia: 4 }, 10), null);  // 5/10 — darhol g'alaba
  assert.equal(normalizeRoleConfig({ don: 1, mafia: 5 }, 10), null);
  assert.ok(normalizeRoleConfig({ don: 1, mafia: 3 }, 10));           // 4/10 — maqbul
});

test('normalizeRoleConfig: noyob rol ikki marta so\'ralsa bittaga tushiriladi', () => {
  const cfg = normalizeRoleConfig({ komissar: 3, don: 1 }, 8);
  assert.equal(cfg.komissar, 1);
});

test('normalizeRoleConfig: Serjant Komissarsiz rad etiladi', () => {
  assert.equal(normalizeRoleConfig({ sergeant: 1, don: 1 }, 8), null);
  assert.ok(normalizeRoleConfig({ sergeant: 1, komissar: 1, don: 1 }, 8));
});

test('normalizeRoleConfig: qolgan o\'rinlar tinch aholi bilan to\'ladi', () => {
  const cfg = normalizeRoleConfig({ komissar: 1, doctor: 1, don: 1 }, 8);
  assert.equal(cfg.civil, 5);
  const sum = Object.values(cfg).reduce((a, c) => a + c, 0);
  assert.equal(sum, 8);
});

test('normalizeRoleConfig: jami o\'yinchidan oshsa rad etiladi', () => {
  assert.equal(normalizeRoleConfig({ komissar: 1, doctor: 1, escort: 1, daydi: 1, don: 1, mafia: 1 }, 4), null);
});

// ==================== ROLLARNI HAQIQIY SONGA MOSLASH ====================

test('fitRolesToCount: xona hajmiga tuzilgan rollar kam o\'yinchiga moslanadi', () => {
  // 12 kishiga mo'ljallangan tarkib, lekin 6 kishi o'ynayapti
  const specials = ['komissar', 'sergeant', 'doctor', 'escort', 'daydi', 'afsungar', 'don', 'mafia', 'advokat', 'qotil', 'bori'];
  const fitted = fitRolesToCount(specials, 6);
  assert.ok(fitted.length <= 6, 'sig\'imdan oshmaydi');
  const mafia = fitted.filter(r => sideOf(r) === 'mafia').length;
  assert.ok(mafia >= 1, 'kamida bitta mafiya qoladi');
  assert.ok(mafia * 2 < 6, `mafiya ozchilik bo'lishi kerak, ${mafia} chiqdi`);
});

test('fitRolesToCount: mafiya ko\'pchilik bo\'lib qolsa kesiladi', () => {
  const fitted = fitRolesToCount(['don', 'mafia', 'mafia', 'advokat'], 4);
  const mafia = fitted.filter(r => sideOf(r) === 'mafia').length;
  assert.ok(mafia * 2 < 4, `mafiya ${mafia}/4 — ozchilik emas`);
});

test('fitRolesToCount: mafiya butunlay yo\'qolib qolmaydi', () => {
  const fitted = fitRolesToCount(['komissar', 'doctor'], 4);
  assert.ok(fitted.some(r => sideOf(r) === 'mafia'), 'kamida bitta mafiya qo\'shilishi kerak');
});

test('fitRolesToCount: Serjant Komissarsiz qolmaydi', () => {
  const fitted = fitRolesToCount(['sergeant', 'don', 'civil'], 3);
  if (fitted.includes('sergeant')) assert.ok(fitted.includes('komissar'));
});

// ==================== ROL TARQATISH ====================

test('assignRoles: har bir o\'yinchi rol oladi', () => {
  const players = Array.from({ length: 9 }, (_, i) => ({ socketId: 's' + i, username: 'p' + i }));
  const res = assignRoles(players, null);
  assert.equal(res.length, 9);
  assert.ok(res.every(p => typeof p.role === 'string' && p.role.length));
});

test('assignRoles: host tarkibi kam o\'yinchida ham balansni buzmaydi', () => {
  const cfg = { komissar: 1, doctor: 1, sergeant: 1, escort: 1, don: 1, mafia: 2, advokat: 1, qotil: 1, civil: 3 };
  const players = Array.from({ length: 5 }, (_, i) => ({ socketId: 's' + i, username: 'p' + i }));
  const res = assignRoles(players, cfg);
  assert.equal(res.length, 5);
  const mafia = res.filter(p => sideOf(p.role) === 'mafia').length;
  assert.ok(mafia >= 1 && mafia * 2 < 5, `mafiya ${mafia}/5`);
});

test('assignRoles: konfiguratsiyasiz avto balans ishlaydi', () => {
  for (let n = 3; n <= 20; n++) {
    const players = Array.from({ length: n }, (_, i) => ({ socketId: 's' + i, username: 'p' + i }));
    const res = assignRoles(players, null);
    const mafia = res.filter(p => sideOf(p.role) === 'mafia').length;
    assert.ok(mafia >= 1, `n=${n}`);
    // o'yin darhol tugab qolmasligi kerak
    assert.equal(checkWin({ players: res.map(p => ({ ...p, isAlive: true })) }), n <= 2 ? 'mafia' : null, `n=${n}`);
  }
});

// ==================== TUNGI BOSQICHLAR ====================

test('NIGHT_STEPS: har bosqichning rollari SELECTABLE ro\'yxatida bor', () => {
  for (const s of NIGHT_STEPS) {
    assert.ok(Array.isArray(s.roles) && s.roles.length, s.phase);
    for (const r of s.roles) assert.ok(SELECTABLE_ROLES.includes(r), `${s.phase}: ${r}`);
  }
});

test('NIGHT_STEPS: mafiya bosqichi MAFIA_VOTERS bilan bir xil', () => {
  const step = nightStepByPhase('night_mafia');
  assert.deepEqual([...step.roles].sort(), [...MAFIA_VOTERS].sort());
});

test('stepHasActor: faqat tirik rol egasi hisoblanadi', () => {
  const step = nightStepByPhase('night_doctor');
  assert.equal(stepHasActor(G(['doctor', 'civil']), step), true);
  assert.equal(stepHasActor(G([{ role: 'doctor', isAlive: false }, 'civil']), step), false);
  assert.equal(stepHasActor(G(['civil']), step), false);
});

test('nightStepComplete: mafiya hammasi tanlagach bosqich tugaydi', () => {
  const step = nightStepByPhase('night_mafia');
  const g = G(['don', 'mafia', 'civil']);
  g.nightActions = { mafiaVotes: {} };
  assert.equal(nightStepComplete(g, step), false);
  g.nightActions.mafiaVotes = { s0: 's2' };
  assert.equal(nightStepComplete(g, step), false, 'ikkinchi mafiya hali tanlamadi');
  g.nightActions.mafiaVotes = { s0: 's2', s1: 's2' };
  assert.equal(nightStepComplete(g, step), true);
});

test('nightStepComplete: Advokat mafiya ovoziga to\'sqinlik qilmaydi', () => {
  // ilgari advokat ham hisoblanib, bosqich hech qachon erta yopilmasdi
  const step = nightStepByPhase('night_mafia');
  const g = G(['don', 'advokat', 'civil']);
  g.nightActions = { mafiaVotes: { s0: 's2' } };
  assert.equal(nightStepComplete(g, step), true);
});

test('nightStepComplete: uzilib qolgan mafiya kutilmaydi', () => {
  const step = nightStepByPhase('night_mafia');
  const g = G(['don', { role: 'mafia', connected: false }, 'civil']);
  g.nightActions = { mafiaVotes: { s0: 's2' } };
  assert.equal(nightStepComplete(g, step), true);
});

test('nightStepComplete: mafiya umuman qolmasa bosqich darhol tugaydi', () => {
  const step = nightStepByPhase('night_mafia');
  const g = G(['civil', 'komissar']);
  g.nightActions = {};
  assert.equal(nightStepComplete(g, step), true);
});

test('nightStepComplete: bitta rolli bosqichlar harakatdan keyin tugaydi', () => {
  const cases = [
    ['night_komissar', 'komissar'],
    ['night_doctor', 'doctor'],
    ['night_escort', 'escort'],
    ['night_advokat', 'lawyer'],
    ['night_qotil', 'killer'],
    ['night_daydi', 'daydi'],
  ];
  for (const [phase, key] of cases) {
    const step = nightStepByPhase(phase);
    const g = G(['civil']);
    g.nightActions = {};
    assert.equal(nightStepComplete(g, step), false, phase);
    g.nightActions[key] = { by: 's0', target: 's0' };
    assert.equal(nightStepComplete(g, step), true, phase);
  }
});

// ==================== STATISTIK / FUZZ TESTLAR ====================
// assignRoles tasodifiy aralashtiradi — bir marta o'tgani yetarli emas,
// shuning uchun ko'p marta takrorlab invariantlarni tekshiramiz.

test('assignRoles: 500 tarqatishda ham invariantlar buzilmaydi', () => {
  for (let iter = 0; iter < 500; iter++) {
    const n = 3 + (iter % 18);                      // 3..20
    const players = Array.from({ length: n }, (_, i) => ({ socketId: 's' + i, username: 'p' + i }));
    const res = assignRoles(players, null);

    assert.equal(res.length, n, `n=${n}: har o'yinchiga rol`);
    const mafia = res.filter(p => sideOf(p.role) === 'mafia').length;
    assert.ok(mafia >= 1, `n=${n}: mafiyasiz o'yin bo'lmaydi`);
    // noyob rollar takrorlanmaydi
    for (const r of UNIQUE_ROLES) {
      assert.ok(res.filter(p => p.role === r).length <= 1, `n=${n}: ${r} takrorlandi`);
    }
    // serjant komissarsiz qolmaydi
    if (res.some(p => p.role === 'sergeant')) {
      assert.ok(res.some(p => p.role === 'komissar'), `n=${n}: serjant komissarsiz`);
    }
    // o'yin darhol tugab qolmasligi kerak (n >= 4 uchun)
    if (n >= 4) {
      const w = checkWin({ players: res.map(p => ({ ...p, isAlive: true })) });
      assert.equal(w, null, `n=${n}: o'yin boshlanishidayoq tugadi (${w})`);
    }
  }
});

test('fitRolesToCount: tasodifiy tarkiblar uchun invariantlar', () => {
  const pool = [...SELECTABLE_ROLES, 'mafia', 'mafia', 'civil'];
  // deterministik "tasodifiy": indeks bo'yicha aylanma tanlov
  for (let iter = 0; iter < 400; iter++) {
    const n = 3 + (iter % 18);
    const size = 1 + ((iter * 7) % 14);
    const specials = Array.from({ length: size }, (_, i) => pool[(iter * 3 + i * 5) % pool.length])
      .filter(r => r !== 'civil');
    if (!specials.length) continue;
    const fitted = fitRolesToCount(specials, n);

    assert.ok(fitted.length <= n, `n=${n}: sig'imdan oshdi (${fitted.length})`);
    const mafia = fitted.filter(r => sideOf(r) === 'mafia').length;
    assert.ok(mafia >= 1, `n=${n}: mafiya yo'qoldi`);
    assert.ok(mafia * 2 < n || n <= 2, `n=${n}: mafiya ko'pchilik (${mafia})`);
    if (fitted.includes('sergeant')) assert.ok(fitted.includes('komissar'), `n=${n}: serjant komissarsiz`);
  }
});

test('checkWin: o\'yin simulyatsiyasi hech qachon cheksiz aylanmaydi', () => {
  // Har raundda bitta tasodifiy o'yinchi o'ladi — o'yin ALBATTA yakunlanishi kerak
  for (let iter = 0; iter < 200; iter++) {
    const n = 4 + (iter % 12);
    const players = Array.from({ length: n }, (_, i) => ({ socketId: 's' + i, username: 'p' + i }));
    const g = { players: assignRoles(players, null).map(p => ({ ...p, isAlive: true })) };
    let guard = 0;
    while (checkWin(g) === null) {
      const alive = g.players.filter(p => p.isAlive);
      assert.ok(alive.length > 0, 'tirik yo\'q, lekin checkWin null qaytardi');
      alive[(iter + guard) % alive.length].isAlive = false;
      if (++guard > n + 2) assert.fail(`n=${n}: o'yin ${guard} qadamda ham tugamadi (deadlock)`);
    }
  }
});

test('nightStepComplete: har bir bosqich oxir-oqibat yakunlanadi', () => {
  // Rol egasi harakat qilsa bosqich ALBATTA tugashi kerak — aks holda tun muzlaydi
  const keyByPhase = {
    night_komissar: 'komissar', night_doctor: 'doctor', night_escort: 'escort',
    night_advokat: 'lawyer', night_qotil: 'killer', night_daydi: 'daydi',
  };
  for (const step of NIGHT_STEPS) {
    const g = G(step.roles.map(r => ({ role: r })).concat(['civil']));
    g.nightActions = {};
    if (step.phase === 'night_mafia') {
      const votes = {};
      g.players.filter(p => MAFIA_VOTERS.includes(p.role)).forEach((p, i) => { votes[p.socketId] = 's' + (g.players.length - 1); });
      g.nightActions.mafiaVotes = votes;
    } else {
      g.nightActions[keyByPhase[step.phase]] = { by: 's0', target: 's0' };
    }
    assert.equal(nightStepComplete(g, step), true, step.phase + ' yakunlanmadi');
  }
});

// ==================== MAFIYA NISHONINI TANLASH ====================
// Bu mantiq eng xatoga moyil joy: kelishuv, Don qarori, ko'pchilik, blok, uzilish.

import { chooseMafiaTarget } from './rules.js';

const P = (list) => list.map((r, i) => ({
  socketId: 's' + i, username: 'p' + i,
  role: typeof r === 'string' ? r : r.role,
  isAlive: typeof r === 'string' ? true : r.isAlive !== false,
  connected: typeof r === 'string' ? true : r.connected !== false,
}));

test('chooseMafiaTarget: hamma bir xil tanlasa o\'sha nishon o\'ladi', () => {
  const players = P(['don', 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's2' });
  assert.equal(r.target, 's2');
  assert.equal(r.reason, null);           // kelishuv — qo'shimcha jurnal yozuvi yo'q
  assert.equal(r.by, 's0');               // Don javobgar
});

test('chooseMafiaTarget: kelishuv bo\'lmasa yakuniy qarorni Don qabul qiladi', () => {
  const players = P(['don', 'mafia', 'civil', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's3' });
  assert.equal(r.target, 's2', 'Don tanlagan nishon');
  assert.equal(r.reason, 'donDecided');
});

test('chooseMafiaTarget: Don yo\'q bo\'lsa ko\'pchilik ovozi hal qiladi', () => {
  const players = P(['mafia', 'mafia', 'mafia', 'civil', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's3', s1: 's3', s2: 's4' });
  assert.equal(r.target, 's3');
  assert.equal(r.reason, 'mafiaMajority');
});

test('chooseMafiaTarget: Donsiz ovozlar teng bo\'lsa hech kim o\'lmaydi', () => {
  const players = P(['mafia', 'mafia', 'civil', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's3' });
  assert.equal(r.target, null);
  assert.equal(r.reason, 'mafiaNoDeal');
});

test('chooseMafiaTarget: Kezuvchi bloklagan mafiya ovozga qatnashmaydi', () => {
  // Don bloklangan — qolgan yagona mafiya o'z nishonini oladi (kelishuv hisoblanadi)
  const players = P(['don', 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's2' }, new Set(['s0']));
  assert.equal(r.target, 's2');
  assert.equal(r.by, 's1', 'bloklangan Don javobgar bo\'lmaydi');
});

test('chooseMafiaTarget: uzilib qolgan Don hujumni to\'smaydi', () => {
  const players = P([{ role: 'don', connected: false }, 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, { s1: 's2' });
  assert.equal(r.target, 's2', 'AFK Don butun hujumni bloklamasligi kerak');
});

test('chooseMafiaTarget: hamma mafiya bloklansa hech kim o\'lmaydi', () => {
  const players = P(['don', 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's2' }, new Set(['s0', 's1']));
  assert.equal(r.target, null);
});

test('chooseMafiaTarget: mafiya o\'z sherigini nishonga ola olmaydi', () => {
  const players = P(['don', 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's1', s1: 's1' });
  assert.equal(r.target, null, 'mafiya sherigi nishon bo\'la olmaydi');
});

test('chooseMafiaTarget: Advokat ovoz bermaydi va bosqichni to\'smaydi', () => {
  const players = P(['don', 'advokat', 'civil']);
  const r = chooseMafiaTarget(players, { s0: 's2' });
  assert.equal(r.target, 's2', 'Advokat ovozi kutilmasligi kerak');
});

test('chooseMafiaTarget: tirik mafiya qolmasa natija bo\'sh', () => {
  const players = P([{ role: 'don', isAlive: false }, 'civil', 'komissar']);
  const r = chooseMafiaTarget(players, { s0: 's1' });
  assert.equal(r.target, null);
  assert.equal(r.reason, null);
});

test('chooseMafiaTarget: o\'lik nishon tanlansa hujum bekor bo\'ladi', () => {
  const players = P(['don', 'mafia', { role: 'civil', isAlive: false }]);
  const r = chooseMafiaTarget(players, { s0: 's2', s1: 's2' });
  assert.equal(r.target, null);
});

test('chooseMafiaTarget: hech kim ovoz bermasa jurnalga ham yozilmaydi', () => {
  const players = P(['don', 'mafia', 'civil']);
  const r = chooseMafiaTarget(players, {});
  assert.equal(r.target, null);
  assert.equal(r.reason, null, 'ovoz umuman bo\'lmasa "kelisha olmadi" deb yozilmasin');
});

// ==================== TUNGI O'LIMLARNI HAL QILISH ====================
// ROLES.md dagi himoya tartibi: Komissar o'qi to'xtatib bo'lmaydi; qolganlarda
// qalqon → doktor → qo'shimcha jon; Bo'ri qayta tug'iladi; Afsungar qasos oladi.

import { resolveNightDeaths } from './rules.js';

const PL = (list) => list.map((r, i) => {
  const o = typeof r === 'string' ? { role: r } : { ...r };
  return {
    socketId: 's' + i, username: 'p' + i, userId: 'u' + i,
    role: o.role, isAlive: o.isAlive !== false,
    shieldActive: o.shield === true,
    items: { shield: 0, lupa: 0, life: o.life || 0 },
  };
});
const types = (res) => res.events.map(e => e.type);

test('resolveNightDeaths: oddiy o\'lim', () => {
  const players = PL(['don', 'civil']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia', by: 's0' }]);
  assert.deepEqual(types(r), ['death']);
  assert.deepEqual(r.deadSids, ['s1']);
  assert.equal(r.killed[0].role, 'civil');
});

test('resolveNightDeaths: qalqon mafiya o\'qini to\'xtatadi', () => {
  const players = PL(['don', { role: 'civil', shield: true }]);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia' }]);
  assert.deepEqual(types(r), ['shield']);
  assert.deepEqual(r.deadSids, []);
});

test('resolveNightDeaths: doktor qutqaradi', () => {
  const players = PL(['don', 'civil']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia' }], { healTarget: 's1' });
  assert.deepEqual(types(r), ['heal']);
});

test('resolveNightDeaths: qo\'shimcha jon sarflanadi', () => {
  const players = PL(['don', { role: 'civil', life: 1 }]);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia' }]);
  assert.deepEqual(types(r), ['life']);
  assert.deepEqual(r.lifeUsed, ['s1']);
});

test('resolveNightDeaths: Komissar o\'qini hech narsa to\'xtata olmaydi', () => {
  const players = PL(['komissar', { role: 'civil', shield: true, life: 3 }]);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'komissar', by: 's0' }], { healTarget: 's1' });
  assert.deepEqual(types(r), ['death'], 'qalqon/doktor/jon Komissar o\'qiga ta\'sir qilmaydi');
  assert.deepEqual(r.lifeUsed, [], 'jon behuda sarflanmasin');
});

test('resolveNightDeaths: ikki hujumda himoya BIR MARTA sarflanadi', () => {
  // Mafiya + Qotil bir odamga — qalqon bittasini to'xtatadi, ikkinchisi ham o'tmaydi
  const players = PL(['don', 'qotil', { role: 'civil', shield: true }]);
  const r = resolveNightDeaths(players, [
    { sid: 's2', cause: 'mafia' },
    { sid: 's2', cause: 'killer' },
  ]);
  assert.deepEqual(types(r), ['shield'], 'ikkinchi hujum qayta ishlanmasligi kerak');
  assert.deepEqual(r.deadSids, []);
});

test('resolveNightDeaths: Komissar o\'qi boshqa hujum qalqonni yeb qo\'ymasin', () => {
  // Mafiya ham, Komissar ham bir odamga: Komissar BIRINCHI hisoblanadi va o'ldiradi
  const players = PL(['don', 'komissar', { role: 'civil', shield: true }]);
  const r = resolveNightDeaths(players, [
    { sid: 's2', cause: 'mafia' },
    { sid: 's2', cause: 'komissar', by: 's1' },
  ]);
  assert.deepEqual(types(r), ['death']);
  assert.equal(r.killed[0].cause, 'komissar');
});

test('resolveNightDeaths: Bo\'ri mafiya o\'qidan Mafiyaga aylanadi', () => {
  const players = PL(['don', 'bori']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia' }]);
  assert.deepEqual(types(r), ['reborn']);
  assert.deepEqual(r.roleChanges, [{ sid: 's1', role: 'mafia' }]);
  assert.deepEqual(r.deadSids, []);
});

test('resolveNightDeaths: Bo\'ri Komissar o\'qidan Serjantga aylanadi', () => {
  const players = PL(['komissar', 'bori']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'komissar', by: 's0' }]);
  assert.deepEqual(r.roleChanges, [{ sid: 's1', role: 'sergeant' }]);
});

test('resolveNightDeaths: Serjant allaqachon bor bo\'lsa Bo\'ri Tinch aholi bo\'ladi', () => {
  // aks holda xonada IKKITA Serjant paydo bo'lib, noyob rol invarianti buzilardi
  const players = PL(['komissar', 'sergeant', 'bori']);
  const r = resolveNightDeaths(players, [{ sid: 's2', cause: 'komissar', by: 's0' }]);
  assert.deepEqual(r.roleChanges, [{ sid: 's2', role: 'civil' }]);
});

test('resolveNightDeaths: Bo\'ri Qotil o\'qidan o\'ladi (qayta tug\'ilmaydi)', () => {
  const players = PL(['qotil', 'bori']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'killer', by: 's0' }]);
  assert.deepEqual(types(r), ['death']);
});

test('resolveNightDeaths: Afsungar o\'ldirganni o\'zi bilan olib ketadi', () => {
  const players = PL(['qotil', 'afsungar']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'killer', by: 's0' }]);
  assert.deepEqual(types(r), ['death', 'death']);
  assert.deepEqual([...r.deadSids].sort(), ['s0', 's1']);
  assert.equal(r.killed[1].cause, 'afsungar');
});

test('resolveNightDeaths: Afsungar qasosini qalqon to\'xtatadi', () => {
  const players = PL([{ role: 'qotil', shield: true }, 'afsungar']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'killer', by: 's0' }]);
  assert.deepEqual(types(r), ['death', 'shield']);
  assert.deepEqual(r.deadSids, ['s1'], 'qotil qalqon bilan omon qoladi');
});

test('resolveNightDeaths: Afsungar qasosini qo\'shimcha jon to\'xtatadi', () => {
  const players = PL([{ role: 'don', life: 1 }, 'afsungar']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'mafia', by: 's0' }]);
  assert.deepEqual(types(r), ['death', 'life']);
  assert.deepEqual(r.lifeUsed, ['s0']);
});

test('resolveNightDeaths: Afsungar qasosi Bo\'rini qayta tug\'dirmaydi', () => {
  // qasos sababi 'afsungar' — Bo'ri faqat mafiya/komissar o'qidan qayta tug'iladi
  const players = PL(['bori', 'afsungar']);
  const r = resolveNightDeaths(players, [{ sid: 's1', cause: 'killer', by: 's0' }]);
  assert.deepEqual(types(r), ['death', 'death']);
});

test('resolveNightDeaths: o\'lgan yoki yo\'q nishon e\'tiborsiz qoldiriladi', () => {
  const players = PL(['don', { role: 'civil', isAlive: false }]);
  const r = resolveNightDeaths(players, [
    { sid: 's1', cause: 'mafia' },
    { sid: 'yoq', cause: 'killer' },
  ]);
  assert.deepEqual(r.events, []);
});

test('resolveNightDeaths: hech qanday hujum bo\'lmasa natija bo\'sh', () => {
  const r = resolveNightDeaths(PL(['don', 'civil']), []);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.killed, []);
});

test('resolveNightDeaths: kirish massivlarini o\'zgartirmaydi (sof)', () => {
  const players = PL(['qotil', 'afsungar']);
  const deaths = [{ sid: 's1', cause: 'killer', by: 's0' }];
  const before = JSON.stringify(deaths);
  const snapshot = JSON.stringify(players);
  resolveNightDeaths(players, deaths);
  assert.equal(JSON.stringify(deaths), before, 'deaths massivi o\'zgarmasligi kerak');
  assert.equal(JSON.stringify(players), snapshot, 'players massivi o\'zgarmasligi kerak');
});

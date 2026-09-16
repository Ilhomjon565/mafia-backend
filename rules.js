// ==================== O'YIN QOIDALARI (sof mantiq) ====================
// Bu modul IO'siz: Redis, Prisma va socket'ga bog'liq emas — shu sababli
// to'g'ridan-to'g'ri test qilinadi (rules.test.mjs). Qoidalarning yagona manbasi
// shu yerda; server.js faqat ularni chaqiradi.

// ==================== ROLLAR (performance_arts) ====================
// taraf: town | mafia | killer | wolf
const ROLE_SIDE = {
  civil: 'town', escort: 'town', sergeant: 'town', komissar: 'town', doctor: 'town', daydi: 'town', afsungar: 'town',
  don: 'mafia', mafia: 'mafia', advokat: 'mafia',
  qotil: 'killer', bori: 'wolf',
  sheriff: 'town', // eski o'yinlar uchun
};
const ROLE_NAMES = {
  civil: '👨🏼 Tinch aholi', escort: '💃 Kezuvchi', sergeant: '👮🏻‍♂️ Serjant',
  komissar: '🕵🏻‍♂️ Komissar', doctor: '👨🏻‍⚕️ Doktor', daydi: '🧙‍♂️ Daydi', afsungar: '🧞‍♂️ Afsungar',
  don: '🤵🏻 Don', mafia: '🤵🏼 Mafiya', advokat: '👨‍💼 Advokat',
  qotil: '🔪 Qotil', bori: '🐺 Bo\'ri', sheriff: '🕵🏻‍♂️ Komissar',
};
function roleName(r) { return ROLE_NAMES[r] || r; }
function sideOf(r) { return ROLE_SIDE[r] || 'town'; }

// G'alaba shartlari. MUHIM: har bir holat yakunlanishi SHART — aks holda o'yin
// cheksiz aylanib qoladi (ilgari "faqat Bo'ri qoldi" va "hamma o'ldi" holatlari
// null qaytarib o'yinni muzlatib qo'yardi).
function checkWin(g) {
  const alive = g.players.filter(p => p.isAlive);
  const n = alive.length;
  const mafia  = alive.filter(p => sideOf(p.role) === 'mafia').length;
  const killer = alive.filter(p => sideOf(p.role) === 'killer').length;
  const wolf   = alive.filter(p => sideOf(p.role) === 'wolf').length;

  // Hech kim qolmadi (o'zaro qirg'in — masalan Afsungar qasosi) — durang
  if (n === 0) return 'draw';
  // 🔪 Qotil faqat yakkama-yakka qolsa g'olib
  if (killer > 0 && n === killer) return 'killer';
  // 🐺 Faqat bo'ri(lar) qoldi
  if (wolf > 0 && n === wolf) return 'wolf';
  // Qotil tirik ekan hech kim yakunlay olmaydi — u hammaga qarshi
  if (killer > 0) return null;
  // 🤵 Mafiya soni qolgan hammaga tenglashdi
  if (mafia > 0 && mafia >= n - mafia) return 'mafia';
  // 👨🏼 Shahar: mafiya ham, qotil ham qolmadi (tirik Bo'ri to'sqinlik qilmaydi —
  // u omon qolish roli, g'olib tomon bilan birga yutadi)
  if (mafia === 0) return 'town';
  return null;
}

// Shu o'yinchi g'olibmi? (recordStats va mijoz uchun yagona manba)
function isWinner(role, winner, isAlive) {
  const side = sideOf(role);
  if (!winner || winner === 'draw') return false;
  if (winner === 'wolf') return side === 'wolf';
  // 🐺 Bo'ri: hech kimning tomonida emas — oxirigacha omon qolsa g'olib
  if (side === 'wolf') return isAlive === true;
  if (winner === 'town' || winner === 'civil') return side === 'town';
  return side === winner;
}

// o'lim sababiga qarab kim o'ldirgani yorlig'i (tong e'lonida ko'rsatiladi)
const KILLER_LABEL = {
  mafia:    '🔫 Mafiya',
  killer:   '🔪 Qotil',
  komissar: '🕵🏻‍♂️ Komissar',
  afsungar: '🧞‍♂️ Afsungar',
};
function killerLabel(cause) { return KILLER_LABEL[cause] || 'Kimdir'; }

// O'yinchilar soniga qarab rollar to'plamini tuzadi (avto, balanslangan).
// Mafiya har doim ozchilik; maxsus rollar va betaraflar o'yin kattalashgani sayin qo'shiladi.
function buildRoleList(n) {
  const roles = [];
  roles.push('komissar');                 // shahar himoyachisi
  roles.push('don');                      // mafiya boshlig'i
  if (n >= 4) roles.push('doctor');
  // qo'shimcha mafiya (don bilan birga ~28%)
  const mafiaSide = Math.max(1, Math.round(n * 0.28));
  for (let i = 1; i < mafiaSide; i++) {
    if (i === mafiaSide - 1 && n >= 8) roles.push('advokat');
    else roles.push('mafia');
  }
  // shahar maxsus rollari (kattalik bo'yicha)
  if (n >= 6) roles.push('sergeant');
  if (n >= 7) roles.push('escort');
  if (n >= 9) roles.push('daydi');
  if (n >= 12) roles.push('afsungar');
  // betaraflar
  if (n >= 8) roles.push('qotil');
  if (n >= 11) roles.push('bori');
  // qolgan joylar — tinch aholi
  while (roles.length < n) roles.push('civil');
  // ortib ketsa kesib tashlaymiz (yuqoridagi tartib muhimroq rollarni saqlaydi)
  roles.length = n;
  return roles;
}

// host xona yaratganda qo'lda tanlay oladigan rollar (civil avtomatik to'ldiriladi)
const SELECTABLE_ROLES = ['komissar', 'sergeant', 'doctor', 'escort', 'daydi', 'afsungar', 'don', 'mafia', 'advokat', 'qotil', 'bori'];
// Xonada faqat BITTA bo'lishi mumkin bo'lgan rollar (ikkita Komissar yoki ikkita Don
// o'yin mantig'ini buzadi). Faqat oddiy 'mafia' va 'civil' ko'p bo'la oladi.
const UNIQUE_ROLES = ['komissar', 'sergeant', 'doctor', 'escort', 'daydi', 'afsungar', 'don', 'advokat', 'qotil', 'bori'];
// Tunda o'ldirish nishoniga OVOZ BERADIGAN mafiya rollari (Advokat kirmaydi —
// u alohida bosqichda himoya qiladi). NIGHT_STEPS[0].roles bilan mos bo'lishi shart.
const MAFIA_VOTERS = ['don', 'mafia'];

// { role: count } ni tekshirib normalizatsiya qiladi. Yaroqsiz bo'lsa null.
// Balans ham tekshiriladi: mafiya yarmiga yetsa o'yin birinchi kunning o'zida
// tugab qolardi (checkWin: mafia >= qolganlar).
function normalizeRoleConfig(roles, total) {
  if (!roles || typeof roles !== 'object') return null;
  const cfg = {}; let sum = 0;
  for (const r of SELECTABLE_ROLES) {
    // takrorlanmaydigan (noyob) rollar — har birida faqat bitta bo'lishi mumkin
    const cap = UNIQUE_ROLES.includes(r) ? 1 : total;
    const c = Math.max(0, Math.min(cap, parseInt(roles[r]) || 0));
    if (c > 0) { cfg[r] = c; sum += c; }
  }
  if (sum === 0 || sum > total) return null;
  const mafiaSide = SELECTABLE_ROLES.filter(r => sideOf(r) === 'mafia').reduce((a, r) => a + (cfg[r] || 0), 0);
  if (mafiaSide < 1) return null;            // kamida 1 mafiya bo'lishi shart
  if (mafiaSide * 2 >= total) return null;   // mafiya ozchilik bo'lishi shart
  // Serjant Komissarsiz ma'nosiz (u faqat Komissar natijasini oladi va o'rnini egallaydi)
  if (cfg.sergeant && !cfg.komissar) return null;
  cfg.civil = total - sum;                   // qolgani tinch aholi
  return cfg;
}

// Rol konfiguratsiyasi XONA HAJMIGA tuzilgan, lekin o'yin kamroq odam bilan
// boshlanishi mumkin. Shunda mafiya ulushi keskin oshib ketadi (12 kishiga mo'ljallangan
// 4 mafiya 6 kishilik o'yinda darhol g'alaba beradi) — shuning uchun rollarni
// haqiqiy o'yinchi soniga moslaymiz.
const ROLE_DROP_ORDER = ['bori', 'afsungar', 'daydi', 'qotil', 'advokat', 'escort', 'sergeant', 'mafia', 'doctor', 'don', 'komissar'];

function fitRolesToCount(specials, n) {
  let list = specials.slice();
  const mafiaCount = () => list.filter(r => sideOf(r) === 'mafia').length;
  // 1) umumiy sig'im: eng kam ahamiyatli rollardan kesamiz
  for (const drop of ROLE_DROP_ORDER) {
    while (list.length > n) {
      const i = list.lastIndexOf(drop);
      if (i < 0) break;
      list.splice(i, 1);
    }
    if (list.length <= n) break;
  }
  while (list.length > n) list.pop();
  // 2) mafiya ozchilik bo'lishi shart (mafia * 2 < n)
  for (const drop of ['advokat', 'mafia', 'don']) {
    while (mafiaCount() * 2 >= n && list.includes(drop)) {
      list.splice(list.lastIndexOf(drop), 1);
    }
  }
  if (!mafiaCount() && n >= 2) list.push('don');   // kamida bitta mafiya
  // 3) Serjant Komissarsiz ma'nosiz
  if (list.includes('sergeant') && !list.includes('komissar')) {
    list.splice(list.lastIndexOf('sergeant'), 1);
  }
  return list.slice(0, n);
}

function assignRoles(players, roleConfig) {
  const n = players.length;
  let roleList = null;
  // host qo'lda rol tanlagan bo'lsa — uni haqiqiy o'yinchi soniga moslab ishlatamiz
  if (roleConfig) {
    const specials = [];
    for (const [role, count] of Object.entries(roleConfig)) {
      if (role === 'civil') continue;
      for (let i = 0; i < count; i++) specials.push(role);
    }
    if (specials.length) {
      roleList = fitRolesToCount(specials, n);
      while (roleList.length < n) roleList.push('civil');
    }
  }
  // aks holda — o'yinchilar soniga qarab avto balans
  if (!roleList) roleList = buildRoleList(n);
  // aralashtirish
  for (let i = roleList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
  }
  return players.map((p, i) => ({ ...p, role: roleList[i] || 'civil', roleData: {} }));
}

// ==================== KETMA-KET TUNGI BOSQICHLAR ====================
// Tun navbat bilan o'tadi: avval mafiya kelishadi, keyin komissar, doktor va h.k.
// Har bosqichda faqat o'sha rol harakat qiladi, qolganlar kutadi.
// Rol o'yinda bo'lmasa — qisqa "...siz" o'tish ko'rsatiladi.
const NIGHT_STEPS = [
  { phase: 'night_mafia',    roles: ['don', 'mafia'], dur: 'night_mafia',    noun: 'Mafiya' },
  { phase: 'night_komissar', roles: ['komissar'],     dur: 'night_komissar', noun: 'Komissar' },
  { phase: 'night_doctor',   roles: ['doctor'],       dur: 'night_doctor',   noun: 'Doktor' },
  { phase: 'night_escort',   roles: ['escort'],       dur: 'night_escort',   noun: 'Kezuvchi' },
  { phase: 'night_advokat',  roles: ['advokat'],      dur: 'night_advokat',  noun: 'Advokat' },
  { phase: 'night_qotil',    roles: ['qotil'],        dur: 'night_qotil',    noun: 'Qotil' },
  { phase: 'night_daydi',    roles: ['daydi'],         dur: 'night_daydi',    noun: 'Daydi' },
];
function nightStepByPhase(phase) { return NIGHT_STEPS.find(s => s.phase === phase); }

// shu bosqich roli o'yinda (tirik) bormi?
function stepHasActor(g, step) {
  return g.players.some(p => p.isAlive && step.roles.includes(p.role));
}

// Bosqich tugadimi? (rol o'z amalini bajardimi)
// Mafiya uchun: ulangan barcha ovoz beruvchi TANLAGAN bo'lsa bosqich yopiladi —
// nishon bir xil bo'lishi SHART EMAS. Kelishuv bo'lmasa yakuniy qarorni
// chooseMafiaTarget() qabul qiladi (Don → ko'pchilik → hech kim).
function nightStepComplete(g, step) {
  const na = g.nightActions || {};
  if (step.phase === 'night_mafia') {
    // FAQAT o'ldirishga ovoz bera oladigan rollar. Advokat mafiya tomonida, lekin
    // night_mafia bosqichida harakat qilmaydi — uni hisobga olsak bosqich hech qachon
    // erta yopilmasdi va kelishuv ham yig'ilmasdi.
    const aliveMafia = g.players.filter(p => p.isAlive && MAFIA_VOTERS.includes(p.role));
    if (!aliveMafia.length) return true;
    const votes = na.mafiaVotes || {};
    // Uzilib qolgan mafiyani kutmaymiz. Hamma tanlagach bosqich tugaydi —
    // kelishuv bo'lmasa yakuniy qarorni Don qabul qiladi (processNight'ga qarang).
    const active = aliveMafia.filter(p => p.connected !== false);
    if (!active.length) return true;
    return active.every(p => !!votes[p.socketId]);
  }
  const keyByPhase = {
    night_komissar: 'komissar', night_doctor: 'doctor', night_escort: 'escort',
    night_advokat: 'lawyer', night_qotil: 'killer', night_daydi: 'daydi',
  };
  return !!na[keyByPhase[step.phase]];
}

export {
  ROLE_SIDE, ROLE_NAMES, roleName, sideOf,
  checkWin, isWinner,
  KILLER_LABEL, killerLabel,
  buildRoleList, SELECTABLE_ROLES, UNIQUE_ROLES, MAFIA_VOTERS,
  normalizeRoleConfig, ROLE_DROP_ORDER, fitRolesToCount, assignRoles,
  NIGHT_STEPS, nightStepByPhase, stepHasActor, nightStepComplete,
};

// ==================== MAFIYA NISHONINI TANLASH (sof) ====================
// Eng xatoga moyil qism: kelishuv → Don qarori → ko'pchilik → hech kim.
// Bloklangan (Kezuvchi) va uzilib qolgan mafiya ovozga qatnashmaydi.
// Natija: { target, by, reason } — reason jurnal kodi (yoki null).
export function chooseMafiaTarget(players, votes = {}, blocked = new Set()) {
  const alive = players.filter(p => p.isAlive && MAFIA_VOTERS.includes(p.role));
  if (!alive.length) return { target: null, by: null, reason: null };

  const active = alive.filter(p => !blocked.has(p.socketId) && p.connected !== false);
  const picks = active.map(p => votes[p.socketId]).filter(Boolean);
  const don = active.find(p => p.role === 'don');

  let target = null, reason = null;
  const unanimous = active.length > 0 && picks.length === active.length && picks.every(v => v === picks[0]);

  if (unanimous) {
    target = picks[0];
  } else if (don && votes[don.socketId]) {
    target = votes[don.socketId];
    if (picks.length > 1) reason = 'donDecided';
  } else if (picks.length) {
    const tally = {};
    for (const v of picks) tally[v] = (tally[v] || 0) + 1;
    let best = null, bestN = 0, tie = false;
    for (const [sid, c] of Object.entries(tally)) {
      if (c > bestN) { best = sid; bestN = c; tie = false; }
      else if (c === bestN) tie = true;
    }
    if (best && !tie) { target = best; reason = 'mafiaMajority'; }
    else reason = 'mafiaNoDeal';
  }

  // Nishon tirik va mafiya tomonidan BO'LMAGAN bo'lishi shart
  if (target) {
    const t = players.find(p => p.socketId === target && p.isAlive);
    if (!t || sideOf(t.role) === 'mafia') return { target: null, by: null, reason };
  }
  return { target, by: target ? ((don || active[0])?.socketId || null) : null, reason };
}

// ==================== TUNGI O'LIMLARNI HAL QILISH (sof) ====================
// Eng murakkab qism: qalqon → doktor → qo'shimcha jon → Bo'ri reenkarnatsiyasi →
// o'lim → Afsungar qasosi. IO'siz: faqat NIMA sodir bo'lishini hisoblaydi,
// natijani qo'llash (DB, emit, jurnal) chaqiruvchining zimmasida.
//
// deaths: [{ sid, cause, by }]   cause: mafia | killer | komissar | afsungar
// opts:   { healTarget }
// Natija: { events, killed, savedSids, lifeUsed, roleChanges, deadSids }
//   events — tartib bo'yicha: { type, sid, ... } (shield|heal|life|reborn|death|revenge)
export function resolveNightDeaths(players, deaths, { healTarget = null } = {}) {
  const byId = new Map(players.map(p => [p.socketId, p]));
  const alive = new Set(players.filter(p => p.isAlive).map(p => p.socketId));
  const lifeLeft = new Map(players.map(p => [p.socketId, (p.items && p.items.life) || 0]));
  const roleOf = new Map(players.map(p => [p.socketId, p.role]));

  const events = [], killed = [], savedSids = [], lifeUsed = [], roleChanges = [], deadSids = [];
  const processed = new Set();

  // Komissar o'qini hech narsa to'xtata olmaydi — uni BIRINCHI hisoblaymiz, aks holda
  // bir nishonga tushgan boshqa hujum qalqonni sarflab, o'qni bekor qilardi.
  const queue = deaths.slice().sort(
    (a, b) => (b.cause === 'komissar' ? 1 : 0) - (a.cause === 'komissar' ? 1 : 0)
  );

  for (let i = 0; i < queue.length; i++) {
    const d = queue[i];
    const t = byId.get(d.sid);
    if (!t || !alive.has(d.sid) || processed.has(d.sid)) continue;

    const unstoppable = d.cause === 'komissar';

    if (!unstoppable && t.shieldActive) {
      processed.add(d.sid); savedSids.push(d.sid);
      events.push({ type: 'shield', sid: d.sid });
      continue;
    }
    if (!unstoppable && healTarget === d.sid) {
      processed.add(d.sid); savedSids.push(d.sid);
      events.push({ type: 'heal', sid: d.sid });
      continue;
    }
    if (!unstoppable && lifeLeft.get(d.sid) > 0) {
      processed.add(d.sid); savedSids.push(d.sid);
      lifeLeft.set(d.sid, lifeLeft.get(d.sid) - 1);
      lifeUsed.push(d.sid);
      events.push({ type: 'life', sid: d.sid });
      continue;
    }

    // 🐺 Bo'ri: mafiya o'qidan Mafiya, Komissar o'qidan Serjant bo'ladi.
    // Serjant allaqachon bo'lsa — Tinch aholi (noyob rol invarianti).
    if (roleOf.get(d.sid) === 'bori' && (d.cause === 'mafia' || d.cause === 'komissar')) {
      let to = d.cause === 'mafia' ? 'mafia' : 'sergeant';
      if (to === 'sergeant') {
        const hasSergeant = [...alive].some(s => s !== d.sid && roleOf.get(s) === 'sergeant');
        if (hasSergeant) to = 'civil';
      }
      roleOf.set(d.sid, to);
      processed.add(d.sid);
      roleChanges.push({ sid: d.sid, role: to });
      events.push({ type: 'reborn', sid: d.sid, role: to, cause: d.cause });
      continue;
    }

    // o'ldi
    alive.delete(d.sid); processed.add(d.sid); deadSids.push(d.sid);
    const role = roleOf.get(d.sid);
    killed.push({ sid: d.sid, name: t.username, role, cause: d.cause, by: d.by || null });
    events.push({ type: 'death', sid: d.sid, role, cause: d.cause, by: d.by || null });

    // 🧞‍♂️ Afsungar o'ldirganni o'zi bilan olib ketadi — navbatga qo'yamiz,
    // shunda qurbonga ham qalqon/doktor/jon/Bo'ri qoidalari qo'llanadi.
    if (role === 'afsungar' && d.by && alive.has(d.by) && !processed.has(d.by)) {
      if (!queue.some(x => x.sid === d.by && x.cause === 'afsungar')) {
        queue.push({ sid: d.by, cause: 'afsungar', by: d.sid });
      }
    }
  }

  return { events, killed, savedSids, lifeUsed, roleChanges, deadSids };
}

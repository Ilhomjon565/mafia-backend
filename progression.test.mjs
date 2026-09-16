import test from 'node:test';
import assert from 'node:assert/strict';
import {
  XP, xpForGame, xpForLevel, levelFromXp, levelProgress,
  RATING_START, RATING_FLOOR, kFactor, expectedScore, eloDelta, applyElo,
  TIERS, tierOf, tierProgress,
} from './progression.js';

// ==================== XP ====================

test('xpForGame: o\'yinni tugatganning o\'zi XP beradi', () => {
  assert.equal(xpForGame({ won: false, survived: false, rounds: 0 }), XP.finish);
});

test('xpForGame: g\'alaba va tirik qolish qo\'shiladi', () => {
  const r = xpForGame({ won: true, survived: true, rounds: 3 });
  assert.equal(r, XP.finish + XP.win + XP.survive + 3 * XP.perRound);
});

test('xpForGame: XP hech qachon manfiy emas', () => {
  assert.ok(xpForGame({ won: false, survived: false, rounds: -5 }) > 0);
  assert.ok(xpForGame({}) > 0);
  assert.ok(xpForGame() > 0);
});

test('xpForGame: cho\'zilgan o\'yin cheksiz XP bermaydi', () => {
  const huge = xpForGame({ rounds: 1000 });
  const cap = xpForGame({ rounds: XP.maxRounds });
  assert.equal(huge, cap, 'raundlar chegarasi ishlashi kerak');
});

test('xpForGame: yutqazgan ham oldinga siljiydi', () => {
  // XP tushib ketmasligi ATAYLAB: aks holda yangi o'yinchi o'yinni tashlaydi
  assert.ok(xpForGame({ won: false, rounds: 2 }) > 0);
});

test('xpForLevel / levelFromXp bir-biriga teskari', () => {
  for (let lvl = 1; lvl <= 40; lvl++) {
    const need = xpForLevel(lvl);
    assert.equal(levelFromXp(need), lvl, `${need} XP -> ${lvl}-daraja`);
    if (lvl > 1) {
      assert.equal(levelFromXp(need - 1), lvl - 1, 'bir XP kam bo\'lsa oldingi daraja');
    }
  }
});

test('levelFromXp: 0 XP birinchi daraja', () => {
  assert.equal(levelFromXp(0), 1);
  assert.equal(levelFromXp(-100), 1);
  assert.equal(levelFromXp(undefined), 1);
});

test('levelFromXp: daraja monoton o\'sadi', () => {
  let prev = 1;
  for (let xp = 0; xp < 20000; xp += 37) {
    const l = levelFromXp(xp);
    assert.ok(l >= prev, 'daraja hech qachon tushmasligi kerak');
    prev = l;
  }
});

test('levelProgress: chegaralarda foiz to\'g\'ri', () => {
  const at = levelProgress(xpForLevel(5));
  assert.equal(at.level, 5);
  assert.equal(at.into, 0);
  assert.equal(at.percent, 0);

  const mid = levelProgress(xpForLevel(5) + (xpForLevel(6) - xpForLevel(5)) / 2);
  assert.equal(mid.level, 5);
  assert.equal(mid.percent, 50);

  const almost = levelProgress(xpForLevel(6) - 1);
  assert.equal(almost.level, 5);
  assert.equal(almost.left, 1);
});

test('levelProgress: foiz har doim 0..100 oralig\'ida', () => {
  for (let xp = 0; xp < 50000; xp += 111) {
    const p = levelProgress(xp);
    assert.ok(p.percent >= 0 && p.percent <= 100, `${xp} -> ${p.percent}`);
    assert.ok(p.left > 0, 'keyingi darajagacha doim masofa bor');
  }
});

// ==================== ELO ====================

test('expectedScore: teng raqiblarda 0.5', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
});

test('expectedScore: kuchliroq raqibda kutilma past', () => {
  assert.ok(expectedScore(1000, 1400) < 0.5);
  assert.ok(expectedScore(1400, 1000) > 0.5);
});

test('kFactor: tajriba ortgani sayin kamayadi', () => {
  assert.ok(kFactor(0) > kFactor(15));
  assert.ok(kFactor(15) > kFactor(100));
});

test('eloDelta: g\'alaba musbat, mag\'lubiyat manfiy', () => {
  assert.ok(eloDelta({ won: true }) > 0);
  assert.ok(eloDelta({ won: false }) < 0);
});

test('eloDelta: kuchli raqibni yengish qimmatroq', () => {
  const vsStrong = eloDelta({ rating: 1000, opponent: 1600, won: true });
  const vsWeak = eloDelta({ rating: 1000, opponent: 400, won: true });
  assert.ok(vsStrong > vsWeak, 'kuchliroq raqibdan ko\'proq ochko');
});

test('eloDelta: zaif raqibga yutqazish qimmatroq turadi', () => {
  const toWeak = eloDelta({ rating: 1600, opponent: 400, won: false });
  const toStrong = eloDelta({ rating: 1000, opponent: 1600, won: false });
  assert.ok(toWeak < toStrong, 'zaifga yutqazgan ko\'proq yo\'qotadi');
});

test('eloDelta: kuchli o\'yinchi zaiflarni yengib qotib qolmaydi', () => {
  // Kutilma ~1 bo'lsa ham kamida 1 ochko berilishi kerak
  const d = eloDelta({ rating: 2400, opponent: 200, won: true });
  assert.ok(d >= 1, `g'olib hech qachon 0 olmaydi, oldik: ${d}`);
});

test('eloDelta: yutqazgan hech qachon ochko yutmaydi', () => {
  const d = eloDelta({ rating: 200, opponent: 2400, won: false });
  assert.ok(d <= -1, `yutqazgan musbat olmasligi kerak, oldik: ${d}`);
});

test('applyElo: reyting pastki chegaradan o\'tmaydi', () => {
  assert.equal(applyElo(RATING_FLOOR, -500), RATING_FLOOR);
  assert.ok(applyElo(120, -100) >= RATING_FLOOR);
});

test('elo: nol yig\'indi emas, lekin barqaror — 500 o\'yin simulyatsiyasi', () => {
  // Bir xil kuchdagi ikki o'yinchi navbatma-navbat yutsa reyting
  // boshlang'ich atrofida qolishi kerak, cheksiz o'smasligi.
  let a = RATING_START, b = RATING_START;
  for (let i = 0; i < 500; i++) {
    const aWon = i % 2 === 0;
    const da = eloDelta({ rating: a, opponent: b, won: aWon, gamesPlayed: i });
    const db = eloDelta({ rating: b, opponent: a, won: !aWon, gamesPlayed: i });
    a = applyElo(a, da); b = applyElo(b, db);
  }
  assert.ok(Math.abs(a - RATING_START) < 120, `a=${a} boshlang'ichga yaqin qolishi kerak`);
  assert.ok(Math.abs(b - RATING_START) < 120, `b=${b} boshlang'ichga yaqin qolishi kerak`);
});

test('elo: doim yutadigan o\'yinchi yuqoriga chiqadi', () => {
  // O'sish ATAYLAB sekinlashadi: raqibdan qancha kuchli bo'lsangiz, g'alaba
  // shuncha kam ochko beradi. Shuning uchun 60 ta g'alaba cheksiz emas,
  // ~1380 atrofiga olib chiqadi — bu Elo'ning to'g'ri xatti-harakati.
  let r = RATING_START;
  for (let i = 0; i < 60; i++) r = applyElo(r, eloDelta({ rating: r, opponent: 1000, won: true, gamesPlayed: i }));
  assert.ok(r > 1300, `60 ta g'alabadan keyin reyting sezilarli o'sishi kerak, oldik: ${r}`);
  assert.ok(r < 1700, `zaif raqiblardan cheksiz o'smasligi kerak, oldik: ${r}`);
});

// ==================== LIGALAR ====================

test('tierOf: chegaralar to\'g\'ri', () => {
  assert.equal(tierOf(0), 'bronze');
  assert.equal(tierOf(899), 'bronze');
  assert.equal(tierOf(900), 'silver');
  assert.equal(tierOf(1900), 'legend');
  assert.equal(tierOf(99999), 'legend');
});

test('tierOf: yaroqsiz qiymatda ham liga qaytadi', () => {
  assert.equal(tierOf(undefined), 'silver', 'boshlang\'ich reyting 1000 -> silver');
  assert.equal(tierOf(NaN), 'silver');
});

test('tierOf: reyting o\'sganda liga tushmaydi', () => {
  let prev = -1;
  for (let r = 0; r < 2500; r += 7) {
    const i = TIERS.findIndex(t => t.key === tierOf(r));
    assert.ok(i >= prev, 'liga faqat yuqoriga qarab o\'zgarishi kerak');
    prev = i;
  }
});

test('tierProgress: eng yuqori ligada keyingisi yo\'q', () => {
  const p = tierProgress(2000);
  assert.equal(p.tier, 'legend');
  assert.equal(p.next, null);
  assert.equal(p.percent, 100);
});

test('tierProgress: foiz 0..100 va `left` manfiy emas', () => {
  for (let r = 0; r < 2200; r += 13) {
    const p = tierProgress(r);
    assert.ok(p.percent >= 0 && p.percent <= 100, `${r} -> ${p.percent}`);
    assert.ok(p.left >= 0);
  }
});

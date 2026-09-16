// pacing.js testlari: o'yin 20-30 daqiqada tugashi KAFOLATLANGAN bo'lishi kerak.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_SOFT_MS, GAME_HARD_MS, MIN_SCALE, PHASE_MIN,
  gameElapsed, timeScale, phaseDuration, isTimeUp,
} from './pacing.js';

const MIN = 60000;
// Sozlamalardagi bazaviy qiymatlar (DEFAULT_SETTINGS.durations bilan bir xil)
const D = { day_discussion: 120, day_results: 8, night_mafia: 25, night_komissar: 20, night_results: 8 };

test('startedAt yo\'q bo\'lsa hech qanday chegara qo\'llanmaydi', () => {
  assert.equal(gameElapsed(null), 0);
  assert.equal(gameElapsed(undefined), 0);
  assert.equal(gameElapsed(0), 0);
  assert.equal(timeScale(0), 1);
  assert.equal(phaseDuration(120, 'day_discussion', 0), 120);
  assert.equal(isTimeUp(0), false);
});

test('gameElapsed son va sanani ham qabul qiladi', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  assert.equal(gameElapsed(now - 5 * MIN, now), 5 * MIN);
  assert.equal(gameElapsed(new Date(now - 5 * MIN), now), 5 * MIN);
  assert.equal(gameElapsed(new Date(now - 5 * MIN).toISOString(), now), 5 * MIN);
  // Kelajakdagi sana manfiy vaqt bermaydi
  assert.equal(gameElapsed(now + 5 * MIN, now), 0);
  // Buzuq qiymat — 0 (chegara qo'llanmaydi, o'yin to'xtab qolmaydi)
  assert.equal(gameElapsed('nimadir', now), 0);
});

test('SOFT chegaraga qadar fazalar TO\'LIQ', () => {
  for (const m of [0, 5, 10, 12.9]) {
    const e = m * MIN;
    assert.equal(timeScale(e), 1, `${m}-daqiqa`);
    assert.equal(phaseDuration(D.day_discussion, 'day_discussion', e), 120);
    assert.equal(phaseDuration(D.night_mafia, 'night_mafia', e), 25);
  }
});

test('SOFT dan keyin fazalar QISQARADI, lekin monoton', () => {
  let prev = 121;
  for (let m = 13; m <= 30; m++) {
    const d = phaseDuration(D.day_discussion, 'day_discussion', m * MIN);
    assert.ok(d <= prev, `${m}-daqiqada uzaydi: ${prev} -> ${d}`);
    prev = d;
  }
  // 25-daqiqada eng past nuqta
  assert.equal(timeScale(GAME_HARD_MS).toFixed(2), MIN_SCALE.toFixed(2));
});

test('kunduz muhokamasi 45 soniyadan pastga TUSHMAYDI', () => {
  // Bundan kamida bahs ham, ovoz ham sig'maydi
  for (let m = 13; m <= 60; m++) {
    const d = phaseDuration(D.day_discussion, 'day_discussion', m * MIN);
    assert.ok(d >= PHASE_MIN.day_discussion, `${m}-daqiqa: ${d}s`);
  }
});

test('tungi bosqich 10 soniyadan pastga tushmaydi', () => {
  for (let m = 13; m <= 60; m++) {
    for (const ph of ['night_mafia', 'night_komissar']) {
      const d = phaseDuration(D[ph], ph, m * MIN);
      assert.ok(d >= 10, `${ph} ${m}-daqiqa: ${d}s`);
    }
  }
});

test('natija ekranlari (8s) qisqartirilsa ham ko\'rinadi', () => {
  const d = phaseDuration(D.day_results, 'day_results', 40 * MIN);
  assert.ok(d >= 5 && d <= 8, 'day_results: ' + d);
});

test('qat\'iy chegara: 25-daqiqada vaqt tugadi', () => {
  assert.equal(isTimeUp(24.9 * MIN), false);
  assert.equal(isTimeUp(25 * MIN), true);
  assert.equal(isTimeUp(40 * MIN), true);
  assert.equal(GAME_HARD_MS, 25 * MIN);
  assert.ok(GAME_SOFT_MS < GAME_HARD_MS);
});

test('haqiqiy o\'yin: raundlar yig\'indisi 30 daqiqadan oshmaydi', () => {
  // 12 o'yinchi, ko'p rol bo'lgan xona — eng UZUN holat.
  // Har raund: kunduz + kunduz natijasi + 7 tungi bosqich + tun natijasi.
  const nightSteps = ['night_mafia', 'night_komissar', 'night_doctor', 'night_escort',
    'night_advokat', 'night_qotil', 'night_daydi'];
  const base = { ...D, night_doctor: 20, night_escort: 20, night_advokat: 20, night_qotil: 20, night_daydi: 20 };
  let t = 0;
  let rounds = 0;
  // O'yin kunduz boshida tugatiladi, shuning uchun aynan shu nuqtada tekshiramiz
  while (!isTimeUp(t) && rounds < 40) {
    rounds++;
    t += phaseDuration(base.day_discussion, 'day_discussion', t) * 1000;
    t += phaseDuration(base.day_results, 'day_results', t) * 1000;
    for (const st of nightSteps) t += phaseDuration(base[st], st, t) * 1000;
    t += phaseDuration(base.night_results, 'night_results', t) * 1000;
  }
  const mins = t / MIN;
  assert.ok(mins <= 30, `o'yin ${mins.toFixed(1)} daqiqa davom etdi`);
  assert.ok(rounds >= 6, `faqat ${rounds} raund sig'di — o'yin juda qisqa`);
});

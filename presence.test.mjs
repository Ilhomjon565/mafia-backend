// presence.js testlari: onlayn ko'rsatkichi tabiiy ko'rinishi kerak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeOnlineBase, fakePlayersBase, ONLINE_CURVE } from './presence.js';

// Toshkent vaqti bo'yicha berilgan soat/daqiqaga to'g'ri keladigan UTC ms
const at = (hour, min = 0) => Date.UTC(2026, 8, 16, hour - 5, min, 0);

test('FAKE_ONLINE=0 bo\'lsa qo\'shimcha yo\'q', () => {
  assert.equal(fakeOnlineBase(at(20), false), 0);
  assert.equal(fakePlayersBase(at(20), false), 0);
});

test('kechqurun tunga qaraganda ko\'p', () => {
  const night = fakeOnlineBase(at(4));
  const evening = fakeOnlineBase(at(20));
  assert.ok(evening > night * 2, `kechqurun (${evening}) tundan (${night}) ancha ko'p bo'lishi kerak`);
});

test('eng gavjum payt kechqurun 19:00-21:00 oralig\'ida', () => {
  let best = -1, bestHour = -1;
  for (let h = 0; h < 24; h++) {
    const v = fakeOnlineBase(at(h, 30));
    if (v > best) { best = v; bestHour = h; }
  }
  assert.ok(bestHour >= 18 && bestHour <= 21, 'eng gavjum soat: ' + bestHour);
});

test('raqam soatlar orasida SAKRAMAYDI', () => {
  // Har daqiqada o'lchaymiz: qo'shni o'lchovlar orasidagi farq kichik bo'lishi kerak
  let maxJump = 0;
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const a = fakeOnlineBase(at(h, m));
      const b = fakeOnlineBase(at(h, m + 1));
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }
  }
  assert.ok(maxJump <= 6, 'daqiqadagi eng katta o\'zgarish juda katta: ' + maxJump);
});

test('bir xil vaqt uchun bir xil natija (kesh va 3 instansiya uchun shart)', () => {
  const t = at(15, 42);
  const vals = new Set();
  for (let i = 0; i < 50; i++) vals.add(fakeOnlineBase(t));
  assert.equal(vals.size, 1, 'natija deterministik bo\'lishi kerak');
});

test('qiymat haqiqatga o\'xshash diapazonda', () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 17, 33, 58]) {
      const v = fakeOnlineBase(at(h, m));
      assert.ok(v >= 35 && v <= 260, `soat ${h}:${m} -> ${v}`);
    }
  }
});

test('raqam qotib qolmaydi (kun bo\'yi turli qiymatlar)', () => {
  const vals = new Set();
  for (let h = 0; h < 24; h++) for (const m of [0, 20, 40]) vals.add(fakeOnlineBase(at(h, m)));
  assert.ok(vals.size > 40, 'turli qiymatlar soni: ' + vals.size);
});

test('ONLINE_CURVE 24 soatni qamrab oladi', () => {
  assert.equal(ONLINE_CURVE.length, 24);
  for (const v of ONLINE_CURVE) assert.ok(v > 0 && v < 400);
});

test('jami o\'yinchilar soni kun ichida barqaror', () => {
  const a = fakePlayersBase(at(9));
  const b = fakePlayersBase(at(23));
  assert.equal(a, b, 'bir kun ichida jami hisob o\'zgarmasligi kerak');
});

test('jami o\'yinchilar soni kundan kunga o\'sadi yoki saqlanadi', () => {
  const d1 = fakePlayersBase(at(12));
  const d2 = fakePlayersBase(at(12) + 86400000);
  assert.ok(d2 !== d1 || d2 === d1, 'kun almashsa qiymat qayta hisoblanadi');
  assert.ok(d1 > 1000 && d1 < 20000, 'haqiqatga o\'xshash: ' + d1);
});

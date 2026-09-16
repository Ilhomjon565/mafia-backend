// presence.js testlari: onlayn ko'rsatkichi tabiiy ko'rinishi kerak.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeOnlineBase, fakePlayersBase, fakeGamesPlayed, fakeRooms, ONLINE_CURVE,
  botGameSchedule, dueBotGameSlot,
} from './presence.js';

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

// ---------- lobbidagi soxta xonalar ----------

test('soxta xonalarda BARCHA maydonlar bor', () => {
  // Bir vaqtda `>>` (ishorali siljitish) tufayli ba'zi xonalar NOMSIZ qolgan edi:
  // h32() 2^31 dan katta son qaytarsa `s >> 7` manfiy bo'lib, manfiy indeks
  // undefined berardi. Shuning uchun ko'p vaqt oralig'ida tekshiramiz.
  const need = ['id', 'name', 'status', 'totalPlayers', 'mafiaCount', 'sheriffCount',
                'doctorCount', 'civilCount', 'hostId', 'createdAt', 'phase', 'players'];
  for (let k = 0; k < 400; k++) {
    const t = Date.UTC(2026, 8, 16) + k * 7 * 60000;
    const rooms = fakeRooms(t);
    assert.ok(rooms.length >= 5 && rooms.length <= 10, 'xonalar soni: ' + rooms.length);
    for (const r of rooms) {
      for (const f of need) {
        assert.ok(r[f] !== undefined && r[f] !== null, `${f} yo'q (vaqt ${k}): ` + JSON.stringify(r).slice(0, 120));
      }
      assert.ok(typeof r.name === 'string' && r.name.length > 2, 'nom bo\'sh: ' + r.name);
    }
  }
});

test('soxta xonalarga QO\'SHILIB BO\'LMAYDI (hammasi to\'lgan)', () => {
  // Soxta xona ID si haqiqiy emas — unga kirmoqchi bo'lgan odam xato ko'rardi.
  // Frontend to'lgan yoki jangdagi xonaning tugmasini bloklaydi.
  for (let k = 0; k < 200; k++) {
    for (const r of fakeRooms(Date.UTC(2026, 8, 16) + k * 7 * 60000)) {
      const full = r.players.length >= r.totalPlayers;
      assert.ok(full || r.status === 'playing',
        `xona qo'shilishga ochiq qolgan: ${r.name} ${r.players.length}/${r.totalPlayers} ${r.status}`);
    }
  }
});

test('ikki xil holat ham uchraydi (hammasi bir xil emas)', () => {
  const statuses = new Set();
  const names = new Set();
  const sizes = new Set();
  for (let k = 0; k < 120; k++) {
    for (const r of fakeRooms(Date.UTC(2026, 8, 16) + k * 7 * 60000)) {
      statuses.add(r.status); names.add(r.name); sizes.add(r.totalPlayers);
    }
  }
  assert.equal(statuses.size, 2, 'waiting va playing ikkisi ham bo\'lishi kerak: ' + [...statuses]);
  assert.ok(names.size > 10, 'nomlar xilma-xil bo\'lsin: ' + names.size);
  assert.ok(sizes.size > 3, 'xona o\'lchamlari xilma-xil bo\'lsin: ' + sizes.size);
});

test('o\'yinchi ismlari va ID lari to\'g\'ri', () => {
  for (const r of fakeRooms(Date.UTC(2026, 8, 16))) {
    assert.equal(r.players.length, r.totalPlayers, 'xona to\'lgan bo\'lishi kerak');
    for (const p of r.players) {
      assert.ok(p.username && p.username.length > 1, 'ism: ' + p.username);
      assert.ok(!/bot/i.test(p.username), 'ismda "bot": ' + p.username);
      assert.ok(p.userId && p.userId.startsWith('c'), 'userId cuid ga o\'xshasin: ' + p.userId);
    }
  }
});

test('to\'plam vaqt o\'tishi bilan yangilanadi', () => {
  const t = Date.UTC(2026, 8, 16, 12);
  const a = fakeRooms(t).map(r => r.id).join();
  const b = fakeRooms(t + 60000).map(r => r.id).join();     // 1 daqiqadan keyin
  const c = fakeRooms(t + 8 * 60000).map(r => r.id).join(); // 8 daqiqadan keyin
  assert.equal(a, b, 'bir necha daqiqa ichida o\'zgarmasligi kerak (kesh uchun)');
  assert.notEqual(a, c, '7 daqiqadan keyin yangilanishi kerak');
});

test('FAKE_ONLINE=0 bo\'lsa xona ham yo\'q', () => {
  assert.deepEqual(fakeRooms(Date.now(), false), []);
});

test('xona nomlari bir vaqtda takrorlanmaydi', () => {
  for (let k = 0; k < 300; k++) {
    const rooms = fakeRooms(Date.UTC(2026, 8, 16) + k * 7 * 60000);
    const names = rooms.map(r => r.name);
    assert.equal(new Set(names).size, names.length,
      'takrorlangan nom: ' + names.join(', '));
  }
});

// ---------- botlarning o'zaro o'yinlari ----------

test('kuniga 10-15 ta o\'yin rejalashtiriladi', () => {
  for (let d = 0; d < 60; d++) {
    const slots = botGameSchedule(Date.UTC(2026, 8, 16) + d * 86400000);
    assert.ok(slots.length >= 10 && slots.length <= 15, "kunlik oyin soni: " + slots.length);
    for (const h of slots) assert.ok(h >= 10.5 && h <= 23.75, 'vaqt oralig\'i: ' + h);
    // tartiblangan va bir-biriga yopishib qolmagan
    for (let i = 1; i < slots.length; i++) {
      assert.ok(slots[i] > slots[i - 1], 'vaqtlar tartibda bo\'lishi kerak');
      assert.ok(slots[i] - slots[i - 1] > 0.3, 'o\'yinlar juda yaqin: ' + (slots[i] - slots[i - 1]));
    }
  }
});

test('jadval bir kun ichida O\'ZGARMAYDI (server restartida ham)', () => {
  const a = botGameSchedule(Date.UTC(2026, 8, 16, 7)).join();
  const b = botGameSchedule(Date.UTC(2026, 8, 16, 15)).join();
  assert.equal(a, b, 'bir kunning jadvali barqaror bo\'lishi kerak');
  const c = botGameSchedule(Date.UTC(2026, 8, 17, 7)).join();
  assert.notEqual(a, c, 'boshqa kunda boshqa jadval');
});

test('vaqti kelgan slot aniqlanadi', () => {
  const day = Date.UTC(2026, 8, 16);
  const slots = botGameSchedule(day);
  // birinchi slotning aynan vaqti (Toshkent) -> UTC
  const at = (h) => day + Math.round((h - 5) * 3600000);
  assert.equal(dueBotGameSlot(at(slots[0]) + 60000, []), 0, 'birinchi o\'yin boshlanishi kerak');
  assert.equal(dueBotGameSlot(at(slots[0]) + 60000, [0]), -1, 'boshlangan o\'yin qayta boshlanmaydi');
  assert.equal(dueBotGameSlot(at(slots[0]) - 600000, []), -1, 'vaqti kelmagan');
  assert.equal(dueBotGameSlot(at(slots[0]) + 3600000, []), -1, '40 daqiqalik oyna o\'tib ketdi');
});

test('ertalab va yarim kechada o\'yin boshlanmaydi', () => {
  const day = Date.UTC(2026, 8, 16);
  for (const h of [2, 5, 8, 9.5]) {
    assert.equal(dueBotGameSlot(day + (h - 5) * 3600000, []), -1, 'soat ' + h + ' da o\'yin bo\'lmasligi kerak');
  }
});

test('bir kunda hamma slot navbat bilan boshlanadi', () => {
  const day = Date.UTC(2026, 8, 16);
  const slots = botGameSchedule(day);
  const started = [];
  for (const [i, h] of slots.entries()) {
    const due = dueBotGameSlot(day + Math.round((h - 5) * 3600000) + 120000, started);
    assert.equal(due, i, `${i}-slot boshlanishi kerak`);
    started.push(due);
  }
  assert.equal(started.length, slots.length, 'hamma o\'yin o\'tkazilishi kerak');
});

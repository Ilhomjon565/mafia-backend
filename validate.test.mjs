// validate.js testlari.
// Ikki narsa qulflanadi: taxallus qoidalari va qavslarni olib tashlash.
// Qavs tekshiruvi ATAYLAB batafsil — "aylanma yo'l" topilsa test yiqilishi
// kerak, aks holda teshik jimgina qaytib keladi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NICK_MIN, NICK_MAX, ROOM_NAME_MAX,
  cleanText, hasAngle, cleanDeep, validateNick, validateRoomName,
} from './validate.js';

// ---------- QAVSLAR ----------

test('oddiy qavslar olib tashlanadi', () => {
  assert.equal(cleanText('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(cleanText('a<b>c'), 'abc');
  assert.equal(cleanText('<<>>'), '');
});

test('to\'liq kenglikdagi qavslar ham (NFKC)', () => {
  // ＜ = U+FF1C, ＞ = U+FF1E — ko'zga oddiy qavs, kodda boshqa belgi
  assert.equal(cleanText('＜div＞'), 'div');
  assert.equal(cleanText('＜script＞alert＜/script＞'), 'scriptalert/script');
});

test('HTML mohiyat shakllari ham', () => {
  for (const s of ['&lt;b&gt;x', '&LT;b&GT;x', '&#60;b&#62;x', '&#x3c;b&#x3e;x',
                   '&#x3C;b&#x3E;x', '&#060;b&#062;x']) {
    assert.equal(cleanText(s), 'bx', 'mohiyat qoldi: ' + s);
  }
});

test('ko\'rinmas belgilar bilan yashirish ishlamaydi', () => {
  // <scr[ZWSP]ipt> kabi hiyla: ko'rinmas belgi olib tashlanadi, keyin qavs ham
  assert.equal(cleanText('<scr​ipt>'), 'script');
  assert.equal(cleanText('﻿<b>‍'), 'b');
  assert.equal(cleanText('a­b'), 'ab');
});

test('tipografik qavslar QOLADI (HTML da ma\'nosi yo\'q)', () => {
  assert.equal(cleanText('‹a›'), '‹a›');
  assert.equal(cleanText('⟨x⟩'), '⟨x⟩');
});

test('oddiy matn buzilmaydi', () => {
  assert.equal(cleanText('Salom, dunyo!'), 'Salom, dunyo!');
  assert.equal(cleanText("G'ayrat & Co."), "G'ayrat & Co.");
  assert.equal(cleanText('  ikki   bo\'shliq  '), "ikki bo'shliq");
  assert.equal(cleanText('emoji 🎭 qoladi'), 'emoji 🎭 qoladi');
});

test('hasAngle yashirin shakllarni ham topadi', () => {
  assert.equal(hasAngle('<b>'), true);
  assert.equal(hasAngle('＜b＞'), true);
  assert.equal(hasAngle('&lt;b&gt;'), true);
  assert.equal(hasAngle('oddiy matn'), false);
  assert.equal(hasAngle('‹a›'), false);
});

test('cleanDeep obyekt ichini tozalaydi', () => {
  const o = { a: '<b>x', b: { c: ['&lt;i&gt;y', 5, true] }, d: null };
  cleanDeep(o);
  assert.equal(o.a, 'bx');
  assert.equal(o.b.c[0], 'iy');
  assert.equal(o.b.c[1], 5);
  assert.equal(o.b.c[2], true);
  assert.equal(o.d, null);
});

test('cleanDeep chuqurlikda to\'xtaydi (stek to\'lmasin)', () => {
  let o = { v: '<x>' };
  for (let i = 0; i < 50; i++) o = { nested: o };
  assert.doesNotThrow(() => cleanDeep(o));
});

test('cleanText uzunlikni cheklaydi', () => {
  assert.equal(cleanText('a'.repeat(100), { maxLen: 10 }).length, 10);
});

// ---------- TAXALLUS ----------

test('to\'g\'ri taxalluslar qabul qilinadi', () => {
  const ok = ['Sardor', 'bobur7', "G'ayrat", 'Toʻlqin', 'aziz_99',
    'Ne-Mo', 'a.b.c', 'Иван', 'саша_01', 'ab1', 'Malika_X'];
  for (const n of ok) {
    const r = validateNick(n);
    assert.ok(r.ok, `rad etildi: ${n} (${r.code})`);
  }
});

test('uzunlik chegaralari', () => {
  assert.equal(validateNick('ab').code, 'short');
  assert.equal(validateNick('a').code, 'short');
  assert.equal(validateNick('').code, 'empty');
  assert.equal(validateNick('a'.repeat(NICK_MAX)).ok, true);
  assert.equal(validateNick('a'.repeat(NICK_MAX + 1)).code, 'long');
  assert.equal(NICK_MIN, 3);
  assert.equal(NICK_MAX, 16);
});

test('chetlarida ajratgich bo\'lmaydi', () => {
  for (const n of ['_aziz', 'aziz_', '.aziz', 'aziz.', '-aziz', 'aziz-']) {
    assert.equal(validateNick(n).code, 'edge', n);
  }
});

test('ketma-ket ajratgich bo\'lmaydi', () => {
  for (const n of ['a__b', 'a..b', 'a--b', 'a_.b']) {
    assert.equal(validateNick(n).code, 'sep', n);
  }
});

test('lotin va kirill ARALASH bo\'lmaydi (nusxalash hiylasi)', () => {
  // "Аdmin" — birinchi harf kirill: ko'zga lotin "Admin" dan farq qilmaydi
  assert.equal(validateNick('Аdmin').code, 'chars');
  assert.equal(validateNick('Иvan').code, 'chars');
  assert.equal(validateNick('sardorЖ').code, 'chars');
});

test('boshqa yozuv tizimlari va belgilar rad etiladi', () => {
  for (const n of ['名前です', 'مرحبا', 'a b c', 'a@b.c', 'a#1', 'a$b', 'a/b', 'a\\b', 'a+b']) {
    assert.equal(validateNick(n).ok, false, n);
  }
});

test('faqat raqamdan iborat taxallus rad etiladi', () => {
  assert.equal(validateNick('12345').code, 'digits');
  assert.equal(validateNick('1_2_3').code, 'digits');
  assert.equal(validateNick('a1234').ok, true);
});

test('band nomlar rad etiladi', () => {
  for (const n of ['admin', 'Admin', 'ADMIN', 'a.d.m.i.n', 'moderator', 'mafia',
                   'bot', 'system', 'support', 'guest']) {
    assert.equal(validateNick(n).code, 'reserved', n);
  }
});

test('natijada qavs HECH QACHON qolmaydi', () => {
  // MUHIM kafolat: taxallus qabul qilinsa ham, uning ichida qavs
  // qolmasligi kerak. Ba'zi kirish qiymatlari qavs olib tashlangandan
  // keyin qoidaga mos bo'lib qoladi ('<script>' -> 'script') — bu
  // xavfsiz va ruxsat etiladi.
  for (const n of ['<b>', '<script>', 'a<b', 'a>b', '&lt;b&gt;', '＜b＞',
                   '<img src=x onerror=1>', 'Sar<>dor', '<scr​ipt>']) {
    const r = validateNick(n);
    if (r.ok) {
      assert.equal(hasAngle(r.value), false, 'qavs qoldi: ' + n + ' -> ' + r.value);
      assert.ok(!/[<>]/.test(r.value), 'qavs qoldi: ' + r.value);
    }
  }
  // Qavslar olib tashlangach qolgani to'g'ri nom bo'lsa — o'tadi
  const r = validateNick('Sar<>dor');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Sardor');
  // Faqat qavsdan iborat bo'lsa — bo'sh qoladi va rad etiladi
  assert.equal(validateNick('<>').ok, false);
  assert.equal(validateNick('&lt;&gt;').ok, false);
});

// ---------- XONA NOMI ----------

test('xona nomi: bo\'shliq va tinish belgilari mumkin, qavs yo\'q', () => {
  assert.equal(validateRoomName('Tungi shahar').value, 'Tungi shahar');
  assert.equal(validateRoomName('Kim mafiya?').value, 'Kim mafiya?');
  assert.equal(validateRoomName('<b>xona</b>').value, 'bxona/b');
  assert.equal(validateRoomName('a').code, 'short');
  assert.equal(validateRoomName('!!!').code, 'chars');
  assert.equal(validateRoomName('x'.repeat(100)).value.length, ROOM_NAME_MAX);
});

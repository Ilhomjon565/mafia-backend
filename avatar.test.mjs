// avatar.js testlari: profil rasmlari xilma-xil va barqaror bo'lishi kerak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { botAvatar, botAvatarUrl, AVATAR_KINDS } from './avatar.js';
import { makeFillerBots } from './bot-ai.js';


test('har bot uchun boshqa avatar, lekin har doim bir xil', () => {
  const a1 = botAvatar('seed-1'), a2 = botAvatar('seed-1'), b = botAvatar('seed-2');
  assert.equal(a1, a2, 'bir xil seed -> bir xil rasm (kesh uchun shart)');
  assert.notEqual(a1, b, 'boshqa seed -> boshqa rasm');
});

test('avatar haqiqiy SVG va ixcham', () => {
  for (let i = 0; i < 40; i++) {
    const svg = botAvatar('bot' + i);
    assert.ok(svg.startsWith('<svg '), 'SVG bo\'lishi kerak');
    assert.ok(svg.endsWith('</svg>'), 'yopilishi kerak');
    assert.ok(svg.includes('viewBox="0 0 80 80"'));
    assert.ok(svg.length < 2500, 'juda katta: ' + svg.length);
    // XSS: seed rasm ichiga tushmasligi kerak
    assert.ok(!svg.includes('bot' + i), 'seed SVG ichiga chiqib ketdi');
  }
});

test("botlarda rasm yo'q — taxallusning birinchi harfi ko'rsatiladi", () => {
  // Foydalanuvchi qarori: soxta o'yinchilarda profil rasmi bo'lmasin.
  // Mijoz avatarsiz o'yinchi uchun ismning birinchi harfini chizadi —
  // haqiqiy o'yinchilarning ko'pida ham avatar yo'q, ya'ni bu odatiy ko'rinish.
  for (const b of makeFillerBots('g1', 6, [])) {
    assert.equal(b.avatar, null, "botda rasm bolmasligi kerak");
    assert.ok(b.username && b.username.length > 1, 'harf uchun ism kerak');
  }
});

test('avatarlar XILMA-XIL — bir xonada bir xil uslub takrorlanmaydi', () => {
  // Xonadagi 12 o'yinchining rasmlari sezilarli darajada farq qilishi kerak.
  // Ilgari faqat bitta uslub (identicon) bor edi va hamma avatar bir xil
  // ko'rinardi — buni o'yinchi darhol sezardi.
  for (let room = 0; room < 30; room++) {
    const svgs = makeFillerBots('room' + room, 12, []).map(b => botAvatar(b.publicId));
    // 12 o'yinchi, 9 turkum — bir xil turkum takrorlanishi tabiiy, lekin
    // rasmlar (rang va shakl bilan) deyarli hammasi farq qilishi kerak.
    assert.ok(new Set(svgs).size >= 10,
      "bir xonada juda kop bir xil rasm: " + new Set(svgs).size + "/12");
  }
});

test('barcha turkumlar ishlatiladi', () => {
  // Turkumni SVG ichidagi belgilaridan taxmin qilamiz
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    const s = botAvatar('seed' + i);
    if (s.includes('linearGradient')) seen.add('abstrakt');
    else if (s.includes('<ellipse')) seen.add('gul');
    else if (s.includes(' Q ')) seen.add('tolqin');
    else if (s.includes('L80 80Z')) seen.add('tog');
    else if ((s.match(/<rect /g) || []).length > 5) seen.add('katakcha');
    else seen.add('boshqa');
  }
  assert.ok(seen.size >= 4, 'turkumlar xilma-xilligi past: ' + [...seen].join(','));
  assert.ok(AVATAR_KINDS >= 8, 'turkumlar soni: ' + AVATAR_KINDS);
});

test('SVG toza — seed rasm ichiga tushmaydi (XSS)', () => {
  const evil = '"><script>alert(1)</script>';
  const svg = botAvatar(evil);
  assert.ok(!svg.includes('script'), 'seed SVG ichiga chiqib ketdi');
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
});

test('avatar URL bot ekanini oshkor qilmaydi', () => {
  const u = botAvatarUrl('c1234567890abcdef');
  assert.equal(u, '/api/avatar/c1234567890abcdef');
  assert.ok(!/bot/i.test(u));
});

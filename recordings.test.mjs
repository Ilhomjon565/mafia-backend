// recordings.js testlari.
//
// Eng muhimi DISK CHEGARALARI: ovoz yozuvi nazoratdan chiqsa serverni to'ldirib
// qo'yadi. Shu sababli uch qatlamli chegara (o'yinchi / o'yin / umumiy) va
// tozalash mantiqi alohida qulflangan.
//
// Modul sozlamalarni import paytida o'qiydi, shuning uchun env shu yerda —
// import'dan OLDIN — o'rnatiladi va vaqtinchalik katalog ishlatiladi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-rec-'));
process.env.RECORD_DIR = TMP;
process.env.RECORD_MAX_MB = '5';      // umumiy 5 MB
process.env.RECORD_GAME_MB = '2';     // bitta o'yin 2 MB
process.env.RECORD_USER_MB = '1';     // bitta o'yinchi 1 MB
process.env.RECORD_KEEP_DAYS = '2';
process.env.VOICE_RECORD = '1';

const rec = await import('./recordings.js');

function fresh() {
  // Har testdan oldin toza holat
  for (const d of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, d), { recursive: true, force: true });
  rec.resync();
}

const buf = (n) => Buffer.alloc(n, 1);

test('init katalog yaratadi va yoqiladi', () => {
  const r = rec.init();
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(TMP));
});

test("ochilmagan o'yinga yozib bo'lmaydi", () => {
  fresh();
  const r = rec.append('yoq-bunday-oyin', 'u1', buf(100));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'notOpen');
});

test("o'yin ochiladi va bo'lak qo'shiladi", () => {
  fresh();
  assert.equal(rec.open('g1'), true);
  const r = rec.append('g1', 'user1', buf(1000));
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1000);
  // ikkinchi bo'lak KETMA-KET ulanadi (MediaRecorder shunday ishlaydi)
  const r2 = rec.append('g1', 'user1', buf(500));
  assert.equal(r2.bytes, 1500);
  assert.equal(fs.statSync(path.join(TMP, 'g1', 'user1.webm')).size, 1500);
});

test("juda katta bo'lak rad etiladi", () => {
  fresh();
  rec.open('g1');
  const r = rec.append('g1', 'u1', buf(rec.MAX_CHUNK + 1));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'chunkTooBig');
});

test("bitta o'yinchi chegarasi ishlaydi va boshqasiga xalaqit bermaydi", () => {
  fresh();
  rec.open('g1');
  // 1 MB chegara — 400 KB dan ikkitasi sig'adi, uchinchisi yo'q
  assert.equal(rec.append('g1', 'u1', buf(400 * 1024)).ok, true);
  assert.equal(rec.append('g1', 'u1', buf(400 * 1024)).ok, true);
  const r = rec.append('g1', 'u1', buf(400 * 1024));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'userFull');
  // Chegara HAR O'YINCHIGA alohida: bittasi to'ldirgani boshqasini to'smaydi
  assert.equal(rec.append('g1', 'u2', buf(400 * 1024)).ok, true);
});

test("umumiy chegara to'lganda YANGI o'yin ochilmaydi", () => {
  fresh();
  // Har o'yinni o'z chegarasigacha to'ldirib boramiz (o'yin 2 MB, umumiy 5 MB),
  // umumiy chegara to'lgach `open` false qaytarishi kerak.
  let opened = 0;
  for (let i = 1; i <= 10; i++) {
    if (!rec.open('g' + i)) break;
    opened++;
    for (let u = 0; u < 3; u++) {
      while (rec.append('g' + i, 'u' + u, buf(200 * 1024)).ok) { /* to'ldiramiz */ }
    }
  }
  assert.ok(opened > 0 && opened < 10, "chegara umuman ishlamadi: " + opened);
  assert.equal(rec.open('gX'), false, "disk to'lganda yangi yozuv boshlanmasligi kerak");
  // Va hajm chegaradan OSHMAGAN bo'lishi kerak
  assert.ok(rec.stats().hajmMb <= rec.LIMITS.maxTotalMb, 'chegaradan oshdi: ' + rec.stats().hajmMb);
});

test('yo\'l bo\'ylab chiqib ketib bo\'lmaydi (path traversal)', () => {
  fresh();
  rec.open('g1');
  rec.append('g1', 'u1', buf(50));
  // Nom tozalanadi: '../' belgilari olib tashlanadi
  for (const bad of ['../../etc/passwd', '..\\..\\windows', '/etc/shadow', '....//x']) {
    assert.equal(rec.filePath('g1', bad), null, 'chiqib ketdi: ' + bad);
    assert.equal(rec.filePath(bad, 'u1.webm'), null, 'gameId orqali chiqdi: ' + bad);
  }
  // Oddiy nom esa ishlaydi
  assert.ok(rec.filePath('g1', 'u1.webm'));
});

test("xavfli KALIT bilan fayl UMUMAN yaratilmaydi", () => {
  fresh();
  rec.open('g1');
  // Ilgari nom tozalanardi ('../../qochdi' -> '....qochdi') va fayl baribir
  // yaratilardi. 2026-09-18 auditidan keyin '..' tarkibidagi nom BUTUNLAY
  // rad etiladi: shubhali kirishda hech narsa yozilmaydi.
  const r = rec.append('g1', '../../qochdi', buf(50));
  assert.equal(r.ok, false, 'xavfli kalit qabul qilindi');
  assert.equal(r.code, 'badId');
  assert.equal(fs.readdirSync(path.join(TMP, 'g1')).length, 0, 'fayl yaratilib qoldi');
  assert.equal(fs.existsSync(path.join(TMP, 'qochdi.webm')), false);
  // Oddiy kalit esa ishlashda davom etadi
  assert.equal(rec.append('g1', 'oddiy_kalit', buf(50)).ok, true);
});

test('JSON saqlanadi va o\'qiladi', () => {
  fresh();
  rec.open('g1');
  assert.equal(rec.saveJson('g1', 'game', { chat: [{ m: 'salom' }], round: 3 }), true);
  const back = rec.readJson('g1', 'game');
  assert.equal(back.round, 3);
  assert.equal(back.chat[0].m, 'salom');
});

test("drop yozuvni butunlay o'chiradi va hisobni kamaytiradi", () => {
  fresh();
  rec.open('g1');
  rec.append('g1', 'u1', buf(300 * 1024));
  const before = rec.stats().hajmMb;
  assert.ok(before > 0, 'hajm hisoblanmadi');
  assert.equal(rec.drop('g1'), true);
  assert.equal(fs.existsSync(path.join(TMP, 'g1')), false);
  assert.ok(rec.stats().hajmMb < before, 'hisob kamaymadi');
});

test('sweep muddati o\'tganini o\'chiradi, ketayotganiga tegmaydi', () => {
  fresh();
  rec.open('eski');
  rec.append('eski', 'u1', buf(1000));
  rec.open('yangi');
  rec.append('yangi', 'u1', buf(1000));
  rec.open('ketyapti');
  rec.append('ketyapti', 'u1', buf(1000));

  // "eski" va "ketyapti" ni muddatdan oshirib qo'yamiz
  const old = new Date(Date.now() - 5 * 864e5);
  fs.utimesSync(path.join(TMP, 'eski'), old, old);
  fs.utimesSync(path.join(TMP, 'ketyapti'), old, old);

  const r = rec.sweep(new Set(['ketyapti']));
  assert.equal(r.ochirildi, 1, "faqat bitta o'chirilishi kerak edi");
  assert.equal(fs.existsSync(path.join(TMP, 'eski')), false);
  assert.equal(fs.existsSync(path.join(TMP, 'yangi')), true, 'yangi yozuv tegilmasligi kerak');
  assert.equal(fs.existsSync(path.join(TMP, 'ketyapti')), true, "ketayotgan o'yin tegilmasligi kerak");
});

test('files va list to\'g\'ri ma\'lumot beradi', () => {
  fresh();
  rec.open('g1');
  rec.append('g1', 'aaa', buf(1234));
  rec.saveJson('g1', 'game', { x: 1 });
  const f = rec.files('g1');
  assert.equal(f.length, 2);
  const audio = f.find((x) => x.name === 'aaa.webm');
  assert.equal(audio.size, 1234);
  const l = rec.list();
  assert.ok(l.some((x) => x.gameId === 'g1'));
});

test('stats chegaralarni ko\'rsatadi', () => {
  fresh();
  const s = rec.stats();
  assert.equal(s.chegaraMb, 5);
  assert.equal(s.kun, 2);
  assert.equal(typeof s.foizi, 'number');
});

test('LIMITS tashqariga chiqariladi (health va admin uchun)', () => {
  assert.equal(rec.LIMITS.maxTotalMb, 5);
  assert.equal(rec.LIMITS.maxGameMb, 2);
  assert.equal(rec.LIMITS.maxUserMb, 1);
  assert.equal(rec.LIMITS.keepDays, 2);
  assert.ok(rec.LIMITS.dir.length > 0);
});


// ==================== YO'L TRAVERSALI (2026-09-18 auditi) ====================
// Belgilarni filtrlashning O'ZI yetarli emas edi: nuqta ruxsat etilgan
// belgilar ichida bo'lgani uchun safeName('..') '..' ni o'zgartirmasdan
// qaytarardi va path.join(DIR,'..') OTA-KATALOGGA olib chiqardi:
//   GET  /api/admin/evidence/../file/backend.env  -> sirlarni o'qish
//   DELETE /api/admin/evidence/..                 -> butun /srv/mafia o'chishi

test("'..' va uning shakllari BUTUNLAY rad etiladi", () => {
  // Ildizdan tashqarida "o'lja" fayl qo'yamiz — unga hech qanday yo'l bilan
  // yetib bo'lmasligi kerak.
  const bait = path.join(TMP, '..', 'olja-' + process.pid + '.txt');
  fs.writeFileSync(bait, 'sirli qiymat');
  try {
    for (const bad of ['..', '.', '../x', 'a..b', '....', '../..', './..']) {
      assert.equal(rec.isOpen(bad), false, 'isOpen o\'tkazdi: ' + bad);
      assert.equal(rec.filePath(bad, 'olja.txt'), null, 'filePath o\'tkazdi: ' + bad);
      assert.equal(rec.files(bad).length, 0, 'files o\'tkazdi: ' + bad);
      assert.equal(rec.drop(bad), false, 'drop o\'tkazdi: ' + bad);
      assert.equal(rec.open(bad), false, 'open o\'tkazdi: ' + bad);
      assert.equal(rec.append(bad, 'u1', buf(10)).ok, false, 'append o\'tkazdi: ' + bad);
      assert.equal(rec.saveJson(bad, 'x', { a: 1 }), false, 'saveJson o\'tkazdi: ' + bad);
    }
    assert.ok(fs.existsSync(bait), 'ildizdan tashqaridagi fayl o\'chib ketdi!');
    assert.equal(fs.readFileSync(bait, 'utf8'), 'sirli qiymat', 'fayl buzildi');
  } finally {
    try { fs.unlinkSync(bait); } catch {}
  }
});

test('fayl nomi orqali ham chiqib bo\'lmaydi', () => {
  fresh();
  rec.open('g1');
  rec.append('g1', 'u1', buf(50));
  for (const bad of ['../backend.env', '..', '.', '../../etc/passwd']) {
    assert.equal(rec.filePath('g1', bad), null, 'chiqib ketdi: ' + bad);
  }
  assert.ok(rec.filePath('g1', 'u1.webm'), 'oddiy nom ishlashi kerak');
});

// ==================== KENGAYTMA VA KVOTA ====================
// Kengaytma mijozdan (X-Rec-Ext) kelardi va HAR BIRI alohida fayl bo'lgani
// uchun o'yinchi kvotasi qayta-qayta nolga qaytardi: bitta odam 6 MB o'rniga
// butun o'yin budjetini yeb, QOLGANLARNING ovozli dalilini yo'q qilardi.

test('faqat ruxsat etilgan kengaytma yoziladi', () => {
  fresh();
  rec.open('g1');
  for (const ext of ['zz9', 'a', 'exe', 'sh', 'json']) rec.append('g1', 'u1', buf(50), ext);
  const names = rec.files('g1').map((f) => f.name);
  assert.ok(names.every((n) => /\.(webm|mp4)$/.test(n)), 'kutilmagan kengaytma: ' + names.join(','));
  assert.ok(rec.ALLOWED_EXT.includes('webm') && rec.ALLOWED_EXT.includes('mp4'));
});

test("kvota KALIT bo'yicha — kengaytma almashtirib chetlab bo'lmaydi", () => {
  fresh();
  rec.open('g1');
  // Kengaytmani har safar almashtirib, chegaradan oshishga urinamiz
  let wrote = 0;
  for (let i = 0; i < 40; i++) {
    const ext = i % 2 ? 'mp4' : 'webm';
    const r = rec.append('g1', 'u1', buf(200 * 1024), ext);
    if (!r.ok) { assert.equal(r.code, 'userFull', 'kutilmagan kod: ' + r.code); break; }
    wrote += 200 * 1024;
  }
  // 1 MB chegara (sinov sozlamasi) — kengaytma almashsa ham oshmasligi kerak
  assert.ok(wrote <= rec.LIMITS.maxUserMb * 1024 * 1024,
    'kvota chetlab o\'tildi: ' + Math.round(wrote / 1024) + ' KB');
  // Boshqa o'yinchi hali yoza olishi kerak
  assert.equal(rec.append('g1', 'u2', buf(50 * 1024)).ok, true, 'boshqa o\'yinchi bloklandi');
});


// ==================== BO'LAK (SEGMENT) — 2026-09-18 auditi ====================
// MediaRecorder qayta ishga tushganda YANGI webm sarlavhasi bilan boshlaydi.
// Ilgari hamma bo'lak bitta faylga qo'shilardi va ikkinchi sarlavhadan keyin
// fayl hech bir pleyerda ochilmasdi — ya'ni shikoyat bo'lsa ham dalil yo'q edi.

test("qayta boshlangan yozuv ALOHIDA faylga tushadi", () => {
  fresh();
  rec.open('g1');
  assert.equal(rec.append('g1', 'u1', buf(100), 'webm', 0).ok, true);
  assert.equal(rec.append('g1', 'u1', buf(100), 'webm', 1).ok, true);
  assert.equal(rec.append('g1', 'u1', buf(100), 'webm', 2).ok, true);
  const names = rec.files('g1').map((f) => f.name).sort();
  assert.deepEqual(names, ['u1.2.webm', 'u1.3.webm', 'u1.webm'],
    'fayllar: ' + names.join(','));
});

test("bo'lak raqami KVOTANI aylanib o'tishga yo'l bermaydi", () => {
  fresh();
  rec.open('g1');
  let wrote = 0, oxirgi = null;
  for (let i = 0; i < 60; i++) {
    // Har safar YANGI bo'lak raqami — eski xatoda bu kvotani nolga qaytarardi
    const r = rec.append('g1', 'u1', buf(200 * 1024), 'webm', i);
    if (!r.ok) { oxirgi = r.code; break; }
    wrote += 200 * 1024;
  }
  assert.equal(oxirgi, 'userFull', 'kvota ishlamadi, kod: ' + oxirgi);
  assert.ok(wrote <= rec.LIMITS.maxUserMb * 1024 * 1024,
    "kvota aylanib o'tildi: " + Math.round(wrote / 1024) + ' KB');
});

test("bo'lak raqami xavfli qiymatda ham faylni katalogdan chiqarmaydi", () => {
  fresh();
  rec.open('g1');
  for (const bad of ['../x', -5, 1e9, NaN, '2; rm -rf /']) {
    rec.append('g1', 'u1', buf(50), 'webm', bad);
  }
  for (const f of rec.files('g1')) {
    assert.ok(/^u1(\.\d+)?\.webm$/.test(f.name), 'kutilmagan fayl: ' + f.name);
  }
});

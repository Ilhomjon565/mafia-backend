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

test("nom tozalangani uchun begona katalogga yozilmaydi", () => {
  fresh();
  rec.open('g1');
  rec.append('g1', '../../qochdi', buf(50));
  // Fayl faqat o'yin katalogida bo'lishi kerak
  const inside = fs.readdirSync(path.join(TMP, 'g1'));
  assert.equal(inside.length, 1);
  assert.ok(!inside[0].includes('/') && !inside[0].includes('\\'));
  assert.equal(fs.existsSync(path.join(TMP, 'qochdi.webm')), false);
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

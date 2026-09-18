# E2E sinovlari (yozuv, shikoyat, jazo)

`npm test` sof modullarni tekshiradi. Bu yerdagi ikki skript esa **haqiqiy
serverga** qarshi ishlaydi: haqiqiy socket ulanishlari, haqiqiy oʻyin, haqiqiy
fayllar. Ular birinchi ishga tushirilganda **uchta haqiqiy nuqson** topgan
(pastda).

## Nima tekshiriladi

**`01-yozuv-shikoyat-jazo.mjs`** (43 ta tekshiruv)
- Oʻyin boshlanishi bilan yozuv katalogi ochiladi
- Ovoz boʻlagi va gap vaqtlari qabul qilinadi
- Shikoyat: qabul qilinadi · bir odamga ikkinchi marta **rad etiladi** ·
  boshqa odamga **oʻtadi**
- Shikoyatli oʻyin yozuvi **saqlanadi**: `game.json` (chat, jurnal, rollar,
  gʻolib), `reports.json`, ovoz fayli, gap vaqtlari
- Admin dalilni ocha oladi, ovoz fayli **oʻyinchiga bogʻlanadi**, faylni
  yuklab olish ishlaydi, yoʻl boʻylab chiqib ketish toʻsiladi
- **Shikoyatsiz** oʻyin yozuvi oʻchiriladi, shikoyatlisi esa qoladi
- Jazolar: chat / ovoz / rasm — qoʻyiladi, **darhol** kuchga kiradi, olib
  tashlanadi

**`02-chegaralar.mjs`** (18 ta tekshiruv)
- Kunlik chegara: 21-chi odamga shikoyat rad etiladi; boshqa foydalanuvchining
  chegarasi tegilmaydi
- **Oʻyin tugagandan keyin** (natija ekranidan) kelgan shikoyat yozuvni
  saqlab qoladi
- Disk kvotasi: chegaraga yetganda `507`, boshqa oʻyinchi taʼsirlanmaydi,
  juda katta boʻlak rad etiladi, **oʻyinning oʻzi buzilmaydi**

**`03-reyting-moslashtirish.mjs`** (15 ta tekshiruv)
- Tez o‘yin har kimni O‘Z ligasiga tushiradi; xona reytingi yangi
  o‘yinchi bilan yangilanadi; odamsiz xona hammaga bir xil mos
- **Talab:** `E2E_PSQL` — toza ulanish satri (`?schema=` BO‘LMASIN, psql uni
  qabul qilmaydi; skript SQL ichida `SET search_path TO mafia_test` qiladi)

**`04-shikoyat-bot.mjs`** (17 ta tekshiruv) — **`BOT_FILL=1` talab qiladi**
- Botga qilingan shikoyat odamnikidan AYNAN farq qilmaydi (bot detektori yo‘q)
- Bot shikoyati adminga yozilmaydi, lekin kunlik hisobga kiradi
- **Tez o‘yin sanoq boshlangan xonani bermaydi** (odam "goo" yozadi →
  server 7-13 soniyalik sanoqni quradi → shu oynada `/api/games/quick`
  o‘sha xonani qaytarmasligi kerak)

**`05-audit2.mjs`** (22 ta tekshiruv)
- **Chat takrori** qoidasi ishlaydi (ilgari `g.chatRecent` saqlanmasdi)
- **Raqam ro‘yxati** ("1 2 3 4 5 6 7 8 9") telefon deb hisoblanmaydi
- **Yozuv bo‘laklari**: `X-Rec-Seg` bilan har qayta boshlash ALOHIDA faylga
  (`kalit.2.webm`), har fayl aynan bitta bo‘lak — sarlavhalar qo‘shilmaydi;
  admin dalilida uchalasi BITTA o‘yinchiga bog‘lanadi
- **Kunlik chegara atomik**: bir vaqtda yuborilgan 6 ta shikoyatdan AYNAN
  bittasi o‘tadi; 21-chi nishonda to‘plam hajmi 20 da qoladi
- **O‘lgan o‘yinchiga** shikoyat qabul qilinadi

**`06-mafiya-kelishuv.mjs`** (6 ta tekshiruv)
- Odam mafiya A ni bosib, darhol B ga o‘tsa, bot sherigi **JORIY** tanlovga
  (B) qo‘shiladi — ilgari taymerga eski nishon yopilib qolardi va mafiya
  kelisha olmasdi
- "Botlar bilan o‘ynash" xonasi ishlatiladi (bir zumda to‘ladi); odam mafiya
  bo‘lguncha bir necha o‘yin sinab ko‘riladi (`E2E_URINISH`, sukut 16)
- Kecha bosqichi ikkinchi ovozdan oldin yopilsa sinov YIQITILMAYDI —
  keyingi o‘yinga o‘tiladi (sharti qurilmagan hisoblanadi)

## Qanday ishga tushirish

Sinov **ALOHIDA** nusxaga qarshi ishlashi shart: boshqa port, boshqa Redis DB
va boshqa Postgres schema.

> **DIQQAT:** `/srv/mafia/backend/.env` — production `backend.env` ga symlink,
> `dotenv` esa `override: true` bilan ishlaydi. Shu sababli sinovni oʻsha
> katalogdan ishga tushirib boʻlmaydi — u sizning env'ingizni bosib, PRODUCTION
> Redis va Postgres'ga ulanib ketadi. Nusxa koʻchirib, `.env`siz ishga tushiring.

```bash
# 1) izolyatsiya qilingan nusxa (.env YO'Q)
rm -rf /srv/mafia/backend-e2e && mkdir -p /srv/mafia/backend-e2e /srv/mafia/rec-test
cp /srv/mafia/backend/*.js /srv/mafia/backend/*.mjs /srv/mafia/backend/package.json /srv/mafia/backend-e2e/
cp -r /srv/mafia/backend/prisma /srv/mafia/backend-e2e/
ln -s /srv/mafia/backend/node_modules /srv/mafia/backend-e2e/node_modules

# 2) alohida schema
RAW=$(grep -oP '^DATABASE_URL=\K.*' /srv/mafia/backend.env | tr -d '"' | sed 's/?.*//')
psql "$RAW" -c 'CREATE SCHEMA IF NOT EXISTS mafia_test'
cd /srv/mafia/backend-e2e && DATABASE_URL="${RAW}?schema=mafia_test" npx prisma db push --accept-data-loss --skip-generate

# 3) sinov sozlamalari: parol bilan register OCHIQ + fazalar qisqa
redis-cli -n 9 set settings:global '{"allowPasswordAuth":true,"maxSignupsPerIpHour":500,"minPlayers":5,"dailyRoomLimit":20,"durations":{"day_discussion":9,"day_results":3,"night":6,"night_mafia":5,"night_komissar":4,"night_doctor":4,"night_sheriff":4,"night_escort":4,"night_advokat":4,"night_qotil":4,"night_daydi":4,"night_skip":1,"night_results":3}}'

# 4) sinov nusxasini ko'taramiz
DATABASE_URL="${RAW}?schema=mafia_test" REDIS_DB=9 PORT=4199 BIND_HOST=127.0.0.1 \
JWT_SECRET=e2e-sinov-uchun-uzun-maxfiy-kalit-12345 ADMIN_ACCESS_KEY=e2ekey \
RECORD_DIR=/srv/mafia/rec-test RECORD_GRACE_MS=30000 VOICE_RECORD=1 \
BOT_FILL=0 BOT_GAMES=0 FAKE_ONLINE=0 nohup node server.js > /tmp/e2e-server.log 2>&1 &

# 5) admin hisobi (birinchi foydalanuvchi avtomatik admin bo'lmasa qo'lda)
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"username":"e2e_admin","password":"e2e-parol-12345"}' http://127.0.0.1:4199/api/register
psql "$RAW" -c 'SET search_path TO mafia_test; UPDATE "User" SET "isAdmin"=true WHERE username=$$e2e_admin$$'

# 6) skriptlar socket.io-client ni talab qiladi — frontend node_modules'idan ishga tushiriladi
cp e2e/*.mjs /srv/mafia/frontend/
cd /srv/mafia/frontend
E2E_API=http://127.0.0.1:4199 E2E_REC=/srv/mafia/rec-test E2E_ADMIN_KEY=e2ekey node 01-yozuv-shikoyat-jazo.mjs
E2E_API=http://127.0.0.1:4199 E2E_REC=/srv/mafia/rec-test E2E_ADMIN_KEY=e2ekey node 02-chegaralar.mjs
E2E_API=http://127.0.0.1:4199 E2E_REC=/srv/mafia/rec-test E2E_ADMIN_KEY=e2ekey \
  E2E_REDIS="redis-cli -n 9" node 05-audit2.mjs

# 03 uchun psql ulanish satri (?schema= BO‘LMAGAN holda!)
E2E_API=http://127.0.0.1:4199 E2E_PSQL="$RAW" E2E_ADMIN_KEY=e2ekey node 03-reyting-moslashtirish.mjs

# 04 va 06 uchun serverni BOT_FILL=1 bilan qayta ko‘tarish kerak
# (06 "botlar bilan o‘ynash" xonasidan foydalanadi — unga BOT_FILL shart emas,
#  lekin ikkalasini ketma-ket ishga tushirish qulay)
E2E_API=http://127.0.0.1:4199 E2E_REDIS="redis-cli -n 9" node 04-shikoyat-bot.mjs
E2E_API=http://127.0.0.1:4199 E2E_ADMIN_KEY=e2ekey E2E_URINISH=24 node 06-mafiya-kelishuv.mjs
```

**Tozalash (shart):**
```bash
kill $(ss -ltnp | grep ':4199' | grep -oP 'pid=\K[0-9]+')
psql "$RAW" -c 'DROP SCHEMA IF EXISTS mafia_test CASCADE'
redis-cli -n 9 flushdb
rm -rf /srv/mafia/backend-e2e /srv/mafia/rec-test /srv/mafia/frontend/0*.mjs /tmp/e2e-*
```

## Birinchi ishga tushirishda topilgan nuqsonlar

1. **Ovoz fayli oʻyinchiga bogʻlanmasdi** — admin dalilni ochganda ovoz egasi
   `?` boʻlib koʻrinardi, yaʼni dalil amalda yaroqsiz edi. Sabab: fayl nomi
   `publicId || userId`, `game.json` dagi id esa `publicId || socketId`.
   Botda `publicId` bor, haqiqiy oʻyinchida yoʻq — yaʼni nomuvofiqlik aynan
   dalil kerak boʻlgan yagona holatda yuzaga kelardi.
2. **Telefon filtri juda tor edi** (7 ta raqam) — oʻyindagi oddiy uzun son
   (sana, hisob, xona raqami) bloklanardi va sinovda chat butunlay dalilga
   tushmay qoldi. Oʻzbekiston raqami 9 xonali, chegara shunga moslandi.
3. Sinovning oʻzida: `RECORD_GRACE_MS` kodda kamida 30 soniya
   (`Math.max(30000, ...)`), sinov esa 12 soniya kutardi.

# mafia-backend

Mafia oʻyini uchun backend — Express + Socket.io + Prisma (PostgreSQL) + Redis.

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `server.js` | HTTP/Socket qatlami, oʻyin dvigateli, admin API, Telegram integratsiyasi |
| `rules.js` | **Oʻyin qoidalarining sof mantiqi** — IOʻsiz, test qilinadi |
| `rules.test.mjs` | Qoidalar testlari (`npm test`) |
| `ROLES.md` | Rollar va qoidalar hujjati (source of truth) |
| `watchdog.js` | Servis tirikligini kuzatuvchi |
| `prisma/schema.prisma` | Maʼlumotlar bazasi sxemasi |

`rules.js` ataylab sof saqlanadi: unda Redis, Prisma yoki socket yoʻq. Shu sababli
gʻalaba shartlari, rol balansi va tungi bosqichlar mantiqi to'g'ridan-to'g'ri
sinovdan oʻtkaziladi — qoidalarni oʻzgartirsangiz avval `npm test` ni ishga tushiring.

## Ishga tushirish (production, serverda)

```bash
git clone https://github.com/Ilhomjon565/mafia-backend.git
cd mafia-backend
npm ci
cp .env.example .env   # qiymatlarni toʻgʻrilang
npx prisma generate
npx prisma migrate deploy
pm2 start server.js --name mafia-backend
```

## Testlar

```bash
npm test          # rules.js — 39 ta qoida testi
node --check server.js
```

## .env

| Oʻzgaruvchi | Tavsif |
|---|---|
| `PORT` | Server porti (masalan 4100) |
| `BIND_HOST` | Tinglash manzili (nginx ortida `127.0.0.1`) |
| `DATABASE_URL` | PostgreSQL ulanish satri |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` | Redis manzili va DB indeksi |
| `JWT_SECRET` | JWT imzo kaliti (maxfiy) |
| `FRONTEND_URL` | Sayt manzili (havolalar uchun) |
| `GOOGLE_CLIENT_ID` | Google Sign-In client ID |
| `ADMIN_ACCESS_KEY` | Admin panelni yashiradigan maxfiy kalit |
| `TG_ADMIN_BOT_TOKEN` / `TG_ADMIN_CHAT_ID` | Admin kirishini Telegram orqali tasdiqlash |
| `TG_GROUP_CHAT_ID` / `TG_GROUP_LINK` | Yangi xona eʼlonlari uchun guruh |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | Cloudflare TURN (ovozli chat) |

### Oʻyin yozuvlari (shikoyat uchun dalil)

Shikoyat kelgan oʻyinning ovozli chati, matnli chati va toʻliq tarixi
saqlanadi. **Shikoyatsiz oʻyin yozuvi oʻyin tugagach oʻchiriladi** — disk
toʻlib qolmasligi uchun.

| Oʻzgaruvchi | Sukut | Tavsif |
|---|---|---|
| `VOICE_RECORD` | `1` | `0` — ovoz yozuvini butunlay oʻchiradi |
| `RECORD_DIR` | `/srv/mafia/recordings` | Yozuvlar katalogi |
| `RECORD_MAX_MB` | `1500` | UMUMIY chegara; oshsa yangi yozuv boshlanmaydi va eng eskisi oʻchadi |
| `RECORD_GAME_MB` | `30` | Bitta oʻyin uchun chegara |
| `RECORD_USER_MB` | `6` | Bitta oʻyinchi uchun chegara |
| `RECORD_KEEP_DAYS` | `14` | Shikoyatli yozuv shuncha kun saqlanadi |
| `RECORD_GRACE_MS` | `180000` | Shikoyatsiz yozuv shuncha vaqtdan keyin oʻchadi (natija ekranidan ham shikoyat qilish mumkin) |
| `REPORT_DAILY` | `20` | Bitta odam kuniga nechta TURLI oʻyinchiga shikoyat qila oladi |

**Hajm hisobi.** Yozuv faqat gapirilayotgan paytda ishlaydi (push-to-talk) va
bitrate 16 kbit/s: 20 daqiqalik oʻyinda odam odatda 2-4 daqiqa gapiradi, yaʼni
~300-500 KB. 12 kishilik oʻyin ≈ 4-6 MB. Shikoyatlar kam boʻlgani uchun
amaldagi hajm chegaradan ancha past qoladi. Holatni koʻrish:
`curl 'localhost:4100/health?key=<kalit>'` → `yozuvlar` boʻlimi.

**Botlar oʻyinlari yozilmaydi** (`botOnly`, `vsBots`): u yerda shikoyat
qiladigan ham, shikoyat qilinadigan ham yoʻq — sof disk isrofi boʻlardi.

### Himoya chegaralari (ixtiyoriy)

| Oʻzgaruvchi | Sukut | Tavsif |
|---|---|---|
| `SOCKET_REQUIRE_AUTH` | `1` | Tokensiz socket ulanishini rad etish |
| `MAX_TOTAL_SOCKETS` | `3000` | Serverdagi ochiq socketlar chegarasi |
| `MAX_CONN_PER_IP` | `30` | Bitta IP dan ochiq ulanishlar |
| `MAX_HANDSHAKE_PER_IP` | `60` | 10 soniyada ulanish urinishlari |
| `IDLE_SOCKET_MS` | `120000` | Oʻyinga kirmagan socket qancha yashaydi |

## Yangilash

Serverda bitta skript hammasini qiladi (git pull → npm ci → prisma db push →
pm2 restart):

```bash
/srv/mafia/deploy.sh backend      # yoki: frontend | all
```

Qoʻlda qilinganda:

```bash
git pull
npm ci
npx prisma db push          # DIQQAT: `migrate deploy` EMAS
npm test                    # deploy darvozasi — 242 ta test
pm2 restart mafia-backend
```

> **Nega `db push`:** repodagi migratsiyalar `schema.prisma` dan orqada
> (drift bor), shuning uchun `migrate deploy` yiqiladi. Drift tuzatilsa
> `migrate deploy` ga qaytish mumkin.

> **Nega `npm test` majburiy:** oʻyin qoidalari, bot xulqi, chat filtri va
> soxta xonalarning “bot ekani koʻrinmasin” shartlari aynan shu testlar bilan
> qulflangan. Ular yiqilsa deploy qilinmaydi.

## Redis kalitlari

| Kalit | Mazmuni |
|---|---|
| `game:<id>` | Oʻyin holati (TTL 24 soat) |
| `chat:<id>` | Chat tarixi — qayta ulanishda tiklanadi (oxirgi 200 ta) |
| `rooms:created:<userId>:<kun>` | Kunlik xona hisobi (xona oʻchirilsa ham kamaymaydi, TTL 36 soat) |
| `reports` | Oʻyinchilarning shikoyatlari (oxirgi 500 ta) |
| `admin:audit` | Admin choralari jurnali: ban, admin berish, hisob oʻchirish (oxirgi 1000 ta) |
| `rep:by:<userId>:<kun>` | Kim kimga shikoyat qilgani — kunlik chegara (bitta odamga 1 marta, kuniga 20 ta odam) |
| `rep:game:<gameId>` | Shu oʻyin shikoyatlari; mavjudligi YOZUV SAQLANISHI belgisi |
| `penalty:<userId>` | Amaldagi jazolar: `chat`, `voice`, `avatar` → tugash vaqti |
| `banned:users` | Bloklangan hisoblar keshi |
| `presence:auth` / `presence:anon` | Onlayn qurilmalar |
| `settings:global` | Admin sozlamalari |
| `roomlimits` | Foydalanuvchi boʻyicha kunlik xona limiti |
| `cache:games` / `cache:pubstats` | Qisqa muddatli keshlar |

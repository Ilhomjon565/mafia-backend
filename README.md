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

### Himoya chegaralari (ixtiyoriy)

| Oʻzgaruvchi | Sukut | Tavsif |
|---|---|---|
| `SOCKET_REQUIRE_AUTH` | `1` | Tokensiz socket ulanishini rad etish |
| `MAX_TOTAL_SOCKETS` | `3000` | Serverdagi ochiq socketlar chegarasi |
| `MAX_CONN_PER_IP` | `30` | Bitta IP dan ochiq ulanishlar |
| `MAX_HANDSHAKE_PER_IP` | `60` | 10 soniyada ulanish urinishlari |
| `IDLE_SOCKET_MS` | `120000` | Oʻyinga kirmagan socket qancha yashaydi |

## Yangilash

```bash
git pull
npm ci
npx prisma migrate deploy
npm test                    # qoidalar buzilmaganini tekshirish
pm2 restart mafia-backend
```

## Redis kalitlari

| Kalit | Mazmuni |
|---|---|
| `game:<id>` | Oʻyin holati (TTL 24 soat) |
| `chat:<id>` | Chat tarixi — qayta ulanishda tiklanadi (oxirgi 200 ta) |
| `banned:users` | Bloklangan hisoblar keshi |
| `presence:auth` / `presence:anon` | Onlayn qurilmalar |
| `settings:global` | Admin sozlamalari |
| `roomlimits` | Foydalanuvchi boʻyicha kunlik xona limiti |
| `cache:games` / `cache:pubstats` | Qisqa muddatli keshlar |

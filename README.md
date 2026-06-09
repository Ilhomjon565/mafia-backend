# mafia-backend

Mafia o'yini uchun backend — Express + Socket.io + Prisma (PostgreSQL) + Redis.

## Ishga tushirish (production, serverda)

```bash
git clone https://github.com/Ilhomjon565/mafia-backend.git
cd mafia-backend
npm ci
cp .env.example .env   # qiymatlarni to'g'rilang
npx prisma generate
npx prisma migrate deploy
pm2 start server.js --name mafia-backend
```

## .env

| O'zgaruvchi | Tavsif |
|---|---|
| `PORT` | Server porti (masalan 4100) |
| `DATABASE_URL` | PostgreSQL ulanish satri |
| `REDIS_HOST` / `REDIS_PORT` | Redis manzili |
| `JWT_SECRET` | JWT imzo kaliti (maxfiy) |
| `FRONTEND_URL` | CORS uchun frontend manzili |

## Yangilash

```bash
git pull
npm ci
npx prisma migrate deploy
pm2 restart mafia-backend
```

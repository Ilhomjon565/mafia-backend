// Boshlang'ich sozlash: eskirgan xonalarni tozalash + admin hisobini tayyorlash.
//
// MUHIM: admin paroli KODDA SAQLANMAYDI. Uni `SEED_ADMIN_PASSWORD` env orqali bering,
// aks holda skript kuchli tasodifiy parol yaratib bir marta chop etadi.
// (Ilgari bu yerda 'admin123' qattiq yozilgan edi — reponi ko'rgan har kim
// admin panelga kira olardi.)

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function genPassword() {
  // 24 belgi, o'qish oson alifbo (o'xshash belgilarsiz)
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

async function main() {
  // 1) eskirgan/stale aktiv o'yinlarni tugatilgan deb belgilash
  const stale = await prisma.game.updateMany({
    where: { status: { in: ['waiting', 'playing'] } },
    data: { status: 'finished', endedAt: new Date() },
  });
  console.log(`🧹 Tozalandi: ${stale.count} ta eskirgan xona`);

  // 2) admin foydalanuvchi
  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const provided = process.env.SEED_ADMIN_PASSWORD;
  const exists = await prisma.user.findUnique({ where: { username } });

  if (exists && !provided) {
    // Parol berilmagan va hisob bor — parolga TEGMAYMIZ, faqat huquqni tiklaymiz
    await prisma.user.update({ where: { id: exists.id }, data: { isAdmin: true, isBanned: false } });
    console.log(`👑 Admin huquqi tiklandi: ${username} (parol o'zgarmadi)`);
  } else {
    const password = provided || genPassword();
    const hash = await bcrypt.hash(password, 10);
    const admin = await prisma.user.upsert({
      where: { username },
      update: { password: hash, isAdmin: true, isBanned: false },
      create: {
        username,
        email: `${username}@mafia.local`,
        password: hash,
        isAdmin: true,
        stats: { create: {} },
      },
    });
    console.log(`👑 Admin tayyor: username=${username} (id=${admin.id})`);
    if (!provided) {
      console.log('─'.repeat(58));
      console.log(`🔑 YARATILGAN PAROL (faqat shu safar ko'rsatiladi):\n   ${password}`);
      console.log('   Uni parol menejeriga saqlang — qayta tiklab bo\'lmaydi.');
      console.log('─'.repeat(58));
    }
  }

  // 3) hech qanday admin qolmagan bo'lsa — birinchi foydalanuvchini admin qilamiz
  const adminCount = await prisma.user.count({ where: { isAdmin: true } });
  if (adminCount === 0) {
    const first = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (first) {
      await prisma.user.update({ where: { id: first.id }, data: { isAdmin: true } });
      console.log(`👑 Admin yo'q edi — birinchi foydalanuvchi admin qilindi: ${first.username}`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });

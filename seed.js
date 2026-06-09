import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // 1) eskirgan/stale aktiv o'yinlarni tugatilgan deb belgilash
  const stale = await prisma.game.updateMany({
    where: { status: { in: ['waiting', 'playing'] } },
    data: { status: 'finished', endedAt: new Date() }
  });
  console.log(`🧹 Tozalandi: ${stale.count} ta eskirgan xona`);

  // 2) admin foydalanuvchi yaratish/yangilash
  const hash = await bcrypt.hash('admin123', 8);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: { isAdmin: true, isBanned: false },
    create: {
      username: 'admin',
      email: 'admin@mafia.local',
      password: hash,
      isAdmin: true,
      stats: { create: {} }
    }
  });
  console.log(`👑 Admin tayyor: username=admin parol=admin123 (id=${admin.id})`);

  // 3) mavjud birinchi foydalanuvchini ham admin qilish (qulaylik uchun)
  const first = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (first && first.username !== 'admin') {
    await prisma.user.update({ where: { id: first.id }, data: { isAdmin: true } });
    console.log(`👑 Birinchi foydalanuvchi ham admin qilindi: ${first.username}`);
  }
}

main().then(() => prisma.$disconnect()).catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });

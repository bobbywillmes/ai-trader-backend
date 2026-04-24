import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const tickers = await prisma.allowedTicker.findMany();
  console.log(tickers);
  const settings = await prisma.setting.findMany();
  console.log(settings);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
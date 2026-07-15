import { prisma } from '../db/prisma.js';

export async function getStrategies() {
  return prisma.strategy.findMany({
    orderBy: { key: 'asc' },
  });
}

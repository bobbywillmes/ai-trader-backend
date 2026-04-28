import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export async function getStrategies() {
  return prisma.strategy.findMany({
    orderBy: { key: 'asc' }
  });
}

export async function getExitProfiles() {
  return prisma.exitProfile.findMany({
    orderBy: { key: 'asc' }
  });
}

export async function getSubscriptions() {
  return prisma.subscription.findMany({
    orderBy: { key: 'asc' },
    include: {
      strategy: true,
      exitProfile: true
    }
  });
}

export async function getSubscriptionByKey(key: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { key },
    include: {
      strategy: true,
      exitProfile: true
    }
  });

  if (!subscription) {
    throw new HttpError(404, `Subscription ${key} was not found.`);
  }

  return subscription;
}
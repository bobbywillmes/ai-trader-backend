import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export async function assertSecurityTradingEnabled(symbol: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const security = await prisma.security.findUnique({
    where: { symbol: normalizedSymbol },
    select: {
      id: true,
      symbol: true,
      name: true,
      enabled: true,
    },
  });

  if (!security) {
    throw new HttpError(
      400,
      `Security ${normalizedSymbol} is not registered for trading.`
    );
  }

  if (!security.enabled) {
    throw new HttpError(
      409,
      `Security ${normalizedSymbol} is disabled for trading.`
    );
  }

  return security;
}
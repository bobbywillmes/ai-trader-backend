import { prisma } from '../db/prisma.js';
import type { AssetType } from '@prisma/client';


export async function findSecurity(symbol: string) {
  // Normalize symbol to uppercase and trim whitespace
  const normalizedSymbol = symbol.trim().toUpperCase();

  const security = await prisma.security.findUnique({
    where: {  symbol: normalizedSymbol },
    include: {
      subscriptions: {
        orderBy: { key: 'asc' }
      },
    }
  });

  return security;
}

export async function getAllSecurities() {
  const securities = await prisma.security.findMany({
    orderBy: { symbol: 'asc' }
  });

  return securities;
}

export async function addSecurity(symbol: string, name: string, assetType: AssetType, sector: string, industry: string  ) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedName = name.trim();
  const normalizedAssetType = assetType.trim().toUpperCase() as AssetType;

  const security = await prisma.security.upsert({
    where: { symbol: normalizedSymbol },
    update: {},
    create: {
      symbol: normalizedSymbol,
      name: normalizedName,
      assetType: normalizedAssetType,
      sector: sector?.trim(),
      industry: industry?.trim()
    }
  });
  return security;
}

export async function updateSecurity(symbol: string, name: string, enabled: boolean, assetType: AssetType, sector: string, industry: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedName = name.trim();
  const security = await prisma.security.update({
    where: { symbol: normalizedSymbol },
    data: { name: normalizedName, enabled, assetType, sector: sector?.trim(), industry: industry?.trim() }
  });
  return security;
}
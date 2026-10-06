import { Prisma } from '@prisma/client';
import type { TiingoBar } from '../integrations/tiingo/rest.client.js';

const price = (value: number) => {
  const decimal = new Prisma.Decimal(value).toDecimalPlaces(10);
  if (decimal.lte(0) || decimal.gte('1000000000000')) throw new Error('Invalid Tiingo minute price precision.');
  return decimal.toFixed(10);
};
const quantity = (value: number) => {
  const decimal = new Prisma.Decimal(value).toDecimalPlaces(6);
  if (decimal.lt(0) || decimal.gte('100000000000000000000')) throw new Error('Invalid Tiingo minute volume precision.');
  return decimal;
};

/** A missing, duplicate, or off-grid minute makes its entire 15-minute window unavailable. */
export function aggregateTiingoMinuteWindow(rows: readonly TiingoBar[], start: Date) {
  const from = start.getTime();
  const window = rows.filter(row => row.barStartAt.getTime() >= from && row.barStartAt.getTime() < from + 900_000)
    .sort((a, b) => a.barStartAt.getTime() - b.barStartAt.getTime());
  if (window.length !== 15 || window.some((row, index) => row.barStartAt.getTime() !== from + index * 60_000)) return null;
  const values = window.map(row => ({ open: new Prisma.Decimal(price(row.open)), high: new Prisma.Decimal(price(row.high)),
    low: new Prisma.Decimal(price(row.low)), close: new Prisma.Decimal(price(row.close)), volume: quantity(row.volume) }));
  return { barStartAt: start, open: values[0]!.open.toFixed(10), high: Prisma.Decimal.max(...values.map(v => v.high)).toFixed(10),
    low: Prisma.Decimal.min(...values.map(v => v.low)).toFixed(10), close: values[14]!.close.toFixed(10),
    volume: values.reduce((sum, value) => sum.plus(value.volume), new Prisma.Decimal(0)).toFixed(6) };
}

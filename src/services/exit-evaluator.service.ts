import { prisma } from '../db/prisma.js';
import { closePosition } from './close-position.service.js';
import { createSystemEvent } from './system-event.service.js';

export async function evaluateExits() {
  const openPositions = await prisma.trackedPosition.findMany({
    where: { status: 'open' },
    include: {
      subscription: {
        include: {
          exitProfile: true,
        },
      },
    },
  });

  for (const position of openPositions) {
    const exitProfile = position.subscription?.exitProfile;

    if (!exitProfile) continue;

    const pnlPct = position.unrealizedPnLPct ?? 0;

    let shouldExit = false;
    let reason = '';

    // Take profit
    if (
      exitProfile.targetPct &&
      pnlPct >= exitProfile.targetPct / 100
    ) {
      shouldExit = true;
      reason = 'take_profit';
    }

    // Stop loss
    if (
      exitProfile.stopLossPct &&
      pnlPct <= -(exitProfile.stopLossPct / 100)
    ) {
      shouldExit = true;
      reason = 'stop_loss';
    }

    if (!shouldExit) continue;

    console.log(
      `Exit triggered for ${position.symbol} (${reason})`
    );

    await closePosition(position.symbol);

    await createSystemEvent({
      type: 'exit.triggered',
      entityType: 'trackedPosition',
      entityId: position.id,
      payloadJson: {
        symbol: position.symbol,
        reason,
        pnlPct,
      },
    });
  }
}
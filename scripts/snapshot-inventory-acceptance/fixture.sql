INSERT INTO "User" (email, "platformRole", "createdAt", "updatedAt")
VALUES ('synthetic@example.invalid', 'SYSTEM_OWNER', now(), now())
ON CONFLICT (email) DO NOTHING;

INSERT INTO "TradingAccount" (
  "accountHolderUserId", "displayName", environment, status,
  "brokerAccountId", "createdAt", "updatedAt"
)
SELECT id, 'Synthetic', 'PAPER', 'ACTIVE', 'synthetic-broker-account', now(), now()
FROM "User" WHERE email = 'synthetic@example.invalid'
ON CONFLICT ("accountHolderUserId", broker, environment) DO NOTHING;

INSERT INTO "Security" (symbol, name, "assetType", "createdAt", "updatedAt")
SELECT 'SYN' || n, 'Synthetic ' || n, 'STOCK', now(), now()
FROM generate_series(1, 7) n
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO "TrackedPosition" (
  broker, symbol, side, qty, "avgEntryPrice", "currentPrice", "marketValue",
  "costBasis", "unrealizedPnL", "unrealizedPnLPct", status, "rawPositionJson",
  "securityId", "tradingAccountId", "createdAt", "updatedAt"
)
SELECT 'alpaca', s.symbol, 'long', 1, 10, 10, 10, 10, 0, 0,
  CASE WHEN s.symbol = 'SYN7' THEN 'closed' ELSE 'open' END, '{}'::jsonb, s.id, a.id, now(), now()
FROM "Security" s
CROSS JOIN "TradingAccount" a
WHERE s.symbol LIKE 'SYN_' AND a."displayName" = 'Synthetic';

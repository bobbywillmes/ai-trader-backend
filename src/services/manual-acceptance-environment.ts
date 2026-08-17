export const MANUAL_ACCEPTANCE_SENTINEL = 'I_UNDERSTAND_THIS_IS_SYNTHETIC';
export const MANUAL_ACCEPTANCE_ENTRYPOINT = 'scripts/manual-acceptance/server.ts';
export const MANUAL_ACCEPTANCE_DATABASE = 'ai_trader_live_entry_acceptance';
export const MANUAL_ACCEPTANCE_UI_ORIGIN = 'http://localhost:5173';

export function isIsolatedManualAcceptanceEnvironment(input: {
  sentinel: string | undefined;
  entrypoint: string | undefined;
  databaseUrl: string;
  allowedOrigins: readonly string[];
}) {
  if (
    input.sentinel !== MANUAL_ACCEPTANCE_SENTINEL ||
    input.entrypoint !== MANUAL_ACCEPTANCE_ENTRYPOINT ||
    input.allowedOrigins.length !== 1 ||
    input.allowedOrigins[0] !== MANUAL_ACCEPTANCE_UI_ORIGIN
  ) {
    return false;
  }

  try {
    const databaseUrl = new URL(input.databaseUrl);
    return databaseUrl.pathname === `/${MANUAL_ACCEPTANCE_DATABASE}`;
  } catch {
    return false;
  }
}

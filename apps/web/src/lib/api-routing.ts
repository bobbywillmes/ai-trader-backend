const ACCEPTANCE_MODE = "acceptance";

export function resolveApiBaseUrl(mode: string, configuredBaseUrl: string | undefined) {
  const baseUrl = configuredBaseUrl?.trim() ?? "";

  if (mode === ACCEPTANCE_MODE && baseUrl !== "") {
    throw new Error(
      "Acceptance mode requires an empty VITE_API_BASE_URL so requests use the same-origin /api proxy.",
    );
  }

  return baseUrl;
}

export function assertAcceptanceApiRouting(
  mode: string,
  apiBaseUrl: string,
  browserOrigin: string,
) {
  if (mode !== ACCEPTANCE_MODE) {
    return;
  }

  if (apiBaseUrl !== "") {
    throw new Error("Acceptance API routing must be same-origin.");
  }

  const origin = new URL(browserOrigin);
  const allowedHost = origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
  if (origin.protocol !== "http:" || !allowedHost || origin.port !== "5174") {
    throw new Error(`Acceptance frontend origin rejected: ${origin.origin}`);
  }

  const apiDestination = new URL("/api", origin);
  if (apiDestination.origin !== origin.origin) {
    throw new Error("Acceptance API destination escaped the frontend origin.");
  }
}

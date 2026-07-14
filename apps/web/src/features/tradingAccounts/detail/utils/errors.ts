import { ApiError } from "../../../../lib/api";

export function actionableErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.data && typeof error.data === "object") {
    const details = "details" in error.data ? error.data.details : null;
    if (details && typeof details === "object" && "violations" in details) {
      const violations = Array.isArray(details.violations)
        ? details.violations
        : [];
      const messages = violations.flatMap((item) =>
        item &&
        typeof item === "object" &&
        "message" in item &&
        typeof item.message === "string"
          ? [item.message]
          : []
      );
      if (messages.length > 0) return messages.join(" ");
    }
  }
  return error instanceof Error ? error.message : fallback;
}

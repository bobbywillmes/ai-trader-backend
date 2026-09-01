// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemainingExposureClosePanel } from "./RemainingExposureClosePanel";
import type { RemainingExposureClosePreview } from "./types";

const preview: RemainingExposureClosePreview = {
  attentionId: 4,
  revision: 7,
  status: "OPEN",
  severity: "ERROR",
  tradingAccount: { id: 2, displayName: "Bobby Paper", environment: "PAPER" },
  trackedPositionId: 11,
  securityId: 3,
  symbol: "SPY",
  trackedQuantity: "4",
  attributedExitFilledQuantity: "2",
  expectedRemainingQuantity: "2",
  brokerPosition: { side: "long", heldQuantity: "2", availableQuantity: "2" },
  activeOrders: [],
  marketSession: { marketOpen: true, fetchedAt: "2026-08-29T18:00:00Z" },
  deploymentAuthority: { role: "OBSERVATION_ONLY", canWrite: true },
  liveRiskReducingAuthorization: null,
  eligible: true,
  canExecute: true,
  observedAt: "2026-08-29T18:00:00Z",
  validUntil: "2026-08-29T18:00:30Z",
  previewFingerprint: "fingerprint",
  blockingReasons: [],
  explanation: "Eligible",
  nextAction: "Confirm",
};
afterEach(cleanup);
describe("remaining exposure close panel", () => {
  it("shows the exact equation without an editable quantity and confirms explicit sell-to-close behavior", async () => {
    const confirm = vi.fn();
    render(
      <MantineProvider>
        <MemoryRouter>
          <RemainingExposureClosePanel
            preview={preview}
            pending={false}
            error={null}
            onConfirm={confirm}
          />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(
      screen.getByText("Tracked quantity:").parentElement?.textContent,
    ).toContain("4");
    expect(
      screen.getByText("Previously sold and attributed:").parentElement
        ?.textContent,
    ).toContain("2");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Close remaining 2 shares" }));
    expect(
      screen.getByText(
        /market sell-to-close order for the entire remaining broker position/,
      ),
    ).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Confirm corrective close" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("presents exact blockers and no execution control to operators", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <RemainingExposureClosePanel
            preview={{
              ...preview,
              eligible: false,
              canExecute: false,
              blockingReasons: [
                {
                  code: "REGULAR_SESSION_CLOSED",
                  message: "Regular session closed",
                  nextAction: "Wait for the regular session.",
                },
              ],
            }}
            pending={false}
            error={null}
            onConfirm={vi.fn()}
          />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(screen.getByText("Regular session closed")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Close remaining/ }),
    ).toBeNull();
  });
});

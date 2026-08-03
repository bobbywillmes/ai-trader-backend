// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactRecordList } from "./CompactRecordList";
import { DataState } from "./DataState";
import { DataTable } from "./DataTable";
import { ResponsiveDataView } from "./ResponsiveDataView";
import { ResponsiveDetails } from "./ResponsiveDetails";
import { ResponsiveFilterToolbar } from "./ResponsiveFilterToolbar";
import { StatusBadge } from "./StatusBadge";
import { formatStatusLabel } from "./status";
import { getDataPresentation } from "./presentation";

let observedResize: ((width: number) => void) | null = null;
class ResizeObserverMock {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe() { observedResize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  disconnect() { observedResize = null; }
  unobserve() {}
}

function Providers({ children }: { children: React.ReactNode }) { return <MantineProvider defaultColorScheme="dark">{children}</MantineProvider>; }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("responsive presentation", () => {
  it("can retain an accessible table caption without displaying it", () => {
    render(<DataTable caption="Open positions" captionHidden><tbody><tr><td>SPY</td></tr></tbody></DataTable>, { wrapper: Providers });
    const table = screen.getByRole("table", { name: "Open positions" });
    expect(table.querySelector("caption")?.className).toContain("visuallyHidden");
  });
  it("uses centralized narrow, compact, and wide boundaries", () => {
    expect([390, 639, 640, 1099, 1100].map(getDataPresentation)).toEqual(["narrow", "narrow", "compact", "compact", "wide"]);
  });

  it("changes presentation from its container while preserving record IDs", async () => {
    const records = [{ id: "a" }, { id: "b" }];
    render(<ResponsiveDataView records={records} getRecordId={(record) => record.id} wide={() => <table aria-label="wide table"><tbody><tr><td>Wide</td></tr></tbody></table>} compact={() => <div>Compact records</div>} narrow={() => <div>Mobile cards</div>}/>, { wrapper: Providers });
    observedResize?.(1200);
    await screen.findByLabelText("wide table");
    observedResize?.(800);
    await screen.findByText("Compact records");
    observedResize?.(390);
    await screen.findByText("Mobile cards");
    expect(screen.getByText("Mobile cards").parentElement?.dataset.recordIds).toBe("a b");
  });
});

describe("details", () => {
  it("opens and closes inline details with associated aria state", async () => {
    function Harness() { const [id, setId] = useState<string | number | null>(null); return <CompactRecordList records={[{ id: "spy" }]} getRecordId={(record) => record.id} renderIdentity={() => "SPY"} renderFields={() => [{ label: "Status", value: "Open" }]} renderDetails={() => "Secondary position data"} renderActions={() => <button>Position actions</button>} expandedId={id} onExpandedChange={setId}/>; }
    render(<Harness/>, { wrapper: Providers }); const user = userEvent.setup(); const button = screen.getByRole("button", { name: "Details" });
    expect(screen.getByRole("button", { name: "Position actions" })).toBeTruthy(); expect(button.getAttribute("aria-expanded")).toBe("false"); await user.click(button); expect(button.getAttribute("aria-expanded")).toBe("true"); expect(screen.getByText("Secondary position data")).toBeTruthy(); await user.click(button); expect(screen.queryByText("Secondary position data")).toBeNull();
  });

  it("closes drawer on Escape and restores focus", async () => {
    function Harness() { const [open, setOpen] = useState(false); const [opener, setOpener] = useState<HTMLElement | null>(null); return <><button onClick={(event) => { setOpener(event.currentTarget); setOpen(true); }}>Open record</button><ResponsiveDetails opened={open} title="SPY details" onClose={() => setOpen(false)} returnFocusTo={opener}>Drawer content</ResponsiveDetails></>; }
    render(<Harness/>, { wrapper: Providers }); const user = userEvent.setup(); const opener = screen.getByRole("button", { name: "Open record" }); await user.click(opener); expect(screen.getByRole("dialog")).toBeTruthy(); fireEvent.keyDown(document.body, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("status badges", () => {
  it("formats full labels and retains intrinsic non-truncating styles", () => {
    expect(formatStatusLabel("NEEDS_CREDENTIALS")).toBe("Needs credentials");
    render(<div style={{ display: "flex", width: 20 }}><StatusBadge status="TRADING_DISABLED" tone="danger"/></div>, { wrapper: Providers });
    const badge = screen.getByLabelText("Trading disabled status");
    expect(badge.getAttribute("aria-label")).toBe("Trading disabled status"); expect(badge.getAttribute("data-tone")).toBe("danger"); expect(badge.className).toContain("badge");
  });
});

describe("filters and states", () => {
  it("shows active filters, opens the mobile panel, and clears all", async () => {
    const clear = vi.fn(); render(<ResponsiveFilterToolbar primary={<label>Search<input aria-label="Search"/></label>} secondary={<label>Status<select aria-label="Status"><option>Open</option></select></label>} activeFilters={[{ key: "open", label: "Status: Open" }]} onClearAll={clear}/>, { wrapper: Providers });
    expect(screen.getByLabelText("Data filters")).toBeTruthy(); expect(within(screen.getByLabelText("Active filters")).getByText("Status: Open")).toBeTruthy();
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Filters (1)" })); expect(screen.getByRole("dialog")).toBeTruthy(); await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear all" })); expect(clear).toHaveBeenCalledOnce();
  });

  it("renders loading, empty, and retryable error states", async () => {
    const retry = vi.fn(); const { rerender } = render(<DataState state="loading"/>, { wrapper: Providers }); expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    const emptyAction = vi.fn(); rerender(<Providers><DataState state="empty" action={{ label: "Clear filters", onClick: emptyAction }}/></Providers>); expect(screen.getByText("No records")).toBeTruthy(); await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" })); expect(emptyAction).toHaveBeenCalledOnce(); rerender(<Providers><DataState state="error" onRetry={retry}/></Providers>); await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(retry).toHaveBeenCalledOnce();
  });
});

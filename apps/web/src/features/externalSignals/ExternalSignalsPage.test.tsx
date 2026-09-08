// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { source, binding, signal, delivery } from "./fixtures.test-support";
const mocks = vi.hoisted(() => ({ request: vi.fn(), notify: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiRequest: mocks.request, getAdminToken: () => "owner-session", getApiUrl: (path: string) => `https://api.example.test${path}` }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
import { ExternalSignalsPage } from "./ExternalSignalsPage";

const plaintext = "one-time-credential-" + "x".repeat(24);
const root = "/api/external-signal-admin";
let client: QueryClient;
let sources = [{ ...source }];
let bindings = [{ ...binding }];
let signals = [{ ...signal }];
let deliveries = [{ ...delivery }];
let revisions = [...binding.revisions];
let sourceFailure = false;
let sourceLoading = false;
let mutationFailure = false;
function Location() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output aria-label="Location">{location.search}</output><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>;
}
function mount(search = "") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/system/external-signals${search}`]}><ExternalSignalsPage /><Location /></MemoryRouter></QueryClientProvider></MantineProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
  sources = [{ ...source }]; bindings = [{ ...binding }]; signals = [{ ...signal }]; deliveries = [{ ...delivery }];
  revisions = [...binding.revisions];
  sourceFailure = false; sourceLoading = false; mutationFailure = false;
  mocks.request.mockImplementation(async (path: string, options: { method?: string; body?: Record<string, unknown> }) => {
    if (path === "/api/strategies") return [{ id: 3, name: "Mean reversion", key: "mean_reversion", enabled: true }];
    if (options.method && options.method !== "GET") {
      if (mutationFailure) throw new Error("Unavailable");
      if (path === `${root}/bindings/2/revisions`) { const row = { ...binding.revisions[0], id: 11, revision: 2, status: "PREPARED" as const, activatedAt: null, changeNote: String(options.body?.changeNote ?? "") }; revisions.unshift(row); return row; }
      if (path.endsWith("/11/activate")) { revisions = revisions.map(row => ({ ...row, status: row.id === 11 ? "ACTIVE" as const : "RETIRED" as const })); return revisions[0]; }
      if (path.endsWith("/11/retire")) { revisions = revisions.map(row => row.id === 11 ? { ...row, status: "RETIRED" as const } : row); return revisions[0]; }
      if (path.endsWith("rotate-token")) return { source, token: plaintext };
      if (path === `${root}/sources`) { const created = { ...source, ...options.body, id: 7 }; sources.push(created); return { source: created, token: plaintext }; }
      if (path === `${root}/sources/1`) { sources[0] = { ...sources[0], ...options.body }; return sources[0]; }
      if (path === `${root}/bindings`) { const created = { ...binding, ...options.body, id: 8 }; bindings.push(created); return created; }
      if (path === `${root}/bindings/2`) { bindings[0] = { ...bindings[0], ...options.body }; return bindings[0]; }
    }
    if (path.endsWith("/revisions")) return revisions;
    const match = path.match(/\/external-signal-admin\/(sources|bindings|signals|deliveries)(?:\/(\d+))?/)!;
    const resource = match[1] as "sources" | "bindings" | "signals" | "deliveries";
    if (resource === "sources" && sourceLoading) return new Promise(() => {});
    if (resource === "sources" && sourceFailure) throw new Error("Unavailable");
    const items = { sources, bindings, signals, deliveries }[resource];
    if (match[2]) return items.find(item => item.id === Number(match[2]));
    const query = new URL(path, "https://example.test").searchParams;
    return { [resource]: items, pagination: { page: Number(query.get("page")) || 1, pageSize: 25, total: items.length, totalPages: 3 } };
  });
});
afterEach(() => { cleanup(); client?.clear(); });

describe("External Signals configuration", () => {
  it("abandons a prepared candidate with confirmation and preserves active state", async () => {
    revisions = [{ ...binding.revisions[0], id: 11, revision: 2, status: "PREPARED", activatedAt: null }, ...binding.revisions];
    mount("?section=bindings&detail=2");
    fireEvent.click(await screen.findByRole("button", { name: "Abandon revision 2" }));
    expect(await screen.findByText(/Its number will never be reused/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm abandonment" }));
    expect(await screen.findByText("RETIRED")).toBeTruthy();
    expect(screen.getByText("Active revision: Revision 1")).toBeTruthy();
  });
  it("keeps failed activation open with safe error context", async () => {
    revisions = [{ ...binding.revisions[0], id: 11, revision: 2, status: "PREPARED", activatedAt: null }, ...binding.revisions];
    mutationFailure = true; mount("?section=bindings&detail=2");
    fireEvent.click(await screen.findByRole("button", { name: "Activate revision 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm activation" }));
    expect(await screen.findByText(/Unable to change revision/)).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.getByText("PREPARED")).toBeTruthy();
  });
  it("prepares a backend-numbered revision and confirms activation with revision history", async () => {
    mount("?section=bindings&detail=2");
    const prepare = await screen.findByRole("button", { name: "Prepare new revision" });
    await waitFor(() => expect(prepare.hasAttribute("disabled")).toBe(false));
    fireEvent.click(prepare);
    const dialog = within(await screen.findByRole("dialog", { name: "Prepare new revision" }));
    expect(dialog.getByText("Revision 2 will be prepared.")).toBeTruthy();
    expect(dialog.queryByRole("spinbutton")).toBeNull();
    fireEvent.change(dialog.getByLabelText("Change note"), { target: { value: "Added ADX confirmation" } });
    fireEvent.click(dialog.getByRole("button", { name: "Prepare revision" }));
    expect(await screen.findByText("PREPARED")).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledWith(`${root}/bindings/2/revisions`, expect.objectContaining({ method: "POST", body: { changeNote: "Added ADX confirmation" } }));
    expect(screen.getByText(/"strategyRevision": 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Activate revision 2" }));
    expect(screen.getByText(/Signals still sending revision 1 will be rejected/)).toBeTruthy();
    expect(mocks.request.mock.calls.some(([path]) => path.endsWith("/activate"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(await screen.findByText("RETIRED")).toBeTruthy();
    expect(screen.getByText("Active revision: Revision 2")).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    for (const action of [/execute/i, /create order/i, /evaluate/i, /broker/i]) expect(screen.queryByRole("button", { name: action })).toBeNull();
    expect(mocks.request.mock.calls.every(([path]) => path.startsWith(root) || path === "/api/strategies")).toBe(true);
  });
  it("loads sources and communicates global evidence-only scope", async () => {
    mount(); expect(await screen.findByText("Research feed")).toBeTruthy();
    expect(screen.getByText(/cannot create orders or modify positions/)).toBeTruthy();
    expect(screen.queryByText("Trading account")).toBeNull();
    expect(screen.getByText("Generic webhook")).toBeTruthy();
  });
  it("creates a source, shows one-time credentials, then removes plaintext from UI and caches", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem"); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    fireEvent.change(screen.getByLabelText("Source name", { exact: false }), { target: { value: "New feed" } });
    fireEvent.submit(screen.getByLabelText("Source name", { exact: false }).closest("form")!);
    expect(await screen.findByText(plaintext)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Token" })).toBeTruthy();
    expect(screen.getByText(`https://api.example.test/api/external-signals/${plaintext}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Webhook URL" })).toBeTruthy();
    await waitFor(() => expect(client.getMutationCache().getAll().every(item => item.state.status !== "pending")).toBe(true));
    expect(JSON.stringify(client.getMutationCache().getAll().map(item => item.state))).not.toContain(plaintext);
    fireEvent.click(screen.getByRole("button", { name: "Done — clear credential" }));
    expect(screen.queryByText(plaintext)).toBeNull();
    expect(JSON.stringify(client.getQueryCache().getAll().map(item => item.state.data))).not.toContain(plaintext);
    expect(screen.getByLabelText("Location").textContent).not.toContain(plaintext);
    expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it("confirms token rotation before sending the request and clears the new token on close", async () => {
    mount("?detail=1"); fireEvent.click(await screen.findByRole("button", { name: "Rotate webhook token" }));
    expect(screen.getByText(/immediately invalidates/)).toBeTruthy();
    expect(mocks.request.mock.calls.some(([path]) => path.endsWith("rotate-token"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(await screen.findByText(plaintext)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done — clear credential" }));
    expect(screen.queryByText(plaintext)).toBeNull();
  });
  it.each([true, false])("requires confirmation to change source enabled state from %s", async enabled => {
    sources = [{ ...source, enabled }];
    mount("?detail=1"); fireEvent.click(await screen.findByRole("button", { name: enabled ? "Disable source" : "Enable source" }));
    fireEvent.click(screen.getByRole("button", { name: enabled ? "Confirm disable" : "Confirm enable" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(`${root}/sources/1`, expect.objectContaining({ method: "PATCH", body: { enabled: !enabled } })));
  });
  it("renames a source without changing its credential or provider", async () => {
    mount("?detail=1"); fireEvent.click(await screen.findByRole("button", { name: "Rename source" }));
    fireEvent.change(screen.getByLabelText("Source name", { exact: false }), { target: { value: "Renamed research" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(`${root}/sources/1`, expect.objectContaining({ method: "PATCH", body: { name: "Renamed research" } })));
  });
  it("creates a binding from catalog selections without typed IDs", async () => {
    mount("?section=bindings"); fireEvent.click(await screen.findByRole("button", { name: "Create binding" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByLabelText("Source", { exact: false }));
    fireEvent.click(await screen.findByRole("option", { name: "Research feed (#1)" }));
    fireEvent.click(dialog.getByLabelText("Internal Strategy", { exact: false }));
    fireEvent.click(await screen.findByRole("option", { name: "Mean reversion (#3)" }));
    fireEvent.change(dialog.getByLabelText("External strategy key", { exact: false }), { target: { value: "  SPY   Dip Test 1  " } });
    expect(dialog.getByText("spy-dip-test-1")).toBeTruthy();
    expect(dialog.queryByLabelText("Expected revision", { exact: false })).toBeNull();
    expect(dialog.getByText("Revision 1 will be created automatically.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Create binding" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(`${root}/bindings`, expect.objectContaining({ method: "POST", body: { signalSourceId: 1, strategyId: 3, externalStrategyKey: "spy-dip-test-1", enabled: true } })));
  });
  it("edits only enabled with prospective-change acknowledgment", async () => {
    mount("?section=bindings&detail=2"); fireEvent.click(await screen.findByRole("button", { name: "Edit binding" }));
    expect(screen.queryByLabelText("Expected revision", { exact: false })).toBeNull();
    fireEvent.click(screen.getByLabelText("Enable this binding"));
    expect(screen.getByRole("button", { name: "Save binding" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("I understand these changes apply to future deliveries."));
    fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(`${root}/bindings/2`, expect.objectContaining({ method: "PATCH", body: { enabled: false } })));
  });
  it("has loading, empty, API-error and retry states", async () => {
    sourceLoading = true; const first = mount(); expect(screen.getByText("Loading sources…")).toBeTruthy(); first.unmount(); client.clear();
    sourceLoading = false; sources = []; const second = mount(); expect(await screen.findByText("No sources yet")).toBeTruthy(); second.unmount(); client.clear();
    sourceFailure = true; mount(); expect(await screen.findByText("Unable to load sources")).toBeTruthy();
    sourceFailure = false; sources = [{ ...source }]; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Research feed")).toBeTruthy();
  });
  it("keeps a failed form open and notifies without exposing internal errors", async () => {
    mutationFailure = true; mount(); fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    fireEvent.change(screen.getByLabelText("Source name", { exact: false }), { target: { value: "New feed" } });
    fireEvent.submit(screen.getByLabelText("Source name", { exact: false }).closest("form")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ color: "red" })));
  });
});

describe("External Signals immutable evidence", () => {
  it("shows legacy labels truthfully without a numeric revision relationship", async () => {
    signals = [{ ...signal, strategyRevision: null, strategySignalRevisionId: null, legacyStrategyRevision: "acceptance-2" }];
    mount("?section=signals&detail=4");
    expect(await screen.findByText("Legacy revision: acceptance-2")).toBeTruthy();
    expect(screen.getByText(/has no numeric revision relationship/)).toBeTruthy();
  });
  it("presents numeric mismatch context", async () => {
    deliveries = [{ ...delivery, rejectionCode: "STRATEGY_REVISION_MISMATCH", rejectionDetails: { activeRevision: 2, receivedRevision: 1 } }];
    mount("?section=deliveries&detail=6");
    expect(await screen.findByText(/Active revision: 2.*Received revision: 1/)).toBeTruthy();
  });
  it.each([null, {}, []])("omits null or empty rejection details: %j", async rejectionDetails => {
    deliveries = [{ ...delivery, rejectionDetails }]; mount("?section=deliveries&detail=6");
    await screen.findByLabelText("Redacted raw payload");
    expect(screen.queryByText("Rejection details")).toBeNull();
  });
  it("renders Signal history and formatted metadata without execution or editing actions", async () => {
    mount("?section=signals&detail=4");
    expect(await screen.findByLabelText("Metadata")).toBeTruthy();
    expect(screen.getByLabelText("Metadata").textContent).toContain('"rsi": 28.4');
    expect(screen.getByLabelText("Metadata").textContent).toContain('"triggerPrice": 600.25');
    expect(screen.getByText("deterministic-event-key")).toBeTruthy();
    expect(screen.getByText("c".repeat(64))).toBeTruthy();
    for (const action of [/execute/i, /accept signal/i, /reject signal/i, /edit signal/i, /delete/i, /replay/i, /create order/i]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
    expect(mocks.request.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
  });
  it("renders rejected Delivery evidence naturally, including redacted JSON and no Signal", async () => {
    mount("?section=deliveries&detail=6");
    expect(await screen.findByLabelText("Redacted raw payload")).toBeTruthy();
    expect(screen.getByLabelText("Redacted raw payload").textContent).toContain('"apiKey": "[redacted]"');
    expect(screen.getByLabelText("Rejection details").textContent).toContain("credentials_not_allowed");
    expect(screen.getByText("No Signal — delivery was not normalized")).toBeTruthy();
    expect(screen.getAllByText("INVALID_ENVELOPE").length).toBeGreaterThan(0);
    for (const action of [/execute/i, /edit delivery/i, /delete/i, /replay/i, /create order/i]) expect(screen.queryByRole("button", { name: action })).toBeNull();
  });
  it.each(["NORMALIZED", "DUPLICATE"] as const)("links %s Delivery to its Signal with Back/Forward support", async status => {
    deliveries = [{ ...delivery, status, signalId: 4, rejectionCode: null, rejectionDetails: null }];
    mount("?section=deliveries&detail=6"); fireEvent.click(await screen.findByRole("button", { name: "View Signal #4" }));
    expect(await screen.findByLabelText("Metadata")).toBeTruthy();
    expect(screen.getByLabelText("Location").textContent).toContain("section=signals");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Redacted raw payload")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(await screen.findByLabelText("Metadata")).toBeTruthy();
  });
  it("opens related deliveries with the Signal filter and preserves page size", async () => {
    mount("?section=signals&detail=4&pageSize=50");
    fireEvent.click(await screen.findByRole("button", { name: "View related deliveries" }));
    await waitFor(() => expect(screen.getByLabelText("Location").textContent).toContain("signalId=4"));
    expect(screen.getByLabelText("Location").textContent).toContain("pageSize=50");
    expect((screen.getByLabelText("Signal ID") as HTMLInputElement).value).toBe("4");
  });
  it("applies URL filters, resets the page, preserves page size, and restores draft fields on Back", async () => {
    mount("?section=signals&page=3&pageSize=50&symbol=QQQ");
    await screen.findByRole("button", { name: "Apply filters" });
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "SPY" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(screen.getByLabelText("Location").textContent).toContain("symbol=SPY"));
    expect(screen.getByLabelText("Location").textContent).toContain("page=1");
    expect(screen.getByLabelText("Location").textContent).toContain("pageSize=50");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Symbol") as HTMLInputElement).value).toBe("QQQ");
    expect(screen.getByLabelText("Location").textContent).toContain("page=3");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Location").textContent).not.toContain("symbol=");
  });
  it("uses cards with working details at a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    mount("?section=signals");
    await waitFor(() => expect(document.querySelector('[data-presentation="narrow"]')).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByLabelText("Metadata")).toBeTruthy();
  });
  it("changes pages through URL state and keeps applied filters", async () => {
    mount("?section=signals&symbol=QQQ");
    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    await waitFor(() => expect(screen.getByLabelText("Location").textContent).toContain("page=2"));
    expect(screen.getByLabelText("Location").textContent).toContain("symbol=QQQ");
    expect(mocks.request.mock.calls.some(([path]) => path.includes("page=2") && path.includes("symbol=QQQ"))).toBe(true);
  });
  it("changes section via tabs and restores it on browser Back", async () => {
    mount(); fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    expect(await screen.findByLabelText("Symbol")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Signals" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Create source" })).toBeTruthy();
  });
  it("provides evidence empty and error states", async () => {
    signals = []; const first = mount("?section=signals");
    expect(await screen.findByText("No signals found")).toBeTruthy(); first.unmount(); client.clear();
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((path, options) => path.startsWith(`${root}/deliveries`) ? Promise.reject(new Error("Unavailable")) : original(path, options));
    mount("?section=deliveries"); expect(await screen.findByText("Unable to load deliveries")).toBeTruthy();
  });
});

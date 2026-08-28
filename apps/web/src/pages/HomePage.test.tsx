// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import canonicalLogo from "../assets/branding/ai-trader-mark.png";
const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock("../lib/api", () => ({ getAdminToken: () => null }));
vi.mock("../features/auth/hooks", () => ({ useMe: () => ({ data: null, isLoading: false }), useLogin: () => ({ mutateAsync: mocks.mutateAsync, isPending: false, isError: false }) }));
import { HomePage } from "./HomePage";
afterEach(cleanup);
describe("login branding and authentication", () => {
  it("uses the canonical logo, removes the AT placeholder, and shows the current subtitle", () => { render(<MantineProvider><MemoryRouter><HomePage/></MemoryRouter></MantineProvider>); expect(screen.getByAltText("AI Trader").getAttribute("src")).toBe(canonicalLogo); expect(screen.queryByText("AT")).toBeNull(); expect(screen.getByText("Sign in to your account.")).toBeTruthy(); });
  it("preserves credential submission", async () => { mocks.mutateAsync.mockRejectedValueOnce(new Error("Expected test rejection")); render(<MantineProvider><MemoryRouter><HomePage/></MemoryRouter></MantineProvider>); fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: "operator@example.com" } }); fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "password" } }); fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!); await vi.waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ email: "operator@example.com", password: "password" })); });
  it("retains responsive base and desktop grid spans", () => { render(<MantineProvider><MemoryRouter><HomePage/></MemoryRouter></MantineProvider>); const columns = document.querySelectorAll("[class*='Grid-col']"); expect(columns.length).toBeGreaterThanOrEqual(2); });
});

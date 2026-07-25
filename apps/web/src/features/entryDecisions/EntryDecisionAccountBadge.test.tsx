import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";

import { EntryDecisionAccountBadge } from "./EntryDecisionAccountBadge";

describe("EntryDecisionAccountBadge", () => {
  it("renders an account-neutral decision as Global", () => {
    const markup = renderToStaticMarkup(
      <MantineProvider>
        <EntryDecisionAccountBadge
          decision={{ tradingAccountId: null, tradingAccount: null }}
        />
      </MantineProvider>,
    );

    expect(markup).toContain("Global");
    expect(markup).not.toContain("Bobby Paper");
    expect(markup).not.toContain("Unassigned");
  });
});

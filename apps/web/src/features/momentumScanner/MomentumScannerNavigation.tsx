import { Button, Group, ScrollArea } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";

const items = [
  { key: "overview", label: "Overview", to: "/momentum-scanner" },
  { key: "candidates", label: "Candidates", to: "/momentum-scanner/candidates" },
  { key: "catalysts", label: "Catalysts", to: "/momentum-scanner/catalysts" },
  { key: "universe", label: "Research Universe", to: "/momentum-scanner/universe" },
  { key: "pipeline", label: "Scanner Pipeline", to: "/momentum-scanner/pipeline" },
] as const;

function activeKey(pathname: string) {
  if (pathname.includes("/pipeline")) return "pipeline";
  if (pathname.includes("/universe")) return "universe";
  if (pathname.includes("/candidates")) return "candidates";
  if (pathname.includes("/catalysts")) return "catalysts";
  return "overview";
}

export function MomentumScannerNavigation() {
  const location = useLocation();
  const active = activeKey(location.pathname);

  return (
    <ScrollArea type="auto" scrollbarSize={4} offsetScrollbars>
      <Group gap="xs" wrap="nowrap" pb={4} miw="max-content">
        {items.map((item) => (
          <Button
            key={item.key}
            component={Link}
            to={item.to}
            size="compact-sm"
            variant={active === item.key ? "filled" : "subtle"}
            aria-current={active === item.key ? "page" : undefined}
          >
            {item.label}
          </Button>
        ))}
      </Group>
    </ScrollArea>
  );
}

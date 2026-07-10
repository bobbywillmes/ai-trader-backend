import { SegmentedControl } from "@mantine/core";
import { useLocation, useNavigate } from "react-router-dom";

export function MomentumScannerNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const value = location.pathname.endsWith("/universe") ? "universe" : "scanner";

  return (
    <SegmentedControl
      value={value}
      onChange={(next) =>
        navigate(next === "universe" ? "/momentum-scanner/universe" : "/momentum-scanner")
      }
      data={[
        { value: "scanner", label: "Scanner Pipeline" },
        { value: "universe", label: "Research Universe" },
      ]}
    />
  );
}

import { Drawer } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

type Props = { opened: boolean; title: ReactNode; children: ReactNode; onClose: () => void; returnFocusTo?: HTMLElement | null; mode?: "drawer" | "inline" };

export function ResponsiveDetails({ opened, title, children, onClose, returnFocusTo, mode = "drawer" }: Props) {
  const wasOpened = useRef(false);
  useEffect(() => {
    if (wasOpened.current && !opened) window.setTimeout(() => returnFocusTo?.focus(), 0);
    wasOpened.current = opened;
  }, [opened, returnFocusTo]);
  if (mode === "inline") return opened ? <section aria-label={typeof title === "string" ? title : "Record details"}>{children}</section> : null;
  return <Drawer opened={opened} onClose={onClose} title={title} position="right" size="min(var(--data-drawer-width), 100vw)" closeOnEscape closeOnClickOutside trapFocus lockScroll aria-label={typeof title === "string" ? title : "Record details"} styles={{ content: { maxWidth: "100%", height: "100dvh" }, body: { containerName: "responsive-data-view", containerType: "inline-size", overflowY: "auto", paddingBottom: "max(var(--mantine-spacing-md), env(safe-area-inset-bottom))" } }}>{children}</Drawer>;
}

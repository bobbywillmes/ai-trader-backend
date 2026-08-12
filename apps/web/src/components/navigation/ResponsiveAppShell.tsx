import {
  AppShell, Avatar, Burger, Divider, Drawer, Menu, ScrollArea,
  Text, Tooltip, UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconLogout, IconPin, IconPinnedOff, IconUser } from "@tabler/icons-react";
import { forwardRef, useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AdminNavGroup, AdminNavItem } from "../../app/navigation";
import { isNavigationItemActive } from "../../app/navigation";
import type { PlatformRole, User } from "../../features/auth/types";
import { getPlatformRoleLabel } from "../../features/users/roleLabels";
import { SIDEBAR_PINNED_STORAGE_KEY, getInitialSidebarState, transitionSidebar, type SidebarState } from "./sidebarState";
import classes from "./ResponsiveAppShell.module.css";
import { AppBrand } from "../brand/AppBrand";
import type { PageScopeMode } from "../../features/tradingAccountScope/types";
import { TradingAccountScopeSelector } from "../../features/tradingAccountScope/TradingAccountScopeSelector";
import { createScopedNavigationTarget } from "../../app/navigationUtils";
import { isNestedGroupOpen } from "./nestedNavigationState";

export const SIDEBAR_COLLAPSED_WIDTH = 72;
export const SIDEBAR_EXPANDED_WIDTH = 248;
const SIDEBAR_CLOSE_DELAY_MS = 125;

type Props = {
  children: ReactNode;
  groups: AdminNavGroup[];
  user: User | null;
  platformRole?: PlatformRole;
  isSigningOut: boolean;
  onSignOut: () => void;
  pageScope?: { mode: PageScopeMode; routeTradingAccountId: number | null };
  preserveTradingAccountScope?: boolean;
};

export function ResponsiveAppShell(props: Props) {
  const [state, setState] = useState<SidebarState>(() => getInitialSidebarState(typeof window === "undefined" ? null : window.localStorage));
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownedMenuOpen = useRef(false);
  const mobileNavigationScrollTop = useRef(0);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const isPinned = state === "desktop-pinned";
  const isExpanded = isPinned || state === "desktop-hover-expanded";

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const openTemporary = useCallback(() => {
    cancelClose();
    setState((current) => transitionSidebar(current, "temporary-open"));
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    if (ownedMenuOpen.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setState((current) => transitionSidebar(current, "temporary-close")), SIDEBAR_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);
  useEffect(() => {
    if (state !== "mobile-open") return;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [state]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState((current) => transitionSidebar(current, "temporary-close"));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state]);

  const togglePinned = () => {
    const nextPinned = !isPinned;
    window.localStorage.setItem(SIDEBAR_PINNED_STORAGE_KEY, String(nextPinned));
    setState((current) => transitionSidebar(current, nextPinned ? "pin" : "unpin"));
  };
  const openMobile = () => setState((current) => transitionSidebar(current, "mobile-open"));
  const closeMobile = () => setState((current) => transitionSidebar(current, "mobile-close", window.localStorage.getItem(SIDEBAR_PINNED_STORAGE_KEY) === "true"));
  const toggleMobile = () => state === "mobile-open" ? closeMobile() : openMobile();
  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
  };

  return (
    <AppShell padding="md" className={classes.shell} data-sidebar-state={state}>
      <ApplicationHeader ref={hamburgerRef} opened={state === "mobile-open"} onToggle={toggleMobile} />
      <aside
        className={classes.desktopSidebar}
        data-expanded={isExpanded || undefined}
        data-pinned={isPinned || undefined}
        onPointerEnter={(event) => event.pointerType !== "touch" && openTemporary()}
        onPointerLeave={scheduleClose}
        onFocusCapture={openTemporary}
        onBlurCapture={handleBlur}
      >
        <SidebarContents {...props} expanded={isExpanded} pinned={isPinned} onTogglePinned={togglePinned} onOwnedMenuChange={(opened) => {
          ownedMenuOpen.current = opened;
          if (opened) openTemporary(); else scheduleClose();
        }} />
      </aside>
      <MobileNavigationDrawer opened={state === "mobile-open"} onClose={closeMobile} returnFocus={hamburgerRef} navigationScrollTopRef={mobileNavigationScrollTop} {...props} />
      <AppShell.Main className={classes.main} data-pinned={isPinned || undefined}>{props.children}</AppShell.Main>
    </AppShell>
  );
}

const ApplicationHeader = forwardRef<HTMLButtonElement, { opened: boolean; onToggle: () => void }>(({ opened, onToggle }, ref) => (
  <header className={classes.mobileHeader}>
    <AppBrand expanded />
    <Burger
      ref={ref}
      opened={opened}
      onClick={onToggle}
      aria-label={opened ? "Close navigation" : "Open navigation"}
      size="sm"
      className={classes.headerBurger}
    />
  </header>
));

function SidebarContents({ groups, user, platformRole, pageScope, preserveTradingAccountScope = false, expanded, pinned, hideBrand = false, mobile = false, navigationScrollTopRef, isSigningOut, onSignOut, onTogglePinned, onNavigate, onOwnedMenuChange }: Props & { expanded: boolean; pinned: boolean; hideBrand?: boolean; mobile?: boolean; navigationScrollTopRef?: { current: number }; onTogglePinned?: () => void; onNavigate?: () => void; onOwnedMenuChange?: (open: boolean) => void }) {
  return <div className={classes.sidebarContents}>
    {!hideBrand && <>
      <div className={classes.sidebarHeader}>
        <AppBrand expanded={expanded} />
        {expanded && onTogglePinned && <Tooltip label={pinned ? "Unpin sidebar" : "Pin sidebar"}><UnstyledButton className={classes.iconButton} onClick={onTogglePinned} aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"} aria-pressed={pinned}>{pinned ? <IconPinnedOff size={19} /> : <IconPin size={19} />}</UnstyledButton></Tooltip>}
      </div>
      <Divider />
    </>}
    <ScrollArea
      className={classes.navigationScroll}
      scrollbarSize={6}
      viewportRef={(viewport) => {
        if (viewport && navigationScrollTopRef) viewport.scrollTop = navigationScrollTopRef.current;
      }}
      onScrollPositionChange={({ y }) => {
        if (navigationScrollTopRef) navigationScrollTopRef.current = y;
      }}
    >
      <SidebarNavigation groups={groups} expanded={expanded} onNavigate={onNavigate} preserveTradingAccountScope={preserveTradingAccountScope} />
    </ScrollArea>
    {pageScope && <><Divider /><TradingAccountScopeSelector {...pageScope} expanded={expanded} mobile={mobile} onMenuChange={onOwnedMenuChange} /></>}
    <Divider />
    <SidebarUserMenu user={user} platformRole={platformRole} expanded={expanded} mobile={mobile} isSigningOut={isSigningOut} onSignOut={onSignOut} onMenuChange={onOwnedMenuChange} />
  </div>;
}

function SidebarNavigation({ groups, expanded, onNavigate, preserveTradingAccountScope = false }: { groups: AdminNavGroup[]; expanded: boolean; onNavigate?: () => void; preserveTradingAccountScope?: boolean }) {
  const { pathname } = useLocation();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (label: string) => setExpandedGroups((current) => ({ ...current, [label]: !current[label] }));
  return <nav aria-label="Primary navigation" className={classes.navigation}>{groups.map((group) => <SidebarSection key={group.label} group={group} expanded={expanded} pathname={pathname} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} onNavigate={onNavigate} preserveTradingAccountScope={preserveTradingAccountScope} />)}</nav>;
}
function SidebarSection({ group, expanded, pathname, expandedGroups, onToggleGroup, onNavigate, preserveTradingAccountScope }: { group: AdminNavGroup; expanded: boolean; pathname: string; expandedGroups: Record<string, boolean>; onToggleGroup: (label: string) => void; onNavigate?: () => void; preserveTradingAccountScope: boolean }) {
  return <section className={classes.section}>{expanded ? <Text className={classes.sectionLabel}>{group.label}</Text> : <Divider className={classes.sectionDivider} />}{group.items.map((item) => item.children
    ? <SidebarNestedGroup key={item.label} item={item} expanded={expanded} pathname={pathname} manuallyExpanded={expandedGroups[item.label] ?? false} onToggle={() => onToggleGroup(item.label)} onNavigate={onNavigate} preserveTradingAccountScope={preserveTradingAccountScope} />
    : <SidebarLink key={item.to} item={item} expanded={expanded} onNavigate={onNavigate} preserveTradingAccountScope={preserveTradingAccountScope} />)}</section>;
}
function SidebarNestedGroup({ item, expanded, pathname, manuallyExpanded, onToggle, onNavigate, preserveTradingAccountScope }: { item: AdminNavItem; expanded: boolean; pathname: string; manuallyExpanded: boolean; onToggle: () => void; onNavigate?: () => void; preserveTradingAccountScope: boolean }) {
  const active = isNavigationItemActive(item, pathname);
  const open = isNestedGroupOpen(active, manuallyExpanded);
  const Icon = item.icon;
  const control = <UnstyledButton className={classes.navLink} data-active={active || undefined} aria-expanded={open} onClick={onToggle}>
    <Icon size={21} stroke={1.8} aria-hidden="true" />
    <span className={expanded ? classes.linkLabel : classes.visuallyHidden}>{item.label}</span>
    {expanded && (open ? <IconChevronUp className={classes.linkChevron} size={15} aria-hidden="true" /> : <IconChevronDown className={classes.linkChevron} size={15} aria-hidden="true" />)}
  </UnstyledButton>;
  return <div>{expanded ? control : <Tooltip label={item.label} position="right" openDelay={350}>{control}</Tooltip>}
    {expanded && open && <div className={classes.nestedLinks}>{item.children?.map((child) => <SidebarLink key={child.to} item={child} expanded onNavigate={onNavigate} preserveTradingAccountScope={preserveTradingAccountScope} nested />)}</div>}
  </div>;
}
function SidebarLink({ item, expanded, onNavigate, preserveTradingAccountScope, nested = false }: { item: AdminNavItem; expanded: boolean; onNavigate?: () => void; preserveTradingAccountScope: boolean; nested?: boolean }) {
  const { pathname, search } = useLocation(); const navigate = useNavigate(); const active = isNavigationItemActive(item, pathname); const Icon = item.icon;
  const to = item.to ?? "/";
  const target = preserveTradingAccountScope ? createScopedNavigationTarget(to, search) : to;
  const link = <UnstyledButton className={`${classes.navLink} ${nested ? classes.nestedLink : ""}`} data-active={active || undefined} aria-current={active ? "page" : undefined} onClick={() => { navigate(target); window.scrollTo({ top: 0, left: 0, behavior: "auto" }); onNavigate?.(); }}><Icon size={nested ? 17 : 21} stroke={1.8} aria-hidden="true" /><span className={expanded ? classes.linkLabel : classes.visuallyHidden}>{item.label}</span>{expanded && !nested && <IconChevronRight className={classes.linkChevron} size={15} aria-hidden="true" />}</UnstyledButton>;
  return expanded ? link : <Tooltip label={item.label} position="right" openDelay={350}>{link}</Tooltip>;
}

function SidebarUserMenu({ user, platformRole, expanded, mobile, isSigningOut, onSignOut, onMenuChange }: { user: User | null; platformRole?: PlatformRole; expanded: boolean; mobile: boolean; isSigningOut: boolean; onSignOut: () => void; onMenuChange?: (open: boolean) => void }) {
  const name = user?.name?.trim() || user?.email || "User";
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <Menu position={mobile ? "top-start" : "right-end"} offset={8} width={250} shadow="lg" onChange={onMenuChange} withinPortal>
    <Menu.Target><UnstyledButton className={classes.userButton} aria-label={`Open account menu for ${name}; includes sign out`}><Avatar color="cyan" radius="xl" size={38}>{initials}</Avatar>{expanded && <><div className={classes.userDetails}><Text size="sm" fw={650} truncate>{name}</Text><Text size="xs" c="dimmed" truncate>{user?.email}</Text><Text size="xs" c="cyan">{platformRole ? getPlatformRoleLabel(platformRole) : ""}</Text></div><div className={classes.userMenuHint}>{mobile ? <IconChevronUp size={17} aria-hidden="true" /> : <IconChevronRight size={17} aria-hidden="true" />}<Text size="xs">Account menu</Text></div></>}</UnstyledButton></Menu.Target>
    <Menu.Dropdown><Menu.Label>Signed in as</Menu.Label><Menu.Item leftSection={<IconUser size={16} />} disabled>{user?.email}</Menu.Item><Menu.Divider /><Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={onSignOut} disabled={isSigningOut}>{isSigningOut ? "Signing out…" : "Sign out"}</Menu.Item></Menu.Dropdown>
  </Menu>;
}

function MobileNavigationDrawer({ opened, onClose, returnFocus, navigationScrollTopRef, ...props }: Props & { opened: boolean; onClose: () => void; returnFocus: React.RefObject<HTMLButtonElement | null>; navigationScrollTopRef: { current: number } }) {
  const closeAndRestore = () => { onClose(); window.setTimeout(() => returnFocus.current?.focus(), 0); };
  return <Drawer
    opened={opened}
    onClose={closeAndRestore}
    aria-label="Navigation"
    withCloseButton={false}
    size="min(320px, 88vw)"
    padding={0}
    trapFocus={false}
    lockScroll
    closeOnEscape
    closeOnClickOutside
    zIndex={180}
    classNames={{ overlay: classes.drawerOverlay, inner: classes.drawerInner, content: classes.drawerContent, body: classes.drawerBody }}
    styles={{
      overlay: { top: "var(--ai-trader-mobile-header-height)", bottom: 0, height: "auto" },
      inner: { top: "var(--ai-trader-mobile-header-height)", bottom: 0, height: "auto" },
      content: { height: "100%", maxHeight: "100%", overflow: "hidden" },
    }}
  >
    <SidebarContents {...props} expanded pinned={false} hideBrand mobile navigationScrollTopRef={navigationScrollTopRef} onNavigate={closeAndRestore} />
  </Drawer>;
}

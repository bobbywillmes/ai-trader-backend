import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/legacy", label: "Legacy Admin" },
  { to: "/positions/open", label: "Open Positions" },
  { to: "/orders/open", label: "Open Orders" },
  { to: "/subscriptions", label: "Subscriptions" },
  { to: "/exit-profiles", label: "Exit Profiles" },
  { to: "/securities", label: "Securities" },
  { to: "/reports", label: "Reports" },
  { to: "/system/events", label: "System Events" },
  { to: "/settings", label: "Settings" },
];

export function AdminLayout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <aside className="fixed left-0 top-0 h-screen w-64 border-r border-slate-800 bg-slate-900 p-4">
        <div className="mb-6">
          <h1 className="text-xl font-bold">AI Trader</h1>
          <p className="text-sm text-slate-400">Admin Console</p>
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => (
            <NavItem key={item.to} to={item.to} label={item.label} />
          ))}
        </nav>
      </aside>

      <main className="ml-64 min-h-screen p-6">
        <Outlet />
      </main>
    </div>
  );
}

type NavItemProps = {
  to: string;
  label: string;
};

function NavItem({ to, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "block rounded-lg px-3 py-2 text-sm transition",
          isActive
            ? "bg-blue-600 text-white"
            : "text-slate-300 hover:bg-slate-800 hover:text-white",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}
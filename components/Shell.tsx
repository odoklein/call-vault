import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { SessionUser } from "@/lib/auth/session";

type Tab = "overview" | "clients" | "lines" | "board";

const ADMIN_TABS: { key: Tab; href: string; label: string }[] = [
  { key: "overview", href: "/admin", label: "Vue d'ensemble" },
  { key: "clients", href: "/admin/clients", label: "Clients" },
  { key: "lines", href: "/admin/lines", label: "Numéros" },
  { key: "board", href: "/board", label: "Appels" },
];

export function Shell({ user, active, children }: { user: SessionUser; active: Tab; children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <strong>Suzali Conseil · Calls</strong>
        {user.role === "ADMIN" ? (
          <nav aria-label="Navigation principale">
            {ADMIN_TABS.map((t) => (
              <Link key={t.key} href={t.href} className={t.key === active ? "active" : ""} aria-current={t.key === active ? "page" : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
        ) : (
          <span className="muted">{user.client?.name}</span>
        )}
        <span className="spacer" />
        <span className="muted">{user.email}</span>
        <form action={logout}>
          <button type="submit" className="link">
            Déconnexion
          </button>
        </form>
      </header>
      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>{children}</main>
    </>
  );
}

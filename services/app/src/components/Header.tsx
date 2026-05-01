"use client";

import { signOut, useSession } from "next-auth/react";
import { LogOut, User, Menu, Sun, Moon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { SystemMetricsWidget } from "./SystemMetricsWidget";
import { useUI, setUI } from "@/lib/ui-store";
import { useT } from "@/lib/i18n";

interface HeaderProps {
  brandName: string;
  brandLogoUrl?: string;
}

export function Header({ brandName, brandLogoUrl }: HeaderProps) {
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const { state } = useUI();
  const { t } = useT();

  const initials = session?.user?.name
    ? session.user.name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "?";

  return (
    <header className="h-14 shrink-0 border-b border-border bg-card flex items-center justify-between px-3 sm:px-4">
      <div className="flex items-center gap-2 min-w-0">
        {/* Hamburger mobile only */}
        <button
          className="lg:hidden p-2 rounded-md hover:bg-muted/30 transition-default"
          onClick={() => setUI({ mobileMenuOpen: !state.mobileMenuOpen })}
          title={t("header.menu")}
          aria-label={t("header.menu")}
        >
          <Menu size={18} />
        </button>

        <Link href="/" className="flex items-center gap-2 min-w-0">
          {brandLogoUrl ? (
            <img src={brandLogoUrl} alt={brandName} className="h-7 w-auto" />
          ) : (
            <div className="w-7 h-7 rounded bg-primary/20 text-primary flex items-center justify-center font-bold shrink-0">
              ⬡
            </div>
          )}
          <span className="font-semibold tracking-tight truncate">{brandName}</span>
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <SystemMetricsWidget />

        {/* Theme toggle */}
        <button
          onClick={() => setUI({ theme: state.theme === "dark" ? "light" : "dark" })}
          className="p-2 rounded-md hover:bg-muted/30 transition-default text-muted hover:text-foreground"
          title={state.theme === "dark" ? "Mode clair" : "Mode sombre"}
          aria-label={t("header.toggleTheme")}
        >
          {state.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/30 transition-default"
          >
            <div className="w-8 h-8 rounded-full bg-primary/20 text-primary text-xs font-semibold flex items-center justify-center">
              {initials}
            </div>
            <div className="text-sm text-left hidden sm:block">
              <div className="font-medium leading-tight">{session?.user?.name || "Invité"}</div>
              <div className="text-xs text-muted leading-tight truncate max-w-[180px]">{session?.user?.email}</div>
            </div>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-52 rounded-md bg-card border border-border shadow-lg z-20 py-1">
                <Link
                  href="/me"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30"
                  onClick={() => setMenuOpen(false)}
                >
                  <ShieldCheck size={14} /> Mes données
                </Link>
                <Link
                  href="/profile"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30"
                  onClick={() => setMenuOpen(false)}
                >
                  <User size={14} /> Mon profil
                </Link>
                <div className="my-1 border-t border-border" />
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 text-left"
                >
                  <LogOut size={14} /> Déconnexion
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

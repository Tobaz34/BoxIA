"use client";

import { signOut, useSession } from "next-auth/react";
import { LogOut, User } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { SystemMetricsWidget } from "./SystemMetricsWidget";

interface HeaderProps {
  brandName: string;
  brandLogoUrl?: string;
}

export function Header({ brandName, brandLogoUrl }: HeaderProps) {
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = session?.user?.name
    ? session.user.name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "?";

  return (
    <header className="h-14 shrink-0 border-b border-border bg-card flex items-center justify-between px-4">
      <Link href="/" className="flex items-center gap-2">
        {brandLogoUrl ? (
          <img src={brandLogoUrl} alt={brandName} className="h-7 w-auto" />
        ) : (
          <div className="w-7 h-7 rounded bg-primary/20 text-primary flex items-center justify-center font-bold">
            ⬡
          </div>
        )}
        <span className="font-semibold tracking-tight">{brandName}</span>
      </Link>

      <div className="flex items-center gap-2">
        <SystemMetricsWidget />

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
            <div className="text-xs text-muted leading-tight">{session?.user?.email}</div>
          </div>
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-2 w-48 rounded-md bg-card border border-border shadow-lg z-20 py-1">
              <Link
                href="/profile"
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30"
                onClick={() => setMenuOpen(false)}
              >
                <User size={14} /> Mon profil
              </Link>
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

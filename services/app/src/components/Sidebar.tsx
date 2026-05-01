"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  Bot,
  Workflow,
  FileText,
  Users,
  Activity,
  ScrollText,
  Settings,
  HelpCircle,
  ShieldCheck,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import { ConnectorsStatus } from "./ConnectorsStatus";
import { useUI, setUI } from "@/lib/ui-store";

const items = [
  { href: "/",          label: "Discuter",         icon: MessageSquare, primary: true },
  { href: "/agents",    label: "Mes assistants",   icon: Bot },
  { href: "/workflows", label: "Automatisations",  icon: Workflow },
  { href: "/documents", label: "Documents",        icon: FileText },
];

const adminItems = [
  { href: "/users",              label: "Utilisateurs",  icon: Users },
  { href: "/connectors",         label: "Connecteurs",   icon: Plug },
  { href: "/agents/marketplace", label: "Marketplace",   icon: Sparkles },
  { href: "/audit",              label: "Audit",         icon: ScrollText },
  { href: "/system",             label: "État serveur",  icon: Activity },
  { href: "/settings",           label: "Paramètres",    icon: Settings },
];

interface SidebarProps {
  isAdmin?: boolean;
}

export function Sidebar({ isAdmin = false }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
  const { state } = useUI();
  const open = state.mobileMenuOpen;

  return (
    <>
      {/* Overlay sur mobile uniquement */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-30"
          onClick={() => setUI({ mobileMenuOpen: false })}
        />
      )}
      <aside
        className={
          "shrink-0 border-r border-border bg-card flex flex-col transition-transform " +
          // desktop : visible, statique, w-64
          "lg:w-64 lg:relative lg:translate-x-0 " +
          // mobile : absolute drawer, w-72, glisse depuis la gauche
          "fixed inset-y-0 left-0 z-40 w-72 " +
          (open ? "translate-x-0" : "-translate-x-full lg:translate-x-0")
        }
      >
      <div className="flex-1 overflow-y-auto py-4">
        {/* Section utilisateur */}
        <nav className="px-3 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setUI({ mobileMenuOpen: false })}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-default ${
                  active
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-foreground hover:bg-muted/30"
                }`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Section admin (visible seulement aux admins) */}
        {isAdmin && (
          <>
            <div className="mt-6 px-6 mb-2 text-xs uppercase tracking-wide text-muted">
              Administration
            </div>
            <nav className="px-3 space-y-1">
              {adminItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-default ${
                      active
                        ? "bg-primary/15 text-primary font-medium"
                        : "text-foreground hover:bg-muted/30"
                    }`}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </>
        )}

        {/* Section Connecteurs (live status) */}
        <ConnectorsStatus />
      </div>

      {/* Footer sidebar */}
      <div className="border-t border-border p-3 space-y-1">
        <Link
          href="/me"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:bg-muted/30 transition-default"
        >
          <ShieldCheck size={16} />
          <span>Mes données</span>
        </Link>
        <Link
          href="/help"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:bg-muted/30 transition-default"
        >
          <HelpCircle size={16} />
          <span>Aide</span>
        </Link>
        {/* Bouton fermer sur mobile uniquement */}
        <button
          onClick={() => setUI({ mobileMenuOpen: false })}
          className="lg:hidden w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:bg-muted/30 transition-default"
        >
          <X size={16} />
          <span>Fermer</span>
        </button>
      </div>
    </aside>
    </>
  );
}

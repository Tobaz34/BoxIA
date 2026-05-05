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
  ShieldAlert,
  Plug,
  Sparkles,
  Zap,
  Network,
  BarChart3,
  Database,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConnectorsStatus } from "./ConnectorsStatus";
import { useUI, setUI } from "@/lib/ui-store";
import { useT } from "@/lib/i18n";

// Les `label` sont des CLÉS i18n (résolues via t() dans le rendu) — pas
// des chaînes affichables directement. Ça permet de reswitcher la langue
// sans recharger la page.
const items = [
  { href: "/",          labelKey: "sidebar.nav.chat",       icon: MessageSquare, primary: true },
  { href: "/agents",    labelKey: "sidebar.nav.agents",     icon: Bot },
  { href: "/workflows", labelKey: "sidebar.nav.workflows",  icon: Workflow },
  { href: "/documents", labelKey: "sidebar.nav.documents",  icon: FileText },
];

const adminItems = [
  { href: "/users",                 labelKey: "sidebar.admin.users",          icon: Users },
  { href: "/connectors",            labelKey: "sidebar.admin.connectors",     icon: Plug },
  { href: "/rag",                   labelKey: "sidebar.admin.rag",            icon: Database },
  { href: "/agents/marketplace",    labelKey: "sidebar.admin.marketplaceAi",  icon: Sparkles },
  { href: "/workflows/marketplace", labelKey: "sidebar.admin.marketplaceN8n", icon: Zap },
  { href: "/integrations/mcp",      labelKey: "sidebar.admin.mcp",            icon: Network },
  { href: "/audit",                 labelKey: "sidebar.admin.audit",          icon: ScrollText },
  { href: "/approvals",             labelKey: "sidebar.admin.approvals",      icon: ShieldAlert, badge: "approvals" as const },
  { href: "/system",                labelKey: "sidebar.admin.system",         icon: Activity },
  { href: "/bench",                 labelKey: "sidebar.admin.bench",          icon: BarChart3 },
  { href: "/settings",              labelKey: "sidebar.admin.settings",       icon: Settings },
];

/**
 * Hook qui poll le count des approvals pending pour afficher un badge
 * dynamique dans la sidebar. Polling 30s (assez pour pas spammer mais
 * réactif au chargement). Le banner global ApprovalBanner poll plus
 * vite (5s) pour la réactivité utilisateur.
 *
 * Sprint 1 P0 #2 part 3/3 finalisée.
 */
function useApprovalsCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch("/api/approvals", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { count?: number };
        if (!cancelled) setCount(j.count || 0);
      } catch {
        // silencieux
      }
    }
    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return count;
}

interface SidebarProps {
  isAdmin?: boolean;
}

export function Sidebar({ isAdmin = false }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
  const { state } = useUI();
  const open = state.mobileMenuOpen;
  const { t } = useT();
  const approvalsCount = useApprovalsCount(isAdmin);

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
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Section admin (visible seulement aux admins) */}
        {isAdmin && (
          <>
            <div className="mt-6 px-6 mb-2 text-xs uppercase tracking-wide text-muted">
              {t("sidebar.admin.header")}
            </div>
            <nav className="px-3 space-y-1">
              {adminItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                const showBadge =
                  ("badge" in item && item.badge === "approvals" && approvalsCount > 0);
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
                    <span className="flex-1">{t(item.labelKey)}</span>
                    {showBadge && (
                      <span
                        className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold bg-amber-500 text-white"
                        aria-label={`${approvalsCount} approbations en attente`}
                        title={`${approvalsCount} approbations en attente`}
                      >
                        {approvalsCount > 99 ? "99+" : approvalsCount}
                      </span>
                    )}
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
          <span>{t("sidebar.footer.myData")}</span>
        </Link>
        <Link
          href="/help"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:bg-muted/30 transition-default"
        >
          <HelpCircle size={16} />
          <span>{t("sidebar.footer.help")}</span>
        </Link>
        {/* Bouton fermer sur mobile uniquement */}
        <button
          onClick={() => setUI({ mobileMenuOpen: false })}
          className="lg:hidden w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:bg-muted/30 transition-default"
        >
          <X size={16} />
          <span>{t("sidebar.footer.close")}</span>
        </button>
      </div>
    </aside>
    </>
  );
}

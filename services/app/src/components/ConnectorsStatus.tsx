"use client";

/**
 * Section "Connecteurs" du sidebar — affiche les connecteurs actifs
 * en live (polling toutes les 30 s) + lien "Voir tout" vers /connectors.
 *
 * Source : /api/connectors?status=active  (la liste se base sur l'état
 * persistant côté serveur, pas sur la présence d'un container Docker).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

interface Connector {
  slug: string;
  name: string;
  icon: string;
  status: string;
  state: { last_error: string | null } | null;
}

const POLL_MS = 30_000;
const MAX_VISIBLE = 5;

export function ConnectorsStatus() {
  const [active, setActive] = useState<Connector[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/connectors?status=active", {
          cache: "no-store",
        });
        if (r.ok && !cancelled) {
          const j = await r.json();
          setActive(j.connectors || []);
        }
      } catch { /* ignore */ }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // En cours de chargement initial : ne rien afficher
  if (active === null) return null;

  return (
    <div className="px-3 mt-6">
      <div className="flex items-center justify-between px-3 mb-2">
        <span className="text-xs uppercase tracking-wide text-muted">
          Connecteurs {active.length > 0 && `(${active.length})`}
        </span>
        <Link
          href="/connectors"
          className="text-[10px] text-muted hover:text-foreground inline-flex items-center"
        >
          Voir tout <ChevronRight size={10} />
        </Link>
      </div>

      <div className="space-y-0.5">
        {active.length === 0 && (
          <Link
            href="/connectors"
            className="block px-3 py-2 text-xs text-muted hover:text-foreground hover:bg-muted/10 rounded-md transition-default"
          >
            Aucun connecteur actif. Cliquez pour activer.
          </Link>
        )}
        {active.slice(0, MAX_VISIBLE).map((c) => (
          <Link
            key={c.slug}
            href="/connectors"
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs hover:bg-muted/20 transition-default"
            title={
              c.state?.last_error
                ? `${c.name} — erreur : ${c.state.last_error}`
                : `${c.name} — actif`
            }
          >
            <span>{c.icon}</span>
            <span className="flex-1 truncate">{c.name}</span>
            <span
              className={
                "w-1.5 h-1.5 rounded-full " +
                (c.state?.last_error ? "bg-red-400" : "bg-accent")
              }
            />
          </Link>
        ))}
        {active.length > MAX_VISIBLE && (
          <Link
            href="/connectors"
            className="block px-3 py-1 text-[10px] text-muted hover:text-foreground"
          >
            + {active.length - MAX_VISIBLE} autres…
          </Link>
        )}
      </div>
    </div>
  );
}

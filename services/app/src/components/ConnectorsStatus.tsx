"use client";

import { useEffect, useState } from "react";

interface Connector {
  id: string;
  name: string;
  brand: string;
  icon: string;
  running: boolean;
}

export function ConnectorsStatus() {
  const [data, setData] = useState<{ connectors: Connector[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/connectors", { cache: "no-store" });
        if (r.ok && !cancelled) setData(await r.json());
      } catch { /* ignore */ }
    }
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!data) return null;

  // Affiche seulement les connecteurs qui tournent + ceux planifiés
  const running = data.connectors.filter((c) => c.running);
  const inactive = data.connectors.filter((c) => !c.running).slice(0, 3);

  return (
    <div className="px-3 mt-6">
      <div className="px-3 mb-2 text-xs uppercase tracking-wide text-muted">
        Connecteurs
      </div>
      <div className="space-y-0.5">
        {running.length === 0 && inactive.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">Aucun connecteur</div>
        )}
        {running.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs hover:bg-muted/20 transition-default"
            title={`${c.name} — actif`}
          >
            <span>{c.icon}</span>
            <span className="flex-1 truncate">{c.name}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          </div>
        ))}
        {running.length > 0 && inactive.length > 0 && <div className="my-2 border-t border-border" />}
        {inactive.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted/60 hover:bg-muted/10 transition-default"
            title={`${c.name} — inactif`}
          >
            <span className="opacity-50">{c.icon}</span>
            <span className="flex-1 truncate">{c.name}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-muted/40" />
          </div>
        ))}
      </div>
    </div>
  );
}

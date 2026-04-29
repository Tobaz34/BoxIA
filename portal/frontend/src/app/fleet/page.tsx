"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type FleetClient = {
  id: number;
  name: string;
  domain: string;
  status: "draft" | "deploying" | "deployed" | "failed";
  online: boolean;
  deployed_at: string | null;
};

type Overview = {
  total: number;
  deployed: number;
  online: number;
  clients: FleetClient[];
};

export default function FleetPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const r = await fetch("/api/fleet/overview", { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t); }, []);

  if (error) return (
    <div className="border border-danger/30 bg-danger/10 text-danger rounded p-4 text-sm">
      Backend injoignable : {error}
    </div>
  );

  return (
    <div className="grid gap-6">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">Parc clients</h1>
        <button onClick={refresh} className="btn">↻ Actualiser</button>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Stat label="Total" value={data?.total ?? "—"} />
        <Stat label="Déployés" value={data?.deployed ?? "—"} accent="accent" />
        <Stat label="En ligne" value={data?.online ?? "—"} accent={data && data.online < data.deployed ? "warn" : "accent"} />
      </section>

      <table className="w-full text-sm border rounded-lg overflow-hidden">
        <thead className="bg-panel2">
          <tr>
            <th className="p-3 text-left">Client</th>
            <th className="p-3 text-left">Domaine</th>
            <th className="p-3 text-left">Statut</th>
            <th className="p-3 text-left">Online</th>
            <th className="p-3 text-left">Déployé le</th>
            <th className="p-3"></th>
          </tr>
        </thead>
        <tbody>
          {(data?.clients || []).map((c) => (
            <tr key={c.id} className="border-t border-border hover:bg-panel">
              <td className="p-3 font-medium">{c.name}</td>
              <td className="p-3 font-mono text-xs">{c.domain}</td>
              <td className="p-3">{c.status}</td>
              <td className="p-3">
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${c.online ? "bg-accent" : "bg-danger"}`} />
                {c.online ? "online" : "offline"}
              </td>
              <td className="p-3 text-muted text-xs">
                {c.deployed_at ? new Date(c.deployed_at).toLocaleDateString("fr-FR") : "—"}
              </td>
              <td className="p-3 text-right">
                <Link href={`/clients/${c.id}`} className="text-primary hover:underline mr-3">Détails</Link>
                <UpdateButton id={c.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {loading && <p className="text-muted text-xs">Vérification en cours…</p>}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: "accent" | "warn" }) {
  return (
    <div className="bg-panel border rounded p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${accent === "accent" ? "text-accent" : accent === "warn" ? "text-warn" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function UpdateButton({ id }: { id: number }) {
  const [busy, setBusy] = useState(false);
  async function trigger() {
    if (!confirm("Lancer la mise à jour de ce client ? (backup auto avant)")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${id}/update`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      alert("MAJ lancée — voir les logs sur la page détail");
    } catch (e) {
      alert("Erreur : " + e);
    } finally { setBusy(false); }
  }
  return (
    <button onClick={trigger} disabled={busy} className="text-primary hover:underline text-xs disabled:opacity-50">
      {busy ? "…" : "↑ MAJ"}
    </button>
  );
}

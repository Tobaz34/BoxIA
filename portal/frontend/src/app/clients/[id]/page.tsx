"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Client } from "@/lib/api";

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    api.getClient(parseInt(id)).then(setClient).catch((e) => setError(String(e)));
  }, [id]);

  // WebSocket pour logs déploiement (v0.2 — endpoint à implémenter côté backend)
  useEffect(() => {
    if (client?.status !== "deploying") return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/clients/${id}/logs`);
    ws.onmessage = (e) => setLogs((l) => [...l.slice(-200), e.data]);
    ws.onerror = () => setLogs((l) => [...l, "[ws error]"]);
    return () => ws.close();
  }, [id, client?.status]);

  if (error) {
    return (
      <div className="border border-danger/30 bg-danger/10 text-danger rounded p-4 text-sm">
        Erreur : <code>{error}</code>
        <br /><Link href="/clients" className="underline">← retour</Link>
      </div>
    );
  }
  if (!client) return <p className="text-muted">Chargement…</p>;

  return (
    <div className="grid gap-6">
      <header>
        <Link href="/clients" className="text-sm text-muted hover:text-text">← Tous les clients</Link>
        <h1 className="text-2xl font-semibold mt-2">{client.name}</h1>
        <p className="text-muted">{client.sector} · {client.users_count} users · profil {client.hw_profile}</p>
      </header>

      <section className="grid sm:grid-cols-2 gap-4">
        <InfoCard label="Statut" value={client.status} />
        <InfoCard label="Domaine" value={client.domain} mono />
        <InfoCard label="Serveur cible" value={`${client.server_user}@${client.server_ip}`} mono />
        <InfoCard label="Email admin" value={client.admin_email} />
      </section>

      {client.config_yaml && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Configuration générée</h2>
          <pre className="bg-bg border rounded p-4 text-xs font-mono whitespace-pre-wrap">
            {client.config_yaml}
          </pre>
        </section>
      )}

      {client.status === "deploying" && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Logs de déploiement (live)</h2>
          <pre className="bg-black text-green-400 p-4 rounded text-xs font-mono h-80 overflow-y-auto">
            {logs.join("\n") || "(en attente de logs…)"}
          </pre>
        </section>
      )}

      {client.status === "deployed" && (
        <section className="border border-accent/30 bg-accent/10 text-accent rounded p-4">
          ✅ Déployée. <a href={`https://auth.${client.domain}`} className="underline">Ouvrir le dashboard</a>
        </section>
      )}
    </div>
  );
}

function InfoCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-panel border rounded p-4">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className={`mt-1 ${mono ? "font-mono text-sm" : "font-medium"}`}>{value}</div>
    </div>
  );
}

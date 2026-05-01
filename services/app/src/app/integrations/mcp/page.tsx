"use client";

/**
 * /integrations/mcp — admin only
 *
 * Liste les MCP servers (Model Context Protocol) attachés à Dify,
 * avec un bouton SSO pour aller en ajouter via la console Dify
 * (l'ajout d'un MCP requiert un schéma JSON inline + tests
 *  d'authentification, l'UX Dify console est plus aboutie).
 */
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Network, ExternalLink, Plus, RefreshCw, ShieldAlert, Server,
} from "lucide-react";

interface MCPServer {
  id?: string;
  name?: string;
  server_url?: string;
  server_identifier?: string;
  status?: string;
  tools?: Array<{ name: string; description?: string }>;
}

export default function MCPIntegrationsPage() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/dify/mcp", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.detail || `MCP indisponible (HTTP ${r.status})`);
        return;
      }
      const j = await r.json();
      setServers(j.servers || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (status === "authenticated") reload(); }, [status]);

  if (status === "loading") {
    return <div className="p-6 text-sm text-muted">Chargement…</div>;
  }
  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <ShieldAlert size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            La gestion des intégrations MCP est réservée aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Network size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Intégrations MCP</h1>
            <p className="text-sm text-muted">
              Model Context Protocol — connectez des serveurs externes (Slack,
              GitHub, base de données…) pour étendre les capacités des
              assistants.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reload}
            disabled={loading}
            className="p-2 rounded hover:bg-muted/20 text-muted hover:text-foreground transition-default"
            title="Rafraîchir"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
          <a
            href="/api/sso/dify?to=/tools?category=mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
            title="Ajouter un serveur MCP via la console Dify (auto-login)"
          >
            <Plus size={14} />
            Ajouter un serveur MCP
          </a>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-muted py-12">Chargement…</div>
      ) : servers.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <Server size={32} className="mx-auto text-muted mb-3" />
          <h2 className="font-medium mb-1">Aucun serveur MCP attaché</h2>
          <p className="text-sm text-muted max-w-md mx-auto">
            Le Model Context Protocol permet d&apos;intégrer des outils externes
            (Slack, GitHub, bases de données, filesystem…) accessibles à vos
            assistants. <br /><br />
            Cliquez sur <strong>« Ajouter un serveur MCP »</strong> pour
            ouvrir la console Dify (auto-login admin) et configurer un nouveau
            serveur.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {servers.map((s, i) => (
            <div key={s.id || s.server_identifier || i} className="px-4 py-3 flex items-start gap-3">
              <Server size={16} className="text-muted shrink-0 mt-1" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{s.name || "(sans nom)"}</div>
                {s.server_url && (
                  <div className="text-xs text-muted truncate font-mono mt-0.5">
                    {s.server_url}
                  </div>
                )}
                {s.tools && s.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.tools.slice(0, 6).map((t) => (
                      <span key={t.name} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/15 text-muted">
                        {t.name}
                      </span>
                    ))}
                    {s.tools.length > 6 && (
                      <span className="text-[10px] text-muted">+{s.tools.length - 6}</span>
                    )}
                  </div>
                )}
              </div>
              {s.status && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent">
                  {s.status}
                </span>
              )}
              <a
                href={`/api/sso/dify?to=/tools?category=mcp`}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded text-muted hover:text-foreground hover:bg-muted/20 transition-default"
                title="Configurer dans Dify"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg bg-muted/5 border border-border p-4 text-xs text-muted leading-relaxed">
        <strong>Qu&apos;est-ce que MCP ?</strong> Le Model Context Protocol
        (par Anthropic) est un standard ouvert pour exposer des outils, des
        ressources et des données à un LLM. Une fois un serveur MCP attaché,
        ses outils deviennent automatiquement utilisables par tous les
        assistants Dify configurés en mode <em>Agent</em>.
        <br /><br />
        Exemples de serveurs MCP communautaires :{" "}
        <a href="https://github.com/modelcontextprotocol/servers" target="_blank"
           rel="noopener noreferrer" className="text-primary hover:underline">
          modelcontextprotocol/servers
        </a> (filesystem, GitHub, GitLab, Postgres, Slack, Brave Search, etc.)
      </div>
    </div>
  );
}

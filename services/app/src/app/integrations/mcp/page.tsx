"use client";

/**
 * /integrations/mcp — admin only
 *
 * Marketplace MCP : 2 sections (catalogue 15+ serveurs MCP officiels +
 * communauté curée, et serveurs déjà attachés à Dify). L'install d'un
 * serveur MCP nécessite des credentials → on SSO l'admin vers Dify avec
 * les params pré-remplis pour finaliser la config (Dify console gère
 * mieux la validation auth + tests).
 */
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Network, ExternalLink, Plus, RefreshCw, ShieldAlert, Server, Search,
  KeyRound, CheckCircle2, AlertCircle,
} from "lucide-react";

interface McpConfigField {
  key: string;
  label: string;
  type: "string" | "secret";
}

interface McpServer {
  slug: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  transport: "stdio" | "sse";
  command: string;
  args: string[];
  env?: Record<string, string>;
  config_required: McpConfigField[];
  official: boolean;
  source_url: string;
  use_cases: string[];
}

interface McpCategory {
  id: string;
  label: string;
  icon: string;
}

interface McpCatalogResponse {
  version: number;
  categories: McpCategory[];
  servers: McpServer[];
}

interface AttachedMcp {
  id?: string;
  name?: string;
  server_url?: string;
  server_identifier?: string;
  status?: string;
  tools?: Array<{ name: string; description?: string }>;
}

type Tab = "catalog" | "attached";

export default function MCPIntegrationsPage() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [catalog, setCatalog] = useState<McpCatalogResponse | null>(null);
  const [attached, setAttached] = useState<AttachedMcp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("catalog");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cr, ar] = await Promise.all([
        fetch("/api/integrations/mcp/catalog", { cache: "no-store" }),
        fetch("/api/dify/mcp", { cache: "no-store" }),
      ]);
      if (cr.status === 403) {
        setError("Accès réservé aux administrateurs.");
        return;
      }
      if (cr.ok) {
        setCatalog(await cr.json());
      } else {
        const j = await cr.json().catch(() => ({}));
        setError(j.detail || `Catalogue MCP indisponible (HTTP ${cr.status})`);
      }
      if (ar.ok) {
        const aj = await ar.json();
        setAttached(aj.servers || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (status === "authenticated") reload(); }, [status]);

  const filteredServers = useMemo(() => {
    if (!catalog) return [];
    let list = catalog.servers;
    if (activeCategory !== "all") {
      list = list.filter((s) => s.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.use_cases.some((u) => u.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [catalog, activeCategory, search]);

  const counts = useMemo(() => {
    const total = catalog?.servers.length || 0;
    const official = catalog?.servers.filter((s) => s.official).length || 0;
    return { total, official, attached: attached.length };
  }, [catalog, attached]);

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
    <div className="p-6 max-w-7xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Network size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Marketplace MCP</h1>
            <p className="text-sm text-muted">
              Model Context Protocol — étendez vos assistants avec des serveurs
              MCP officiels Anthropic et communautaires curés.
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
            title="Ouvrir Dify (auto-login admin) section MCP"
          >
            <Plus size={14} />
            Ajouter dans Dify
          </a>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Onglets : Catalogue / Attachés à Dify */}
      <div className="mb-4 border-b border-border flex items-center gap-1">
        <button
          onClick={() => setTab("catalog")}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (tab === "catalog"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          📚 Catalogue
          <span className="ml-2 text-xs opacity-60">({counts.total})</span>
        </button>
        <button
          onClick={() => setTab("attached")}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (tab === "attached"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          🔌 Attachés à Dify
          <span className="ml-2 text-xs opacity-60">({counts.attached})</span>
        </button>
        <div className="ml-auto pr-2">
          <a
            href="https://github.com/modelcontextprotocol/servers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1"
          >
            Tous les serveurs MCP officiels <ExternalLink size={10} />
          </a>
        </div>
      </div>

      {tab === "catalog" && catalog && (
        <>
          {/* Filtres */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Rechercher un serveur MCP (filesystem, github, postgres…)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setActiveCategory("all")}
                className={
                  "px-2.5 py-1 text-xs rounded-md transition-default " +
                  (activeCategory === "all"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/15 text-muted hover:bg-muted/25")
                }
              >
                Tout
              </button>
              {catalog.categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCategory(c.id)}
                  className={
                    "px-2.5 py-1 text-xs rounded-md transition-default flex items-center gap-1 " +
                    (activeCategory === c.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/15 text-muted hover:bg-muted/25")
                  }
                >
                  <span aria-hidden>{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Grid serveurs */}
          {loading ? (
            <div className="text-center text-sm text-muted py-12">Chargement…</div>
          ) : filteredServers.length === 0 ? (
            <div className="text-center text-sm text-muted py-12">
              Aucun serveur trouvé.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredServers.map((s) => {
                const cat = catalog.categories.find((c) => c.id === s.category);
                const isOpen = expanded === s.slug;
                return (
                  <div
                    key={s.slug}
                    className="rounded-lg border border-border bg-card p-3 flex flex-col"
                  >
                    <div className="flex items-start gap-3 mb-2">
                      <div className="w-10 h-10 rounded-md bg-muted/15 flex items-center justify-center text-xl shrink-0">
                        {s.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm">{s.name}</span>
                          {s.official && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400"
                              title="Serveur MCP officiel Anthropic"
                            >
                              <CheckCircle2 size={9} />
                              Officiel
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded inline-block mt-0.5">
                          {cat?.label || s.category}
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-muted line-clamp-3 mb-2">
                      {s.description || "—"}
                    </p>

                    {s.config_required.length > 0 && (
                      <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 mb-2 flex items-start gap-1">
                        <KeyRound size={11} className="shrink-0 mt-0.5" />
                        <span>
                          Config requise : {s.config_required.map((c) => c.label.split(" ")[0]).join(", ")}
                        </span>
                      </div>
                    )}

                    {/* Détails dépliables */}
                    {isOpen && (
                      <div className="mb-2 text-[11px] text-muted bg-muted/10 rounded p-2 space-y-1.5">
                        {s.use_cases.length > 0 && (
                          <div>
                            <div className="font-medium text-foreground/80 mb-0.5">Cas d&apos;usage :</div>
                            <ul className="ml-3 list-disc space-y-0.5">
                              {s.use_cases.map((u) => <li key={u}>{u}</li>)}
                            </ul>
                          </div>
                        )}
                        <div>
                          <span className="font-medium text-foreground/80">Commande : </span>
                          <code className="font-mono text-[10px] break-all">
                            {s.command} {s.args.join(" ")}
                          </code>
                        </div>
                        {s.config_required.length > 0 && (
                          <div>
                            <div className="font-medium text-foreground/80 mb-0.5">À configurer dans Dify :</div>
                            {s.config_required.map((c) => (
                              <div key={c.key} className="ml-3 flex items-baseline gap-1.5">
                                <code className="font-mono text-[10px]">{c.key}</code>
                                {c.type === "secret" && (
                                  <span className="text-[9px] text-amber-400">secret</span>
                                )}
                                <span>— {c.label}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 mt-auto">
                      <button
                        onClick={() => setExpanded(isOpen ? null : s.slug)}
                        className="text-[11px] text-muted hover:text-foreground transition-default"
                      >
                        {isOpen ? "Masquer" : "Détails"}
                      </button>
                      <div className="flex items-center gap-1">
                        <a
                          href={s.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded text-muted hover:text-foreground hover:bg-muted/20 transition-default"
                          title="Voir le code source du serveur MCP"
                        >
                          <ExternalLink size={12} />
                        </a>
                        <a
                          href={`/api/sso/dify?to=/tools?category=mcp&hint=${encodeURIComponent(s.slug)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default flex items-center gap-1"
                        >
                          <Plus size={12} />
                          Configurer
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "attached" && (
        <>
          {loading ? (
            <div className="text-center text-sm text-muted py-12">Chargement…</div>
          ) : attached.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-12 text-center">
              <Server size={32} className="mx-auto text-muted mb-3" />
              <h2 className="font-medium mb-1">Aucun serveur MCP attaché</h2>
              <p className="text-sm text-muted max-w-md mx-auto">
                Choisissez un serveur dans le catalogue puis cliquez sur
                <strong> « Configurer »</strong> pour l&apos;ajouter dans Dify.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card divide-y divide-border">
              {attached.map((s, i) => (
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
                        {s.tools.slice(0, 8).map((t) => (
                          <span key={t.name} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/15 text-muted">
                            {t.name}
                          </span>
                        ))}
                        {s.tools.length > 8 && (
                          <span className="text-[10px] text-muted">+{s.tools.length - 8}</span>
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
                    href="/api/sso/dify?to=/tools?category=mcp"
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
        </>
      )}

      <div className="mt-6 rounded-lg bg-muted/5 border border-border p-4 text-xs text-muted leading-relaxed">
        <strong>Qu&apos;est-ce que MCP ?</strong> Le Model Context Protocol
        (par Anthropic, 2024) est un standard ouvert pour exposer des outils
        et données à un LLM. Une fois un serveur attaché à Dify, ses outils
        deviennent automatiquement utilisables par tous les assistants en
        mode <em>Agent</em>. <strong>15 serveurs curés</strong> dans le
        catalogue ci-dessus, parmi les{" "}
        <a href="https://github.com/modelcontextprotocol/servers" target="_blank"
           rel="noopener noreferrer" className="text-primary hover:underline">
          50+ officiels Anthropic
        </a> et 200+ communautaires.
      </div>
    </div>
  );
}

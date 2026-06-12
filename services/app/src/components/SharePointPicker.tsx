"use client";

/**
 * Picker visuel pour choisir des bibliothèques SharePoint à indexer.
 *
 * Workflow :
 *   1. L'admin a déjà connecté son compte Microsoft (sinon ce composant
 *      affiche "Connectez d'abord Microsoft").
 *   2. On liste les sites SharePoint accessibles (search ou tous).
 *   3. L'admin déplie un site → on liste ses drives (bibliothèques de
 *      documents) et il peut cocher ceux à indexer.
 *   4. Le composant remonte la sélection au parent via onChange — qui
 *      stocke `drive_ids[]` dans la config du connecteur SharePoint.
 *
 * Admin only.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Search, Loader2, AlertTriangle, ChevronDown, ChevronRight,
  Folder, Globe, ExternalLink,
} from "lucide-react";

interface Site {
  id: string;
  name?: string;
  displayName?: string;
  webUrl?: string;
  description?: string;
  lastModifiedDateTime?: string;
}

interface Drive {
  id: string;
  name?: string;
  driveType?: string;
  webUrl?: string;
  description?: string;
}

export interface SelectedDrive {
  drive_id: string;
  drive_name: string;
  site_id: string;
  site_name: string;
  web_url?: string;
}

export function SharePointPicker({
  selected, onChange,
}: {
  selected: SelectedDrive[];
  onChange: (sel: SelectedDrive[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<string | undefined>();

  const search = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/connectors/sharepoint/sites?q=${encodeURIComponent(q || "*")}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "load_failed");
        setSites([]);
      } else {
        setSites(j.sites || []);
        setAccount(j.account);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { search(""); }, [search]);

  const isSelected = (driveId: string) =>
    selected.some((s) => s.drive_id === driveId);

  function toggleDrive(site: Site, drive: Drive) {
    const already = isSelected(drive.id);
    if (already) {
      onChange(selected.filter((s) => s.drive_id !== drive.id));
    } else {
      onChange([
        ...selected,
        {
          drive_id: drive.id,
          drive_name: drive.name || "(sans nom)",
          site_id: site.id,
          site_name: site.displayName || site.name || "(site)",
          web_url: drive.webUrl,
        },
      ]);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") search(query); }}
            placeholder="Rechercher un site (laisser vide pour tous)"
            className="w-full bg-background border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <button
          onClick={() => search(query)}
          disabled={loading}
          className="px-3 py-2 text-xs rounded-md border border-border hover:bg-muted/20 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          Chercher
        </button>
      </div>

      {account && (
        <p className="text-[10px] text-muted">Connecté avec {account}</p>
      )}

      {error && (
        <div className="text-xs text-red-400 flex items-start gap-1">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {error}
          {error.startsWith("connector_not_connected") && (
            <span className="block">
              Connectez d'abord Microsoft 365 ci-dessus.
            </span>
          )}
        </div>
      )}

      {selected.length > 0 && (
        <div className="rounded-md bg-emerald-500/5 border border-emerald-500/30 p-2 text-xs">
          <div className="font-medium text-emerald-300 mb-1">
            {selected.length} bibliothèque{selected.length > 1 ? "s" : ""} sélectionnée{selected.length > 1 ? "s" : ""}
          </div>
          <ul className="space-y-0.5">
            {selected.map((s) => (
              <li key={s.drive_id} className="text-muted truncate">
                <Folder size={10} className="inline mr-1" />
                {s.site_name} → <span className="text-foreground">{s.drive_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sites && sites.length === 0 && !loading && !error && (
        <p className="text-xs text-muted">Aucun site trouvé.</p>
      )}

      {sites && sites.length > 0 && (
        <div className="space-y-1 max-h-80 overflow-auto">
          {sites.map((s) => (
            <SiteRow
              key={s.id}
              site={s}
              isSelected={isSelected}
              onToggleDrive={toggleDrive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SiteRow({
  site, isSelected, onToggleDrive,
}: {
  site: Site;
  isSelected: (driveId: string) => boolean;
  onToggleDrive: (site: Site, drive: Drive) => void;
}) {
  const [open, setOpen] = useState(false);
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function expand() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (drives) return; // already loaded
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/connectors/sharepoint/sites/${encodeURIComponent(site.id)}/drives`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!r.ok) setError(j.error || "load_failed");
      else setDrives(j.drives || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        onClick={expand}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/10 text-left"
      >
        {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
        <Globe size={14} className="text-muted" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{site.displayName || site.name}</div>
          {site.webUrl && (
            <div className="text-[10px] text-muted truncate">{site.webUrl}</div>
          )}
        </div>
        {site.webUrl && (
          <a
            href={site.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted hover:text-primary p-0.5"
          >
            <ExternalLink size={10} />
          </a>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          {loading && (
            <div className="text-[10px] text-muted flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> Chargement…
            </div>
          )}
          {error && (
            <div className="text-[10px] text-red-400">{error}</div>
          )}
          {drives && drives.length === 0 && !loading && (
            <div className="text-[10px] text-muted">Aucune bibliothèque accessible.</div>
          )}
          {drives && drives.length > 0 && (
            <ul className="space-y-1">
              {drives.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected(d.id)}
                    onChange={() => onToggleDrive(site, d)}
                    className="accent-primary"
                  />
                  <Folder size={11} className="text-muted shrink-0" />
                  <span className="text-xs truncate">{d.name || "(sans nom)"}</span>
                  {d.driveType && d.driveType !== "documentLibrary" && (
                    <span className="text-[9px] text-muted">({d.driveType})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

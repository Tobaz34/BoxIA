"use client";

/**
 * Panneau latéral listant les conversations de l'utilisateur courant.
 *
 * - Bouton "Nouvelle conversation" en haut
 * - Liste défilante avec nom, date relative
 * - Sélection courante surlignée
 * - Hover : actions renommer (auto-generate) + supprimer
 *
 * Communique avec le parent via callbacks (selection, refresh).
 */
import { Plus, Trash2, MessageSquare, MoreHorizontal, Wand2, Tag, Folder, FolderPlus, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TagEditPopover } from "./TagEditPopover";

interface FolderEntry {
  id: string;
  name: string;
  color: string;
}

// Inline (pas d'import depuis lib/conversation-tags qui touche à node:fs).
// Couleur stable basée sur hash du tag → badges visuellement distincts.
const TAG_PALETTE = [
  { bg: "bg-blue-500/15",    text: "text-blue-300" },
  { bg: "bg-emerald-500/15", text: "text-emerald-300" },
  { bg: "bg-purple-500/15",  text: "text-purple-300" },
  { bg: "bg-amber-500/15",   text: "text-amber-300" },
  { bg: "bg-pink-500/15",    text: "text-pink-300" },
  { bg: "bg-cyan-500/15",    text: "text-cyan-300" },
  { bg: "bg-rose-500/15",    text: "text-rose-300" },
  { bg: "bg-teal-500/15",    text: "text-teal-300" },
];
function tagColorClasses(tag: string): { bg: string; text: string } {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

export interface Conversation {
  id: string;
  name: string;
  created_at: number;
  updated_at?: number;
  status?: string;
}

interface Props {
  conversations: Conversation[];
  currentId: string;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string) => Promise<void>;
}

function relativeDate(epoch: number): string {
  const ms = Date.now() - epoch * 1000;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `il y a ${d} j`;
  return new Date(epoch * 1000).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
  });
}

/** Catégorise une conversation dans un bucket temporel pour l'affichage
 *  par groupes (Aujourd'hui / Hier / Cette semaine / Plus ancien). */
function dateBucket(epoch: number): string {
  const now = new Date();
  const date = new Date(epoch * 1000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, now)) return "Aujourd'hui";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Hier";
  // 7 derniers jours (mais pas hier ou aujourd'hui)
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  if (date >= sevenDaysAgo) return "Cette semaine";
  // 30 derniers jours
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  if (date >= thirtyDaysAgo) return "Ce mois-ci";
  return "Plus ancien";
}

const BUCKET_ORDER = [
  "Aujourd'hui",
  "Hier",
  "Cette semaine",
  "Ce mois-ci",
  "Plus ancien",
];

export function ConversationsList({
  conversations,
  currentId,
  loading,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: Props) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [tagPopoverFor, setTagPopoverFor] = useState<string | null>(null);
  const [tagsByConv, setTagsByConv] = useState<Record<string, string[]>>({});
  const [allTags, setAllTags] = useState<{ tag: string; count: number }[]>([]);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [folderAssignments, setFolderAssignments] = useState<Record<string, string | null>>({});
  const [filterFolder, setFilterFolder] = useState<string | null>(null);
  const [moveSubmenuFor, setMoveSubmenuFor] = useState<string | null>(null);

  const reloadFolders = useCallback(async () => {
    try {
      const r = await fetch("/api/conversations/folders", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        folders?: FolderEntry[];
        assignments?: Record<string, string | null>;
      };
      setFolders(j.folders || []);
      setFolderAssignments(j.assignments || {});
    } catch { /* silencieux */ }
  }, []);

  useEffect(() => { void reloadFolders(); }, [reloadFolders]);

  const createFolder = useCallback(async () => {
    const name = window.prompt("Nom du dossier (max 40 chars) :");
    if (!name?.trim()) return;
    await fetch("/api/conversations/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: name.trim() }),
    });
    await reloadFolders();
  }, [reloadFolders]);

  const deleteFolder = useCallback(async (folderId: string) => {
    if (!confirm("Supprimer ce dossier ? Les conversations seront déplacées vers la racine.")) return;
    await fetch("/api/conversations/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", folder_id: folderId }),
    });
    if (filterFolder === folderId) setFilterFolder(null);
    await reloadFolders();
  }, [filterFolder, reloadFolders]);

  const assignToFolder = useCallback(async (convId: string, folderId: string | null) => {
    await fetch("/api/conversations/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "assign",
        conversation_id: convId,
        folder_id: folderId,
      }),
    });
    setMoveSubmenuFor(null);
    setOpenMenu(null);
    await reloadFolders();
  }, [reloadFolders]);

  // Charge la map convId → tags + la liste agrégée des tags du user
  // (pour les pills filtre en haut). Refetch quand la liste de
  // conversations change.
  const reloadTags = useCallback(async () => {
    try {
      const r = await fetch("/api/conversations/tags", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        user_tags?: { tag: string; count: number }[];
        conv_tags?: Record<string, string[]>;
      };
      setTagsByConv(j.conv_tags || {});
      setAllTags(j.user_tags || []);
    } catch {
      /* silencieux : tags pas critiques */
    }
  }, []);

  useEffect(() => { void reloadTags(); }, [reloadTags, conversations.length]);

  // Ouvre le popover d'édition de tags pour cette conversation.
  // Le popover gère lui-même le POST + reload via le callback onSaved.
  const openTagPopover = useCallback((convId: string) => {
    setOpenMenu(null);
    setTagPopoverFor(convId);
  }, []);

  // Filtrage combiné : tag ET folder. Les 2 filtres peuvent être actifs
  // simultanément (genre filtre folder=ACME + tag=urgent).
  const visibleConvs = conversations
    .filter((c) => !filterTag || (tagsByConv[c.id] || []).includes(filterTag))
    .filter((c) => !filterFolder || folderAssignments[c.id] === filterFolder);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="p-3 border-b border-border">
        <button
          onClick={onNew}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
        >
          <Plus size={16} />
          Nouvelle conversation
        </button>
      </div>

      {/* Section Dossiers — accordion compact en haut de la sidebar.
          Chaque dossier est cliquable pour filtrer ; bouton + pour
          créer ; bouton × pour supprimer (visible au hover). */}
      <div className="px-2 py-1.5 border-b border-border">
        <div className="flex items-center justify-between mb-1 px-1">
          <span className="text-[10px] uppercase tracking-wide text-muted font-medium">
            Dossiers
          </span>
          <button
            onClick={createFolder}
            className="p-0.5 rounded hover:bg-muted/30 text-muted"
            title="Nouveau dossier"
          >
            <FolderPlus size={12} />
          </button>
        </div>
        {folders.length === 0 && (
          <div className="px-1 text-[10px] text-muted">
            Aucun dossier. <button onClick={createFolder} className="underline hover:text-foreground">Créer</button>.
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {filterFolder && (
            <button
              onClick={() => setFilterFolder(null)}
              className="text-left text-[11px] px-1 py-0.5 rounded text-muted hover:text-foreground"
            >
              ✕ Voir tous les dossiers
            </button>
          )}
          {folders.map((f) => {
            const active = filterFolder === f.id;
            const count = Object.values(folderAssignments).filter(
              (fid) => fid === f.id,
            ).length;
            return (
              <div
                key={f.id}
                className={
                  "group flex items-center gap-1.5 px-1 py-0.5 rounded text-[11px] cursor-pointer transition-default " +
                  (active
                    ? "bg-muted/40 text-foreground"
                    : "hover:bg-muted/20 text-foreground/80")
                }
                onClick={() => setFilterFolder(active ? null : f.id)}
              >
                {active ? (
                  <FolderOpen size={11} style={{ color: f.color }} />
                ) : (
                  <Folder size={11} style={{ color: f.color }} />
                )}
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-[9px] text-muted">{count}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteFolder(f.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 text-muted hover:text-red-400"
                  title="Supprimer le dossier"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filtre par tag — pills horizontales, scroll-x si beaucoup. */}
      {allTags.length > 0 && (
        <div className="px-2 py-1.5 border-b border-border flex gap-1 overflow-x-auto">
          {filterTag && (
            <button
              onClick={() => setFilterTag(null)}
              className="shrink-0 px-2 py-0.5 text-[10px] rounded bg-muted/30 text-foreground hover:bg-muted/50 transition-default"
            >
              ✕ Filtre
            </button>
          )}
          {allTags.slice(0, 12).map(({ tag, count }) => {
            const active = filterTag === tag;
            const c = tagColorClasses(tag);
            return (
              <button
                key={tag}
                onClick={() => setFilterTag(active ? null : tag)}
                className={
                  "shrink-0 px-2 py-0.5 text-[10px] rounded transition-default " +
                  (active
                    ? `${c.bg} ${c.text} ring-1 ring-current`
                    : `${c.bg} ${c.text} opacity-70 hover:opacity-100`)
                }
                title={`${count} conversation${count > 1 ? "s" : ""}`}
              >
                #{tag}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && conversations.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">Chargement…</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="px-3 py-6 text-xs text-muted text-center">
            Aucune conversation.<br />Lancez-en une pour commencer.
          </div>
        )}
        {!loading && filterTag && visibleConvs.length === 0 && (
          <div className="px-3 py-6 text-xs text-muted text-center">
            Aucune conversation avec le tag <strong>#{filterTag}</strong>.
          </div>
        )}
        {/* Grouper les conversations par bucket temporel pour faciliter
            la navigation quand l'historique grossit. */}
        {(() => {
          const groups: Record<string, Conversation[]> = {};
          for (const c of visibleConvs) {
            const bucket = dateBucket(c.updated_at || c.created_at);
            (groups[bucket] ||= []).push(c);
          }
          return BUCKET_ORDER.filter((b) => groups[b]?.length).map((bucket) => (
            <div key={bucket} className="mb-3">
              <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted font-medium">
                {bucket}
              </div>
              {groups[bucket].map((c) => {
                const active = c.id === currentId;
                return (
                  <div
                    key={c.id}
                    className={
                      "group relative flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer text-sm transition-default " +
                      (active
                        ? "bg-primary/15 text-foreground"
                        : "hover:bg-muted/20 text-foreground/90")
                    }
                    onClick={() => onSelect(c.id)}
                  >
                    <MessageSquare
                      size={14}
                      className={active ? "text-primary shrink-0" : "text-muted shrink-0"}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">
                        {c.name && c.name !== "New conversation"
                          ? c.name
                          : "Sans titre"}
                      </div>
                      <div className="text-[10px] text-muted flex items-center gap-1.5 flex-wrap">
                        <span>{relativeDate(c.updated_at || c.created_at)}</span>
                        {(tagsByConv[c.id] || []).map((t) => {
                          const cls = tagColorClasses(t);
                          return (
                            <span
                              key={t}
                              className={
                                "px-1 py-px rounded text-[9px] " +
                                `${cls.bg} ${cls.text}`
                              }
                              title={`Tag : ${t}`}
                            >
                              #{t}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted/40 transition-default"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenu(openMenu === c.id ? null : c.id);
                      }}
                      title="Actions"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === c.id && (
                      <div
                        className="absolute right-1 top-9 z-10 w-44 rounded-md border border-border bg-card shadow-lg py-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-default"
                          onClick={async () => {
                            setOpenMenu(null);
                            await onRename(c.id);
                          }}
                        >
                          <Wand2 size={12} /> Renommer (auto)
                        </button>
                        <button
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-default"
                          onClick={() => openTagPopover(c.id)}
                        >
                          <Tag size={12} /> Tags…
                        </button>
                        {/* Sous-menu Déplacer vers : liste des folders + Racine */}
                        <div className="relative">
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-default"
                            onClick={() => setMoveSubmenuFor(moveSubmenuFor === c.id ? null : c.id)}
                          >
                            <Folder size={12} />
                            Déplacer vers…
                            {folderAssignments[c.id] && (
                              <span className="ml-auto text-[9px] text-muted">
                                {folders.find((f) => f.id === folderAssignments[c.id])?.name}
                              </span>
                            )}
                          </button>
                          {moveSubmenuFor === c.id && (
                            <div className="absolute right-full top-0 mr-1 w-44 rounded-md border border-border bg-card shadow-lg py-1 max-h-60 overflow-auto">
                              {folderAssignments[c.id] && (
                                <button
                                  onClick={() => assignToFolder(c.id, null)}
                                  className="w-full text-left px-3 py-1 text-xs text-muted hover:bg-muted/30"
                                >
                                  ✕ Retirer du dossier
                                </button>
                              )}
                              {folders.length === 0 && (
                                <div className="px-3 py-2 text-[11px] text-muted">
                                  Aucun dossier. Crée-en un d&apos;abord.
                                </div>
                              )}
                              {folders.map((f) => (
                                <button
                                  key={f.id}
                                  onClick={() => assignToFolder(c.id, f.id)}
                                  className={
                                    "w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/30 " +
                                    (folderAssignments[c.id] === f.id ? "bg-muted/30" : "")
                                  }
                                >
                                  <Folder size={11} style={{ color: f.color }} />
                                  <span className="truncate">{f.name}</span>
                                  {folderAssignments[c.id] === f.id && <span className="ml-auto">✓</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-default"
                          onClick={async () => {
                            setOpenMenu(null);
                            if (confirm("Supprimer cette conversation ?")) {
                              await onDelete(c.id);
                            }
                          }}
                        >
                          <Trash2 size={12} /> Supprimer
                        </button>
                      </div>
                    )}
                    {tagPopoverFor === c.id && (
                      <TagEditPopover
                        conversationId={c.id}
                        initialTags={tagsByConv[c.id] || []}
                        knownTags={allTags}
                        onClose={() => setTagPopoverFor(null)}
                        onSaved={() => { void reloadTags(); }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ));
        })()}
      </div>
    </div>
  );
}

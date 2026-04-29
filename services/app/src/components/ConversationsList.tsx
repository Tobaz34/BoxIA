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
import { Plus, Trash2, MessageSquare, MoreHorizontal, Wand2 } from "lucide-react";
import { useState } from "react";

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

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-card flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <button
          onClick={onNew}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
        >
          <Plus size={16} />
          Nouvelle conversation
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && conversations.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">Chargement…</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="px-3 py-6 text-xs text-muted text-center">
            Aucune conversation.<br />Lancez-en une pour commencer.
          </div>
        )}
        {conversations.map((c) => {
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
                <div className="text-[10px] text-muted">
                  {relativeDate(c.updated_at || c.created_at)}
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
            </div>
          );
        })}
      </div>
    </aside>
  );
}

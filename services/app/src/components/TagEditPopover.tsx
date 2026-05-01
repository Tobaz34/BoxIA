"use client";

/**
 * Popover d'édition des tags d'une conversation. Remplace le prompt()
 * natif du MVP par une vraie UX :
 *   - Affiche les tags actuels comme chips supprimables (×)
 *   - Input avec autocomplete sur les tags existants du user
 *   - Suggère les tags les plus utilisés (top-5) en pills cliquables
 *   - Validation tag-par-tag : Enter ou clic sur suggestion ajoute
 *   - Save avec Cmd/Ctrl+Enter, ou bouton « Enregistrer »
 *   - Escape ou click outside ferme sans sauver
 *
 * Construit comme un dropdown ancré sur le bouton « Tags… » du menu
 * d'actions de la conversation. Largeur fixe ~280px.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tag, Check, X } from "lucide-react";

interface KnownTag {
  tag: string;
  count: number;
}

interface Props {
  conversationId: string;
  initialTags: string[];
  knownTags: KnownTag[];
  onClose: () => void;
  onSaved: (tags: string[]) => void;
}

const MAX_TAGS = 8;

function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9À-ſ-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

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
function colorFor(tag: string): { bg: string; text: string } {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

export function TagEditPopover({
  conversationId,
  initialTags,
  knownTags,
  onClose,
  onSaved,
}: Props) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Focus input au mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fermer au clic extérieur ou Escape
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Suggestions filtrées : tags connus que l'utilisateur a déjà
  // utilisés, exclus ceux déjà ajoutés sur cette conversation, et
  // matchant l'input courant si non vide.
  const suggestions = useMemo(() => {
    const lower = input.trim().toLowerCase();
    return knownTags
      .filter((k) => !tags.includes(k.tag))
      .filter((k) => !lower || k.tag.toLowerCase().includes(lower))
      .slice(0, 8);
  }, [knownTags, tags, input]);

  const addTag = useCallback((raw: string) => {
    const t = normalize(raw);
    if (!t) return;
    if (tags.includes(t)) {
      setError(`« ${t} » déjà présent`);
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setError(`Maximum ${MAX_TAGS} tags par conversation`);
      return;
    }
    setTags((cur) => [...cur, t]);
    setInput("");
    setError(null);
  }, [tags]);

  const removeTag = useCallback((t: string) => {
    setTags((cur) => cur.filter((x) => x !== t));
    setError(null);
  }, []);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.trim()) addTag(input);
      else if (e.metaKey || e.ctrlKey) void save();
    } else if (e.key === "," || e.key === " ") {
      // Espace ou virgule = séparateur naturel
      if (input.trim()) {
        e.preventDefault();
        addTag(input);
      }
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/conversations/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, tags }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      const j = await r.json();
      onSaved(j.tags || []);
      onClose();
    } catch (e: unknown) {
      setError(`Erreur réseau : ${String(e).slice(0, 80)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="absolute right-0 top-9 z-30 w-72 rounded-md border border-border bg-card shadow-xl p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-foreground/90">
        <Tag size={12} />
        Tags ({tags.length}/{MAX_TAGS})
      </div>

      {/* Tags actuels (chips supprimables) */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {tags.map((t) => {
            const c = colorFor(t);
            return (
              <span
                key={t}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] ${c.bg} ${c.text}`}
              >
                #{t}
                <button
                  onClick={() => removeTag(t)}
                  className="hover:bg-black/20 rounded-sm"
                  title="Retirer"
                >
                  <X size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Input nouveau tag */}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onInputKey}
        placeholder="Nouveau tag (Entrée pour ajouter)…"
        maxLength={30}
        className="w-full px-2 py-1.5 text-xs rounded bg-background border border-border focus:outline-none focus:border-primary"
      />

      {/* Suggestions (tags déjà utilisés) */}
      {suggestions.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] text-muted mb-1">
            {input.trim() ? "Suggestions" : "Vos tags les plus utilisés"}
          </div>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((s) => {
              const c = colorFor(s.tag);
              return (
                <button
                  key={s.tag}
                  onClick={() => addTag(s.tag)}
                  className={`px-1.5 py-0.5 rounded text-[10px] hover:opacity-100 opacity-70 transition-default ${c.bg} ${c.text}`}
                  title={`Utilisé dans ${s.count} conversation${s.count > 1 ? "s" : ""}`}
                >
                  #{s.tag}
                  <span className="ml-1 opacity-60">{s.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-red-400">{error}</div>
      )}

      <div className="flex justify-end gap-1.5 mt-3 pt-2 border-t border-border">
        <button
          onClick={onClose}
          className="px-2.5 py-1 text-[11px] rounded border border-border hover:bg-muted/30 transition-default"
        >
          Annuler
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-default"
        >
          <Check size={12} />
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}

"use client";

/**
 * Sélecteur d'agent (en haut du panneau conversations).
 *
 * Bouton compact qui montre l'agent actif (icône + nom) et déroule la
 * liste des autres agents disponibles. Click sur un autre → callback.
 * Si un seul agent est disponible, on n'affiche pas le chevron (juste
 * le nom, en lecture seule).
 */
import { ChevronDown, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface AgentMeta {
  slug: string;
  name: string;
  icon: string;
  description: string;
  isDefault?: boolean;
  /** Modèle multimodal (vision). L'UI affiche le bouton paperclip
   *  uniquement quand ce flag est vrai. */
  vision?: boolean;
}

interface Props {
  agents: AgentMeta[];
  currentSlug: string;
  onChange: (slug: string) => void;
}

export function AgentPicker({ agents, currentSlug, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click outside → fermeture
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current =
    agents.find((a) => a.slug === currentSlug) ||
    agents[0] || { slug: "", name: "—", icon: "?", description: "" };

  const single = agents.length <= 1;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={single}
        onClick={() => setOpen((v) => !v)}
        className={
          "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-default border " +
          (single
            ? "border-transparent cursor-default"
            : "border-border hover:border-primary hover:bg-muted/15")
        }
      >
        <span className="text-base leading-none">{current.icon}</span>
        <div className="flex-1 min-w-0 text-left">
          <div className="truncate font-medium">{current.name}</div>
          <div className="truncate text-[10px] text-muted">
            {current.description}
          </div>
        </div>
        {!single && (
          <ChevronDown
            size={14}
            className={
              "text-muted transition-default " + (open ? "rotate-180" : "")
            }
          />
        )}
      </button>

      {open && !single && (
        <div className="absolute z-20 mt-1 left-0 right-0 rounded-md border border-border bg-card shadow-lg py-1 max-h-80 overflow-auto">
          {agents.map((a) => {
            const active = a.slug === currentSlug;
            return (
              <button
                key={a.slug}
                onClick={() => {
                  setOpen(false);
                  onChange(a.slug);
                }}
                className={
                  "w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-default " +
                  (active
                    ? "bg-primary/15 text-foreground"
                    : "hover:bg-muted/20")
                }
              >
                <span className="text-base leading-none">{a.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{a.name}</div>
                  <div className="text-[10px] text-muted truncate">
                    {a.description}
                  </div>
                </div>
                {active && <Check size={14} className="text-primary shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

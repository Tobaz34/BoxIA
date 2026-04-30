"use client";

/**
 * Menu de commandes slash (/) pour le chat.
 *
 * Apparaît au-dessus du textarea quand le contenu commence par `/` et
 * propose les commandes disponibles, filtrées par ce que l'utilisateur tape.
 *
 * Navigation : flèches haut/bas pour sélectionner, Entrée pour valider,
 * Échap pour fermer. Click souris aussi possible.
 */
import { CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

export interface SlashCommand {
  /** Nom court (sans le `/`). Ex: "new", "regen". */
  name: string;
  /** Description courte (1 ligne). */
  description: string;
  /** Icône (component lucide ou emoji). */
  icon: ReactNode;
  /** Si la commande prend un argument, l'afficher en hint. */
  argumentHint?: string;
  /** Aliases qui matchent la même commande (ex: "new", "n"). */
  aliases?: string[];
  /** Callback à exécuter. Reçoit l'argument (string post-espace) ou "". */
  run: (arg: string) => void;
}

interface Props {
  /** Texte du textarea. La menu n'apparaît que si ça commence par `/`. */
  input: string;
  /** Liste des commandes. */
  commands: SlashCommand[];
  /** Callback : signale que l'input doit être effacé (commande exécutée). */
  onCommandRun: () => void;
}

export function SlashCommandMenu({ input, commands, onCommandRun }: Props) {
  // Match toutes les commandes dont le nom OU un alias commence par ce que
  // l'user a tapé après `/` (case-insensitive, ignore l'argument après l'espace).
  const filtered = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const head = input.slice(1).split(" ")[0].toLowerCase();
    if (!head) return commands;
    return commands.filter((c) =>
      c.name.toLowerCase().startsWith(head) ||
      (c.aliases || []).some((a) => a.toLowerCase().startsWith(head))
    );
  }, [input, commands]);

  const [selectedIdx, setSelectedIdx] = useState(0);

  // Reset l'index quand la liste change ou disparaît
  useEffect(() => {
    setSelectedIdx(0);
  }, [filtered.length]);

  // Gestion clavier au niveau document — on intercepte ↑↓Enter/Esc
  // uniquement quand le menu est ouvert (filtered.length > 0).
  useEffect(() => {
    if (filtered.length === 0) return;
    function onKey(e: KeyboardEvent) {
      // Ignore si l'user tape dans un autre champ (sauf le textarea de chat)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== "TEXTAREA") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const cmd = filtered[selectedIdx];
        if (cmd) {
          const arg = input.slice(1 + cmd.name.length).trim();
          cmd.run(arg);
          onCommandRun();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCommandRun();  // close = clear input
      } else if (e.key === "Tab") {
        // Auto-complete sur le 1er match sans valider
        e.preventDefault();
        const cmd = filtered[selectedIdx];
        // remplace l'input par /<name> + (espace si argument)
        const ev = new CustomEvent("aibox-slash-complete", {
          detail: "/" + cmd.name + (cmd.argumentHint ? " " : ""),
        });
        window.dispatchEvent(ev);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, selectedIdx, input, onCommandRun]);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 bg-card border border-border rounded-lg shadow-lg overflow-hidden max-h-[320px] overflow-y-auto z-20">
      <div className="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wide text-muted bg-muted/10">
        Commandes — ↑↓ pour naviguer, ⏎ pour valider, ⇥ auto-complète
      </div>
      {filtered.map((c, i) => (
        <button
          key={c.name}
          onClick={() => {
            const arg = input.slice(1 + c.name.length).trim();
            c.run(arg);
            onCommandRun();
          }}
          onMouseEnter={() => setSelectedIdx(i)}
          className={
            "w-full px-3 py-2 flex items-start gap-3 text-left transition-default " +
            (i === selectedIdx ? "bg-primary/15" : "hover:bg-muted/15")
          }
        >
          <span className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded bg-muted/15 text-primary">
            {c.icon}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <code className="font-mono">/{c.name}</code>
              {c.argumentHint && (
                <span className="text-muted text-xs">{c.argumentHint}</span>
              )}
            </div>
            <div className="text-xs text-muted truncate">{c.description}</div>
          </div>
          {i === selectedIdx && (
            <CornerDownLeft size={12} className="shrink-0 mt-1 text-muted" />
          )}
        </button>
      ))}
    </div>
  );
}

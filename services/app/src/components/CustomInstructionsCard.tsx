"use client";

/**
 * Carte de gestion des "Custom Instructions" (équivalent ChatGPT).
 *
 * 2 champs (about / response_style), persistés dans localStorage et
 * injectés en préfixe du 1er message de chaque nouvelle conversation
 * par <Chat>. Pas de stockage serveur pour cette V1 — donc local au
 * navigateur.
 */
import { Check, Save } from "lucide-react";
import { useEffect, useState } from "react";

const LS_KEY = "aibox.customInstructions";
const LS_KEY_LEGACY = "aibox.customInstructions.legacy"; // unused, future-proof

interface Stored {
  about?: string;
  responseStyle?: string;
}

function load(): Stored {
  if (typeof window === "undefined") return {};
  // Format compact stocké : "[A propos de moi]\n...\n\n[Style de réponse]\n..."
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return {};
  // On stocke les 2 sections explicitement (JSON) côté UI, et on assemble
  // un texte unique au moment d'envoyer au modèle. Compatibilité :
  try {
    return JSON.parse(raw) as Stored;
  } catch {
    return { about: raw };
  }
}

function save(s: Stored) {
  if (typeof window === "undefined") return;
  // Sauve la version structurée et un cache "compilé" pour Chat.tsx
  localStorage.setItem(LS_KEY + ".structured", JSON.stringify(s));
  const compiled = compile(s);
  if (compiled) {
    localStorage.setItem(LS_KEY, compiled);
  } else {
    localStorage.removeItem(LS_KEY);
  }
}

function compile(s: Stored): string {
  const parts: string[] = [];
  if (s.about?.trim()) parts.push(`À propos de moi :\n${s.about.trim()}`);
  if (s.responseStyle?.trim()) {
    parts.push(`Style de réponse souhaité :\n${s.responseStyle.trim()}`);
  }
  return parts.join("\n\n");
}

function loadStructured(): Stored {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(LS_KEY + ".structured");
  if (raw) {
    try {
      return JSON.parse(raw) as Stored;
    } catch { /* fallthrough */ }
  }
  return load();
}

export function CustomInstructionsCard() {
  const [about, setAbout] = useState("");
  const [style, setStyle] = useState("");
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const s = loadStructured();
    setAbout(s.about || "");
    setStyle(s.responseStyle || "");
    setHydrated(true);
    // Avoid lint warning — loadStructured is defined module-scope
    void LS_KEY_LEGACY;
  }, []);

  function handleSave() {
    save({ about, responseStyle: style });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function handleClear() {
    setAbout("");
    setStyle("");
    save({});
  }

  if (!hydrated) return null;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <h2 className="font-semibold mb-1">Instructions personnalisées</h2>
      <p className="text-xs text-muted mb-4">
        Indications que les assistants prendront en compte dans toutes vos
        nouvelles conversations. Stockées localement dans votre navigateur.
      </p>

      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium mb-1 block">
            À propos de vous
          </label>
          <p className="text-[11px] text-muted mb-2">
            Qu'est-ce que l'assistant devrait savoir ? (votre rôle, votre
            entreprise, votre secteur, vos préférences…)
          </p>
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={4}
            placeholder="Ex : Je suis André, dirigeant d'une TPE de services informatiques (8 personnes)…"
            className="w-full resize-y bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary transition-default"
          />
          <div className="text-[10px] text-muted mt-0.5 text-right">
            {about.length} caractères
          </div>
        </div>

        <div>
          <label className="text-xs font-medium mb-1 block">
            Comment l'assistant doit-il vous répondre ?
          </label>
          <p className="text-[11px] text-muted mb-2">
            Ton, format, niveau de détail… (« concis », « toujours en
            tableau si possible », « avec des exemples concrets »…)
          </p>
          <textarea
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            rows={3}
            placeholder="Ex : Réponses courtes (max 200 mots), tutoiement, exemples concrets, pas de blabla."
            className="w-full resize-y bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary transition-default"
          />
          <div className="text-[10px] text-muted mt-0.5 text-right">
            {style.length} caractères
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleClear}
            disabled={!about && !style}
            className="text-xs text-muted hover:text-foreground transition-default disabled:opacity-40"
          >
            Tout effacer
          </button>
          <button
            onClick={handleSave}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? "Enregistré" : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}

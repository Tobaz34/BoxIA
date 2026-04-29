"use client";

import { Send, Paperclip, Sparkles } from "lucide-react";
import { useState } from "react";

const SUGGESTIONS = [
  "Résume mes emails non lus",
  "Génère un devis pour Acme SARL",
  "Quelle est la procédure de demande de congés ?",
  "Combien de tickets ouverts cette semaine ?",
];

export function ChatPlaceholder() {
  const [input, setInput] = useState("");

  return (
    <div className="h-full flex flex-col">
      {/* Zone messages (vide au démarrage) */}
      <div className="flex-1 overflow-auto flex items-center justify-center px-6">
        <div className="max-w-2xl w-full text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/15 text-primary mb-4">
            <Sparkles size={32} />
          </div>
          <h1 className="text-3xl font-semibold mb-2">Bonjour 👋</h1>
          <p className="text-muted text-lg">
            Je suis votre assistant IA local. Posez-moi une question.
          </p>

          {/* Suggestions */}
          <div className="grid sm:grid-cols-2 gap-2 mt-8">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setInput(s)}
                className="text-left px-4 py-3 rounded-lg border border-border bg-card hover:border-primary hover:bg-primary/5 transition-default text-sm"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Input bottom */}
      <div className="border-t border-border bg-card p-4">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <button
            className="p-2 rounded-md text-muted hover:bg-muted/30 transition-default shrink-0"
            title="Joindre un fichier"
          >
            <Paperclip size={18} />
          </button>
          <div className="flex-1 min-h-10">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Écrivez votre message..."
              rows={1}
              className="w-full resize-none bg-background border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-default"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  // TODO: envoi → /api/chat (sprint 2)
                  alert(`(stub) message: ${input}`);
                }
              }}
            />
          </div>
          <button
            className="p-2.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default disabled:opacity-40 shrink-0"
            disabled={!input.trim()}
            title="Envoyer"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-xs text-muted text-center mt-2">
          Toutes les conversations restent sur ce serveur. Aucune donnée ne sort.
        </p>
      </div>
    </div>
  );
}

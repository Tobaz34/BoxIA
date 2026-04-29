"use client";

/**
 * Composant Chat principal — branché sur /api/chat (proxy SSE Dify).
 *
 * Spec :
 *   - Écran d'accueil avec suggestions tant qu'aucun message
 *   - Bulles user (droite) / assistant (gauche)
 *   - Streaming des tokens en temps réel
 *   - Auto-scroll vers le bas
 *   - Cmd/Ctrl+Enter envoie aussi (en plus de Enter)
 *   - Affiche un état d'erreur lisible si pas d'agent par défaut
 */

import { Send, Paperclip, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Role = "user" | "assistant";
interface Message {
  id: string;
  role: Role;
  content: string;
}

const SUGGESTIONS = [
  "Résume mes emails non lus",
  "Génère un devis pour Acme SARL",
  "Quelle est la procédure de demande de congés ?",
  "Combien de tickets ouverts cette semaine ?",
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  async function send(query: string) {
    const q = query.trim();
    if (!q || streaming) return;

    setError(null);
    setInput("");
    const userMsg: Message = { id: uid(), role: "user", content: q };
    const asstMsg: Message = { id: uid(), role: "assistant", content: "" };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, conversation_id: conversationId }),
        signal: ctrl.signal,
      });

      if (!r.ok) {
        let msg = `Erreur ${r.status}`;
        try {
          const j = await r.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* keep status */ }
        setError(msg);
        // remove the empty assistant bubble
        setMessages((m) => m.filter((x) => x.id !== asstMsg.id));
        return;
      }

      // Parse SSE stream from Dify
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events séparés par \n\n
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const data = JSON.parse(payload);
              if (data.conversation_id && !conversationId) {
                setConversationId(data.conversation_id);
              }
              if (data.event === "message" && typeof data.answer === "string") {
                setMessages((m) =>
                  m.map((x) =>
                    x.id === asstMsg.id
                      ? { ...x, content: x.content + data.answer }
                      : x,
                  ),
                );
              } else if (data.event === "error") {
                setError(data.message || "Erreur Dify");
              }
            } catch {
              // payload non-JSON, ignore
            }
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string };
      if (err?.name !== "AbortError") {
        setError("Connexion interrompue");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const empty = messages.length === 0;

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-6">
        {empty ? (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-2xl w-full text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/15 text-primary mb-4">
                <Sparkles size={32} />
              </div>
              <h1 className="text-3xl font-semibold mb-2">Bonjour 👋</h1>
              <p className="text-muted text-lg">
                Je suis votre assistant IA local. Posez-moi une question.
              </p>
              <div className="grid sm:grid-cols-2 gap-2 mt-8">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left px-4 py-3 rounded-lg border border-border bg-card hover:border-primary hover:bg-primary/5 transition-default text-sm"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[75%] px-4 py-2.5 rounded-2xl bg-primary text-primary-foreground whitespace-pre-wrap"
                      : "max-w-[85%] px-4 py-2.5 rounded-2xl bg-card border border-border whitespace-pre-wrap"
                  }
                >
                  {m.content || (m.role === "assistant" && streaming ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="px-6 pb-2">
          <div className="max-w-3xl mx-auto rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
            {error}
          </div>
        </div>
      )}

      <div className="border-t border-border bg-card p-4">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <button
            className="p-2 rounded-md text-muted hover:bg-muted/30 transition-default shrink-0"
            title="Joindre un fichier"
            disabled
          >
            <Paperclip size={18} />
          </button>
          <div className="flex-1 min-h-10">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Écrivez votre message..."
              rows={1}
              disabled={streaming}
              className="w-full resize-none bg-background border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-default disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
          </div>
          {streaming ? (
            <button
              onClick={stop}
              className="p-2.5 rounded-md bg-muted/40 text-foreground hover:bg-muted/60 transition-default shrink-0"
              title="Arrêter"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              className="p-2.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default disabled:opacity-40 shrink-0"
              disabled={!input.trim()}
              title="Envoyer"
            >
              <Send size={18} />
            </button>
          )}
        </div>
        <p className="text-xs text-muted text-center mt-2">
          Toutes les conversations restent sur ce serveur. Aucune donnée ne sort.
        </p>
      </div>
    </div>
  );
}

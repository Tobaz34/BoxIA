"use client";

/**
 * Chat principal — toutes fonctionnalités Phase A :
 *   - Liste des conversations (sidebar) + bouton "Nouvelle conversation"
 *   - Persistence côté Dify (chargement de l'historique)
 *   - Markdown + code blocks + copier (via MessageMarkdown)
 *   - Streaming SSE temps réel
 *   - Auto-resize textarea
 *   - Avatars + dates relatives
 *   - Boutons par message : Copier, Régénérer, Like/Dislike
 *   - Questions suggérées après chaque réponse
 *   - Bouton Stop pendant streaming
 *   - Erreurs lisibles
 */

import {
  Send, Square, Sparkles, RotateCcw, Copy, Check,
  ThumbsUp, ThumbsDown, User as UserIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ConversationsList, type Conversation } from "./ConversationsList";
import { MessageMarkdown } from "./MessageMarkdown";

type Role = "user" | "assistant";
interface Message {
  id: string;             // local UI id
  role: Role;
  content: string;
  difyMessageId?: string; // pour feedback / suggestions (assistant only)
  feedback?: "like" | "dislike" | null;
  createdAt: number;      // ms
}

const SUGGESTIONS_INITIAL = [
  "Résume mes emails non lus",
  "Génère un devis pour Acme SARL",
  "Quelle est la procédure de demande de congés ?",
  "Combien de tickets ouverts cette semaine ?",
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function timeShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function Chat() {
  const { data: session } = useSession();
  const userInitials =
    (session?.user?.name || session?.user?.email || "?")
      .split(/[\s.@]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("") || "?";

  // ----- State -----
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationId, setConversationId] = useState<string>("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ----- Conversations CRUD -----
  const refreshConversations = useCallback(async () => {
    try {
      const r = await fetch("/api/conversations?limit=50", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setConversations(j.data || []);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  const loadConversation = useCallback(async (id: string) => {
    setConversationId(id);
    setError(null);
    setSuggested([]);
    try {
      const r = await fetch(
        `/api/conversations/${id}/messages?limit=50`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error("load failed");
      const j = await r.json();
      const msgs: Message[] = [];
      for (const m of j.data || []) {
        const t = (m.created_at || 0) * 1000;
        msgs.push({
          id: uid(),
          role: "user",
          content: m.query || "",
          createdAt: t,
        });
        msgs.push({
          id: uid(),
          role: "assistant",
          content: m.answer || "",
          difyMessageId: m.id,
          feedback: m.feedback?.rating || null,
          createdAt: t,
        });
      }
      setMessages(msgs);
      // Pre-fetch suggestions for the last assistant msg
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.difyMessageId) {
        fetchSuggested(last.difyMessageId);
      }
    } catch {
      setError("Impossible de charger la conversation");
    }
  }, []);

  function newConversation() {
    setConversationId("");
    setMessages([]);
    setSuggested([]);
    setError(null);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === conversationId) newConversation();
    refreshConversations();
  }

  async function renameConversation(id: string) {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_generate: true }),
    });
    refreshConversations();
  }

  async function fetchSuggested(messageId: string) {
    try {
      const r = await fetch(`/api/messages/${messageId}/suggested`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = await r.json();
      setSuggested(Array.isArray(j.data) ? j.data : []);
    } catch { /* noop */ }
  }

  // ----- Auto-scroll -----
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, suggested]);

  // ----- Auto-resize textarea -----
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // ----- Send a message -----
  async function send(query: string, replaceLastAssistant = false) {
    const q = query.trim();
    if (!q || streaming) return;

    setError(null);
    setSuggested([]);
    setInput("");

    const userMsg: Message = {
      id: uid(), role: "user", content: q, createdAt: Date.now(),
    };
    const asstMsg: Message = {
      id: uid(), role: "assistant", content: "", createdAt: Date.now(),
    };

    setMessages((m) => {
      // Régénération : remplace la dernière paire user+assistant si elle existe
      if (replaceLastAssistant && m.length >= 2) {
        const next = [...m];
        // Remove last assistant message; keep last user message; append new asst
        if (next[next.length - 1]?.role === "assistant") {
          next.pop();
        }
        return [...next, asstMsg];
      }
      return [...m, userMsg, asstMsg];
    });
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let collectedMessageId = "";
    let collectedConvId = conversationId;

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
        setMessages((m) => m.filter((x) => x.id !== asstMsg.id));
        return;
      }

      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const data = JSON.parse(payload);
              if (data.conversation_id && !collectedConvId) {
                collectedConvId = data.conversation_id;
                setConversationId(collectedConvId);
              }
              if (data.message_id && !collectedMessageId) {
                collectedMessageId = data.message_id;
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
            } catch { /* ignore non-JSON */ }
          }
        }
      }

      // Stamp message_id on the assistant bubble for feedback/suggestions
      if (collectedMessageId) {
        setMessages((m) =>
          m.map((x) =>
            x.id === asstMsg.id
              ? { ...x, difyMessageId: collectedMessageId }
              : x,
          ),
        );
        fetchSuggested(collectedMessageId);
      }

      // First message of a new conversation → refresh list to show it
      if (!conversationId && collectedConvId) {
        refreshConversations();
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

  function regenerate() {
    // Find last user message and resend (replacing last assistant)
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) send(lastUser.content, true);
  }

  // ----- Per-message actions -----
  async function copyMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch { /* noop */ }
  }

  async function setFeedback(msg: Message, rating: "like" | "dislike" | null) {
    if (!msg.difyMessageId) return;
    setMessages((m) =>
      m.map((x) => (x.id === msg.id ? { ...x, feedback: rating } : x)),
    );
    try {
      await fetch(`/api/messages/${msg.difyMessageId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
    } catch { /* noop */ }
  }

  // ----- Render -----
  const empty = messages.length === 0 && !streaming;

  return (
    <div className="flex h-full">
      <ConversationsList
        conversations={conversations}
        currentId={conversationId}
        loading={conversationsLoading}
        onSelect={loadConversation}
        onNew={newConversation}
        onDelete={deleteConversation}
        onRename={renameConversation}
      />

      <div className="flex-1 flex flex-col h-full min-w-0">
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
                  {SUGGESTIONS_INITIAL.map((s) => (
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
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((m, idx) => {
                const isLast = idx === messages.length - 1;
                return (
                  <div key={m.id} className="flex gap-3 group">
                    <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border border-border">
                      {m.role === "user" ? (
                        <span className="bg-primary/20 text-primary w-full h-full rounded-full flex items-center justify-center">
                          {userInitials}
                        </span>
                      ) : (
                        <span className="bg-accent/15 text-accent w-full h-full rounded-full flex items-center justify-center">
                          <Sparkles size={14} />
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-xs font-medium">
                          {m.role === "user"
                            ? session?.user?.name || "Vous"
                            : "Assistant"}
                        </span>
                        <span className="text-[10px] text-muted">
                          {timeShort(m.createdAt)}
                        </span>
                      </div>
                      <div className="text-sm leading-relaxed">
                        {m.role === "assistant" ? (
                          m.content ? (
                            <MessageMarkdown content={m.content} />
                          ) : (
                            <span className="text-muted italic">
                              <span className="inline-flex gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
                                <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:120ms]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:240ms]" />
                              </span>
                            </span>
                          )
                        ) : (
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        )}
                      </div>

                      {/* Per-message actions (assistant, after stream) */}
                      {m.role === "assistant" && m.content && !(streaming && isLast) && (
                        <div className="mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-default">
                          <CopyButton content={m.content} />
                          {isLast && (
                            <button
                              onClick={regenerate}
                              className="p-1.5 rounded hover:bg-muted/30 transition-default text-muted hover:text-foreground"
                              title="Régénérer"
                            >
                              <RotateCcw size={14} />
                            </button>
                          )}
                          <button
                            onClick={() => setFeedback(m, m.feedback === "like" ? null : "like")}
                            className={
                              "p-1.5 rounded hover:bg-muted/30 transition-default " +
                              (m.feedback === "like"
                                ? "text-accent"
                                : "text-muted hover:text-foreground")
                            }
                            title="J'aime"
                          >
                            <ThumbsUp size={14} />
                          </button>
                          <button
                            onClick={() => setFeedback(m, m.feedback === "dislike" ? null : "dislike")}
                            className={
                              "p-1.5 rounded hover:bg-muted/30 transition-default " +
                              (m.feedback === "dislike"
                                ? "text-red-400"
                                : "text-muted hover:text-foreground")
                            }
                            title="Je n'aime pas"
                          >
                            <ThumbsDown size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Suggested questions after last assistant reply */}
              {!streaming && suggested.length > 0 && (
                <div className="ml-11 flex flex-wrap gap-2 pt-2">
                  {suggested.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-xs px-3 py-1.5 rounded-full border border-border bg-card hover:border-primary hover:bg-primary/5 transition-default"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
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
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Écrivez votre message…"
                rows={1}
                disabled={streaming}
                className="w-full resize-none bg-background border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-default disabled:opacity-60 max-h-[200px]"
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
                title="Envoyer (Entrée)"
              >
                <Send size={18} />
              </button>
            )}
          </div>
          <p className="text-xs text-muted text-center mt-2">
            <kbd className="px-1 rounded bg-muted/30 text-[10px]">Entrée</kbd>{" "}
            pour envoyer ·{" "}
            <kbd className="px-1 rounded bg-muted/30 text-[10px]">Shift+Entrée</kbd>{" "}
            pour saut de ligne · Toutes les conversations restent sur ce serveur.
          </p>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* noop */ }
      }}
      className="p-1.5 rounded hover:bg-muted/30 transition-default text-muted hover:text-foreground"
      title="Copier"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

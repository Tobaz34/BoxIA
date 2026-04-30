"use client";

/**
 * Chat principal — Phase A + Phase B.
 *
 * Phase B :
 *   - Sélecteur d'agent (AgentPicker) au-dessus de la liste de conversations
 *   - Conversations + messages scopés par agent (chaque agent a son propre
 *     historique côté Dify)
 *   - Custom Instructions (localStorage) injectées au 1er message d'une
 *     nouvelle conversation
 *
 * Le slug d'agent courant est mémorisé dans localStorage pour persister
 * entre les visites.
 */

import {
  Send, Square, Sparkles, RotateCcw, Copy, Check,
  ThumbsUp, ThumbsDown, MessageSquare, X, Download,
  Image as ImageIcon, Paperclip,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ConversationsList, type Conversation } from "./ConversationsList";
import { AgentPicker, type AgentMeta } from "./AgentPicker";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageSources, type RetrieverResource } from "./MessageSources";
import { useUI, setUI } from "@/lib/ui-store";

type Role = "user" | "assistant";

interface AttachedImage {
  upload_file_id: string;
  name: string;
  data_url: string;        // data: URL pour preview locale uniquement
  size: number;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  difyMessageId?: string;
  feedback?: "like" | "dislike" | null;
  sources?: RetrieverResource[];
  createdAt: number;
  /** Images attachées au moment de l'envoi (user msg). */
  images?: { url: string; name: string }[];
}

const SUGGESTIONS_INITIAL = [
  "Résume mes emails non lus",
  "Génère un devis pour Acme SARL",
  "Quelle est la procédure de demande de congés ?",
  "Combien de tickets ouverts cette semaine ?",
];

const LS_AGENT_KEY = "aibox.currentAgent";
const LS_CUSTOM_INSTRUCTIONS = "aibox.customInstructions";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function timeShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function readCustomInstructions(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(LS_CUSTOM_INSTRUCTIONS) || "";
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

  // ----- Agents -----
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [currentAgent, setCurrentAgent] = useState<string>("");

  // ----- Conversations / messages -----
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Images en cours d'attachement (avant envoi)
  const [attached, setAttached] = useState<AttachedImage[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);

  // ----- Charger la liste d'agents -----
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/agents", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const list: AgentMeta[] = j.agents || [];
        setAgents(list);
        // Restaure l'agent stocké, sinon le default
        const stored =
          (typeof window !== "undefined" && localStorage.getItem(LS_AGENT_KEY)) || "";
        const valid = list.find((a) => a.slug === stored);
        const initial =
          valid?.slug || list.find((a) => a.isDefault)?.slug || list[0]?.slug || "";
        setCurrentAgent(initial);
      } catch { /* noop */ }
    })();
  }, []);

  // ----- Conversations CRUD (scopées par agent) -----
  const refreshConversations = useCallback(async () => {
    if (!currentAgent) return;
    try {
      const r = await fetch(
        `/api/conversations?agent=${encodeURIComponent(currentAgent)}&limit=50`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        setConversations([]);
        return;
      }
      const j = await r.json();
      setConversations(j.data || []);
    } finally {
      setConversationsLoading(false);
    }
  }, [currentAgent]);

  useEffect(() => {
    if (!currentAgent) return;
    setConversationsLoading(true);
    setConversationId("");
    setMessages([]);
    setSuggested([]);
    setError(null);
    // Purge les images en attente — un agent non-vision ne saura pas les lire
    // (Dify remplacerait par [img-0] silencieusement → UX cassée).
    setAttached([]);
    refreshConversations();
  }, [currentAgent, refreshConversations]);

  function switchAgent(slug: string) {
    if (slug === currentAgent) return;
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_AGENT_KEY, slug);
    }
    setCurrentAgent(slug);
  }

  const loadConversation = useCallback(async (id: string) => {
    setConversationId(id);
    setError(null);
    setSuggested([]);
    try {
      const r = await fetch(
        `/api/conversations/${id}/messages?agent=${encodeURIComponent(currentAgent)}&limit=50`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error("load failed");
      const j = await r.json();
      const msgs: Message[] = [];
      for (const m of j.data || []) {
        const t = (m.created_at || 0) * 1000;
        msgs.push({ id: uid(), role: "user", content: m.query || "", createdAt: t });
        msgs.push({
          id: uid(),
          role: "assistant",
          content: m.answer || "",
          difyMessageId: m.id,
          feedback: m.feedback?.rating || null,
          sources: Array.isArray(m.retriever_resources)
            ? (m.retriever_resources as RetrieverResource[])
            : undefined,
          createdAt: t,
        });
      }
      setMessages(msgs);
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.difyMessageId) {
        fetchSuggested(last.difyMessageId);
      }
    } catch {
      setError("Impossible de charger la conversation");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAgent]);

  function newConversation() {
    setConversationId("");
    setMessages([]);
    setSuggested([]);
    setError(null);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function deleteConversation(id: string) {
    await fetch(
      `/api/conversations/${id}?agent=${encodeURIComponent(currentAgent)}`,
      { method: "DELETE" },
    );
    if (id === conversationId) newConversation();
    refreshConversations();
  }

  async function renameConversation(id: string) {
    await fetch(
      `/api/conversations/${id}?agent=${encodeURIComponent(currentAgent)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_generate: true }),
      },
    );
    refreshConversations();
  }

  async function fetchSuggested(messageId: string) {
    try {
      const r = await fetch(
        `/api/messages/${messageId}/suggested?agent=${encodeURIComponent(currentAgent)}`,
        { cache: "no-store" },
      );
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

  // ----- Raccourcis clavier globaux : Cmd/Ctrl+K nouvelle conv, Esc fermer drawers -----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ne pas intercepter si l'utilisateur est en train de taper dans
      // un input/textarea/select
      const target = e.target as HTMLElement;
      const inField = target?.tagName?.match(/^(INPUT|TEXTAREA|SELECT)$/);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newConversation();
      } else if (e.key === "Escape" && !inField) {
        // Esc ferme les drawers mobile (gérés par le store global)
        setUI({ mobileMenuOpen: false, convDrawerOpen: false });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----- Auto-resize textarea -----
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // ----- Upload d'image (paperclip) -----
  async function pickImage() {
    fileInputRef.current?.click();
  }
  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("Format non supporté (image uniquement).");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setError("Image trop grande (max 8 Mo).");
      return;
    }
    setUploadingImage(true);
    setError(null);
    try {
      // 1. Lit en data URL pour preview locale
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      // 2. Upload vers Dify
      const fd = new FormData();
      fd.append("file", f);
      if (currentAgent) fd.append("agent", currentAgent);
      const r = await fetch("/api/files/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.message || j.error || `Upload échoué (${r.status})`);
        return;
      }
      const j = await r.json();
      setAttached((cur) => [...cur, {
        upload_file_id: j.id,
        name: j.name || f.name,
        size: j.size || f.size,
        data_url: dataUrl,
      }]);
    } finally {
      setUploadingImage(false);
    }
  }
  function removeAttached(id: string) {
    setAttached((cur) => cur.filter((a) => a.upload_file_id !== id));
  }

  // ----- Send a message -----
  async function send(query: string, replaceLastAssistant = false) {
    const q = query.trim();
    if (!q || streaming || !currentAgent) return;

    setError(null);
    setSuggested([]);
    setInput("");

    // Custom Instructions : injectées uniquement au 1er message d'une
    // nouvelle conversation (Dify garde le contexte ensuite).
    const ci = readCustomInstructions().trim();
    const isNewConversation = !conversationId;
    const queryForDify =
      ci && isNewConversation
        ? `[Contexte utilisateur, à garder en tête pour toutes les réponses :\n${ci}]\n\n${q}`
        : q;

    // Capture les images attachées pour ce message
    const imagesAtSend = attached.slice();

    const userMsg: Message = {
      id: uid(), role: "user", content: q, createdAt: Date.now(),
      images: imagesAtSend.length > 0
        ? imagesAtSend.map((a) => ({ url: a.data_url, name: a.name }))
        : undefined,
    };
    const asstMsg: Message = {
      id: uid(), role: "assistant", content: "", createdAt: Date.now(),
    };

    setMessages((m) => {
      if (replaceLastAssistant && m.length >= 2) {
        const next = [...m];
        if (next[next.length - 1]?.role === "assistant") next.pop();
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
        body: JSON.stringify({
          agent: currentAgent,
          query: queryForDify,
          conversation_id: conversationId,
          files: imagesAtSend.map((a) => ({
            type: "image" as const,
            transfer_method: "local_file" as const,
            upload_file_id: a.upload_file_id,
          })),
        }),
        signal: ctrl.signal,
      });
      // Reset les attachements après envoi (succès ou erreur)
      setAttached([]);

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
              } else if (data.event === "message_end") {
                // Sources RAG (retriever_resources)
                const rr = data?.metadata?.retriever_resources;
                if (Array.isArray(rr) && rr.length > 0) {
                  setMessages((m) =>
                    m.map((x) =>
                      x.id === asstMsg.id
                        ? { ...x, sources: rr as RetrieverResource[] }
                        : x,
                    ),
                  );
                }
              } else if (data.event === "error") {
                setError(data.message || "Erreur Dify");
              }
            } catch { /* ignore */ }
          }
        }
      }

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

      if (!conversationId && collectedConvId) {
        refreshConversations();
      }
    } catch (e: unknown) {
      const err = e as { name?: string };
      if (err?.name !== "AbortError") setError("Connexion interrompue");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() { abortRef.current?.abort(); }

  function regenerate() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) send(lastUser.content, true);
  }

  /** Export de la conversation courante en Markdown (téléchargement
   *  immédiat). Indépendant du serveur — utilise le state local. */
  function exportAsMarkdown() {
    if (messages.length === 0) return;
    const agentName = currentAgentMeta?.name || "Assistant";
    const date = new Date().toLocaleDateString("fr-FR");
    const userName = session?.user?.name || session?.user?.email || "Vous";
    const conv = conversations.find((c) => c.id === conversationId);
    const title = conv?.name && conv.name !== "New conversation"
      ? conv.name : "Conversation";

    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`> ${agentName} · ${date}`);
    lines.push("");
    for (const m of messages) {
      const time = new Date(m.createdAt).toLocaleTimeString("fr-FR", {
        hour: "2-digit", minute: "2-digit",
      });
      const author = m.role === "user" ? userName : agentName;
      lines.push(`### ${author} — ${time}`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
    lines.push("");
    lines.push(`---`);
    lines.push(`Exporté depuis AI Box le ${new Date().toLocaleString("fr-FR")}`);

    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${
      new Date().toISOString().slice(0, 10)
    }.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function setFeedback(msg: Message, rating: "like" | "dislike" | null) {
    if (!msg.difyMessageId) return;
    setMessages((m) =>
      m.map((x) => (x.id === msg.id ? { ...x, feedback: rating } : x)),
    );
    try {
      await fetch(
        `/api/messages/${msg.difyMessageId}/feedback?agent=${encodeURIComponent(currentAgent)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating }),
        },
      );
    } catch { /* noop */ }
  }

  const empty = messages.length === 0 && !streaming;
  const currentAgentMeta = agents.find((a) => a.slug === currentAgent);

  // ----- No agents available -----
  if (agents.length === 0 && !conversationsLoading) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/30 text-muted mb-4">
            <Sparkles size={32} />
          </div>
          <h1 className="text-xl font-semibold mb-2">Aucun assistant configuré</h1>
          <p className="text-sm text-muted">
            La AI Box n'a pas encore d'assistant prêt. Demandez à
            l'administrateur de relancer le provisioning des agents.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ChatLayout
      panel={
        <>
          <div className="p-3 border-b border-border">
            <AgentPicker
              agents={agents}
              currentSlug={currentAgent}
              onChange={(s) => { switchAgent(s); setUI({ convDrawerOpen: false }); }}
            />
          </div>
          <ConversationsList
            conversations={conversations}
            currentId={conversationId}
            loading={conversationsLoading}
            onSelect={(id) => { loadConversation(id); setUI({ convDrawerOpen: false }); }}
            onNew={() => { newConversation(); setUI({ convDrawerOpen: false }); }}
            onDelete={deleteConversation}
            onRename={renameConversation}
          />
        </>
      }
    >
      <>
        {/* Top bar de la conversation (desktop) — visible si messages */}
        {!empty && (
          <div className="hidden lg:flex h-10 px-4 border-b border-border bg-card/40 items-center justify-between">
            <span className="text-xs text-muted truncate">
              {conversations.find((c) => c.id === conversationId)?.name ||
                "Nouvelle conversation"}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={exportAsMarkdown}
                title="Exporter en Markdown"
                className="p-1.5 rounded text-muted hover:text-foreground hover:bg-muted/30 transition-default"
              >
                <Download size={14} />
              </button>
            </div>
          </div>
        )}
        <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-6">
          {empty ? (
            <div className="h-full flex items-center justify-center">
              <div className="max-w-2xl w-full text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/15 text-primary mb-4 text-3xl">
                  {currentAgentMeta?.icon || "🤖"}
                </div>
                <h1 className="text-3xl font-semibold mb-2">
                  {currentAgentMeta?.name || "Assistant"}
                </h1>
                <p className="text-muted text-lg">
                  {currentAgentMeta?.description ||
                    "Posez-moi une question."}
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
                            : currentAgentMeta?.name || "Assistant"}
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
                          <div>
                            {m.images && m.images.length > 0 && (
                              <div className="flex flex-wrap gap-2 mb-2">
                                {m.images.map((img, i) => (
                                  <img
                                    key={i}
                                    src={img.url}
                                    alt={img.name}
                                    className="max-h-48 max-w-xs rounded-md border border-border object-contain"
                                  />
                                ))}
                              </div>
                            )}
                            {m.content && (
                              <div className="whitespace-pre-wrap">{m.content}</div>
                            )}
                          </div>
                        )}
                      </div>

                      {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                        <MessageSources sources={m.sources} />
                      )}

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
          {/* Preview des images attachées (avant envoi) */}
          {attached.length > 0 && (
            <div className="max-w-3xl mx-auto mb-2 flex flex-wrap gap-2">
              {attached.map((a) => (
                <div
                  key={a.upload_file_id}
                  className="relative group rounded-md border border-border overflow-hidden"
                >
                  <img
                    src={a.data_url}
                    alt={a.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    onClick={() => removeAttached(a.upload_file_id)}
                    className="absolute top-0.5 right-0.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-default"
                    title="Retirer"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFilePicked}
          />

          <div className="max-w-3xl mx-auto flex items-end gap-2">
            {/* Bouton Joindre image — uniquement si l'agent supporte la vision.
                Les agents text-only (qwen2.5:7b) feraient répondre au modèle
                « je ne vois pas l'image » : on cache simplement l'option. */}
            {currentAgentMeta?.vision && (
              <button
                onClick={pickImage}
                disabled={streaming || uploadingImage || !currentAgent}
                className="p-2.5 rounded-md text-muted hover:bg-muted/30 hover:text-foreground transition-default shrink-0 disabled:opacity-40"
                title="Joindre une image"
              >
                {uploadingImage ? (
                  <ImageIcon size={18} className="animate-pulse text-primary" />
                ) : (
                  <Paperclip size={18} />
                )}
              </button>
            )}
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  currentAgentMeta
                    ? `Message à ${currentAgentMeta.name}…`
                    : "Écrivez votre message…"
                }
                rows={1}
                disabled={streaming || !currentAgent}
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
                disabled={!input.trim() || !currentAgent}
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
      </>
    </ChatLayout>
  );
}

/** Layout responsive : desktop = panel statique à gauche, chat à droite.
 *  Mobile = panel en drawer (slide-out) qui couvre la chat.
 *  Le bouton "Conversations" en haut du chat ouvre le drawer mobile. */
function ChatLayout({
  panel, children,
}: {
  panel: React.ReactNode;
  children: React.ReactNode;
}) {
  const { state } = useUI();
  const open = state.convDrawerOpen;
  return (
    <div className="flex h-full relative">
      {/* Overlay mobile */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-30"
          onClick={() => setUI({ convDrawerOpen: false })}
        />
      )}

      {/* Panneau conversations + agent picker */}
      <div
        className={
          "shrink-0 border-r border-border bg-card flex flex-col h-full transition-transform " +
          "lg:relative lg:w-72 lg:translate-x-0 " +
          "fixed inset-y-0 left-0 w-80 z-40 " +
          (open ? "translate-x-0" : "-translate-x-full lg:translate-x-0")
        }
      >
        {/* Header drawer mobile */}
        <div className="lg:hidden flex items-center justify-between px-3 h-12 border-b border-border">
          <span className="text-sm font-medium">Conversations</span>
          <button
            onClick={() => setUI({ convDrawerOpen: false })}
            className="p-1.5 rounded hover:bg-muted/30"
          >
            <X size={14} />
          </button>
        </div>
        {panel}
      </div>

      {/* Bouton "Conversations" mobile uniquement (top-bar mince au-dessus du chat) */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        <div className="lg:hidden h-10 px-3 border-b border-border flex items-center bg-card">
          <button
            onClick={() => setUI({ convDrawerOpen: true })}
            className="text-xs inline-flex items-center gap-1.5 text-muted hover:text-foreground"
          >
            <MessageSquare size={14} /> Conversations
          </button>
        </div>
        {children}
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

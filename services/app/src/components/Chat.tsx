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
  Image as ImageIcon, Paperclip, FileText, Upload, Mic, MicOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ConversationsList, type Conversation } from "./ConversationsList";
import { AgentPicker, type AgentMeta } from "./AgentPicker";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageSources, type RetrieverResource } from "./MessageSources";
import { useUI, setUI } from "@/lib/ui-store";
import { useSpeech, useTTS } from "@/lib/use-speech";
import { smoothEmit } from "@/lib/smooth-stream";
import { SlashCommandMenu, type SlashCommand } from "./SlashCommandMenu";
import {
  Plus, RefreshCcw, FileDown, Bot as BotIcon,
  HelpCircle, Sparkles as SparkIcon, Volume2, VolumeX,
} from "lucide-react";

type Role = "user" | "assistant";
type AttachedKind = "image" | "document";

interface AttachedFile {
  upload_file_id: string;
  kind: AttachedKind;
  name: string;
  size: number;
  /** Pour les images, data: URL pour preview locale. Vide pour les
   *  documents (on affiche juste l'icône + le nom). */
  data_url?: string;
  /** Extension détectée (ex: "pdf", "docx") — utilisée pour afficher
   *  une étiquette explicite dans la preview. */
  extension?: string;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  difyMessageId?: string;
  feedback?: "like" | "dislike" | null;
  sources?: RetrieverResource[];
  createdAt: number;
  /** Pièces jointes au moment de l'envoi (user msg). */
  attachments?: { kind: AttachedKind; name: string; url?: string }[];
}

// Fallback si l'agent ne définit pas ses propres suggestions
const SUGGESTIONS_FALLBACK = [
  "Aide-moi à rédiger un email professionnel",
  "Quelle est la procédure de demande de congés ?",
  "Résume-moi les derniers documents ajoutés",
  "Explique-moi un concept en 5 points",
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

  // Fichiers en cours d'attachement (images + documents) avant envoi
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Voice input (Web Speech API, browser-side, FR par défaut)
  const speech = useSpeech();
  // Voice output (TTS) — lecture des réponses assistant
  const tts = useTTS();
  // Quand le transcript change pendant l'écoute, on remplace le contenu
  // du textarea (mode "remplace ce qu'on a dicté", pas append). Si l'user
  // veut combiner texte + voix, il dictera après avoir tapé.
  useEffect(() => {
    if (speech.listening && speech.transcript) {
      setInput(speech.transcript);
    }
  }, [speech.transcript, speech.listening]);
  // Surface l'erreur speech dans le bandeau d'erreur global du chat
  useEffect(() => {
    if (speech.error) setError(speech.error);
  }, [speech.error]);

  // ----- Pre-warm Ollama au mount du chat -----
  // Fire-and-forget : on déclenche le chargement des modèles en VRAM
  // dès que l'utilisateur ouvre la page, pour qu'ils soient prêts quand
  // il pose sa 1re question. Évite ~5-10s de cold-start.
  // Appelé une seule fois par session.
  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("aibox.warmup-done") === "1") return;
    fetch("/api/system/warmup", { method: "POST" })
      .then(() => {
        if (!cancelled) sessionStorage.setItem("aibox.warmup-done", "1");
      })
      .catch(() => { /* silencieux : c'est juste de la perf */ });
    return () => { cancelled = true; };
  }, []);

  // ----- Charger la liste d'agents -----
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/agents", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const list: AgentMeta[] = j.agents || [];
        setAgents(list);
        // Priorité de sélection :
        //   1. ?agent=<slug> dans l'URL (deep-link depuis /agents)
        //   2. localStorage (préférence user)
        //   3. agent default
        //   4. premier de la liste
        let initial = "";
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          const fromUrl = params.get("agent");
          if (fromUrl && list.find((a) => a.slug === fromUrl)) {
            initial = fromUrl;
            // Persiste pour que le refresh suivant garde la sélection
            localStorage.setItem(LS_AGENT_KEY, fromUrl);
          }
        }
        if (!initial) {
          const stored =
            (typeof window !== "undefined" && localStorage.getItem(LS_AGENT_KEY)) || "";
          const valid = list.find((a) => a.slug === stored);
          initial =
            valid?.slug || list.find((a) => a.isDefault)?.slug || list[0]?.slug || "";
        }
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

  // ----- Raccourcis clavier globaux ----------------------------------
  // Cmd/Ctrl+K  → nouvelle conversation
  // Esc         → arrête le streaming en cours (priorité haute)
  //                puis ferme les drawers mobile
  // Shift+/     → focus le textarea + insère "/" (ouvre le menu de commandes)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target?.tagName?.match(/^(INPUT|TEXTAREA|SELECT)$/);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newConversation();
      } else if (e.key === "Escape") {
        // 1. Si streaming en cours → arrête le streaming
        if (abortRef.current) {
          e.preventDefault();
          abortRef.current.abort();
          return;
        }
        // 2. Si TTS en cours → stop la lecture
        if (tts.speaking) {
          e.preventDefault();
          tts.stop();
          return;
        }
        // 3. Sinon → ferme les drawers (uniquement hors champ pour ne
        //    pas casser l'Esc=clear-input des inputs)
        if (!inField) {
          setUI({ mobileMenuOpen: false, convDrawerOpen: false });
        }
      } else if (e.key === "/" && !inField && !e.ctrlKey && !e.metaKey) {
        // Hors champ : '/' focus le textarea et y insère '/' pour ouvrir
        // direct le menu commandes
        e.preventDefault();
        textareaRef.current?.focus();
        setInput("/");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tts.speaking]);

  // ----- Auto-resize textarea -----
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // ----- Upload de fichier (paperclip ou drag-drop) -----
  async function pickFile() {
    fileInputRef.current?.click();
  }

  /** Upload une liste de fichiers (séquentiel pour préserver l'ordre).
   *  Utilisé par le file input ET par le drop zone. */
  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploadingFile(true);
    setError(null);
    try {
      for (const f of list) {
        // 1. Pour les images, on lit en data URL pour preview locale.
        //    Pour les documents, on n'a pas besoin de data URL (juste un
        //    icône + nom dans la preview).
        let dataUrl: string | undefined;
        if (f.type.startsWith("image/")) {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = reject;
            r.readAsDataURL(f);
          });
        }
        // 2. Upload vers Dify (via notre proxy)
        const fd = new FormData();
        fd.append("file", f);
        if (currentAgent) fd.append("agent", currentAgent);
        const r = await fetch("/api/files/upload", { method: "POST", body: fd });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.message || j.error || `Upload échoué (${r.status})`);
          return;  // stop on first error pour ne pas spammer
        }
        const j = await r.json();
        setAttached((cur) => [...cur, {
          upload_file_id: j.id,
          kind: (j.kind as AttachedKind) || "document",
          name: j.name || f.name,
          size: j.size || f.size,
          extension: j.extension,
          data_url: dataUrl,
        }]);
      }
    } finally {
      setUploadingFile(false);
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (e.target) e.target.value = "";
    if (files && files.length) await uploadFiles(files);
  }

  /** Handler `paste` sur le textarea : extrait les images du clipboard et
   *  les uploade comme attachements. Fonctionne avec Ctrl+V (Cmd+V) après
   *  une capture d'écran ou un copy d'image dans une autre app. Le texte
   *  collé reste injecté normalement dans le textarea (default behavior). */
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!currentAgent) return;
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((it) => it.kind === "file");
    if (fileItems.length === 0) return; // pas de fichier → laisse le paste texte se faire
    e.preventDefault();
    const files: File[] = [];
    for (const it of fileItems) {
      const f = it.getAsFile();
      if (f) {
        // Si pas de nom (cas screenshot Windows = "image.png"), génère un
        // nom user-friendly avec timestamp pour le distinguer dans la
        // preview et dans Dify.
        if (!f.name || f.name === "image.png" || f.name.startsWith("Capture")) {
          const ext = f.type.split("/")[1] || "png";
          const stamped = new File([f], `capture-${Date.now()}.${ext}`, { type: f.type });
          files.push(stamped);
        } else {
          files.push(f);
        }
      }
    }
    if (files.length > 0) {
      await uploadFiles(files);
    }
  }

  function removeAttached(id: string) {
    setAttached((cur) => cur.filter((a) => a.upload_file_id !== id));
  }

  // ----- Drag-and-drop sur l'aire de chat -----
  // Compteur global pour gérer les events nested (dragenter sur enfant ne
  // doit pas re-déclencher si on est déjà en drag, et un dragleave sur un
  // enfant ne doit pas masquer l'overlay).
  const dragCounter = useRef(0);
  function onDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }
  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    if (!currentAgent) {
      setError("Sélectionnez un agent avant de déposer des fichiers.");
      return;
    }
    const files = e.dataTransfer.files;
    if (files && files.length) await uploadFiles(files);
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

    // Capture les pièces jointes (images + documents) pour ce message
    const filesAtSend = attached.slice();

    const userMsg: Message = {
      id: uid(), role: "user", content: q, createdAt: Date.now(),
      attachments: filesAtSend.length > 0
        ? filesAtSend.map((a) => ({
            kind: a.kind,
            name: a.name,
            url: a.data_url,  // undefined pour les documents → on rend l'icône
          }))
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
          files: filesAtSend.map((a) => ({
            type: a.kind,           // "image" ou "document"
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
              // Les agents en mode `agent-chat` (Concierge avec tools)
              // émettent `agent_message` au lieu de `message`. Sans ce
              // doublon, m.content reste vide → ThinkingIndicator coincé
              // sur "Je structure la réponse…" (BUG-018).
              if (
                (data.event === "message" || data.event === "agent_message") &&
                typeof data.answer === "string"
              ) {
                // Streaming fluide : on chunk les gros deltas Dify en
                // 1-3 chars avec 5ms de pause → effet « tape comme un
                // humain » (cf lib/smooth-stream.ts, pattern Open-WebUI).
                // Skip si onglet caché pour ne pas burn CPU.
                await smoothEmit(data.answer, (chunk) => {
                  setMessages((m) =>
                    m.map((x) =>
                      x.id === asstMsg.id
                        ? { ...x, content: x.content + chunk }
                        : x,
                    ),
                  );
                });
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

  // ---------------------------------------------------------------------
  // Slash commands : `/<cmd>` au début de l'input → menu autocomplete + run
  // ---------------------------------------------------------------------
  const slashCommands: SlashCommand[] = [
    {
      name: "help",
      description: "Affiche la liste des commandes",
      icon: <HelpCircle size={14} />,
      run: () => {
        setMessages((m) => [...m, {
          id: uid(), role: "assistant", createdAt: Date.now(),
          content:
            "**Commandes disponibles :**\n\n" +
            "- `/new` — Nouvelle conversation\n" +
            "- `/regen` — Régénérer la dernière réponse\n" +
            "- `/agent <slug>` — Changer d'agent (ex: `/agent hr`)\n" +
            "- `/export` — Exporter la conversation en Markdown\n" +
            "- `/summarize` — Demande un résumé en 5 points\n" +
            "- `/help` — Afficher cette aide\n\n" +
            "_Tape `/` pour ouvrir le menu autocomplete._",
        }]);
      },
    },
    {
      name: "new",
      aliases: ["clear"],
      description: "Démarre une nouvelle conversation",
      icon: <Plus size={14} />,
      run: () => newConversation(),
    },
    {
      name: "regen",
      aliases: ["regenerate", "retry"],
      description: "Régénère la dernière réponse de l'assistant",
      icon: <RefreshCcw size={14} />,
      run: () => regenerate(),
    },
    {
      name: "export",
      description: "Exporte la conversation en Markdown",
      icon: <FileDown size={14} />,
      run: () => exportAsMarkdown(),
    },
    {
      name: "agent",
      argumentHint: "<slug>",
      description: "Change d'agent (general, accountant, hr, support)",
      icon: <BotIcon size={14} />,
      run: (arg) => {
        const slug = arg.trim().toLowerCase();
        const target = agents.find((a) =>
          a.slug.toLowerCase() === slug ||
          a.name.toLowerCase().startsWith(slug)
        );
        if (target) switchAgent(target.slug);
        else setError(`Agent introuvable : "${slug}". Disponibles : ${agents.map((a) => a.slug).join(", ")}`);
      },
    },
    {
      name: "summarize",
      aliases: ["resume"],
      description: "Demande un résumé en 5 points de la conversation",
      icon: <SparkIcon size={14} />,
      run: () => {
        send("Fais-moi un résumé en 5 points de ce dont nous avons parlé jusqu'ici, en commençant par le plus important.");
      },
    },
  ];

  // Auto-complete sur Tab : le menu envoie un CustomEvent qu'on écoute ici.
  useEffect(() => {
    function handler(e: Event) {
      const value = (e as CustomEvent<string>).detail;
      if (typeof value === "string") setInput(value);
    }
    window.addEventListener("aibox-slash-complete", handler as EventListener);
    return () => window.removeEventListener("aibox-slash-complete", handler as EventListener);
  }, []);

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
      <div
        className="flex flex-col h-full relative"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {/* Drop overlay — apparaît quand l'utilisateur glisse un fichier
            depuis l'extérieur de la fenêtre. Couvre toute la zone de chat,
            cliquable transparent (l'event drop est géré par le wrapper). */}
        {dragOver && (
          <div
            className="absolute inset-0 z-30 bg-primary/15 backdrop-blur-sm border-4 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none"
          >
            <div className="text-center">
              <Upload size={48} className="mx-auto text-primary mb-3" />
              <div className="text-lg font-semibold text-primary">
                Déposez vos fichiers ici
              </div>
              <div className="text-xs text-muted mt-1">
                Images, PDF, DOCX, TXT, MD, CSV, XLSX… (8 Mo image, 20 Mo doc)
              </div>
            </div>
          </div>
        )}

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
                  {(() => {
                    // Salutation personnalisée avec le prénom du user.
                    // On extrait le 1er mot du `name` Authentik (ex: "Admin
                    // Test" → "Admin", "Jean Dupont" → "Jean") et on l'ajoute
                    // au nom de l'agent. Si pas de name, on tombe sur l'email
                    // (avant le @) ou « Bonjour ».
                    const fullName = session?.user?.name || "";
                    const firstName = fullName.split(/\s+/)[0]
                      || (session?.user?.email || "").split("@")[0]
                      || "";
                    const agentName = currentAgentMeta?.name || "Assistant";
                    return firstName
                      ? `Bonjour ${firstName}, je suis ${agentName}`
                      : agentName;
                  })()}
                </h1>
                <p className="text-muted text-lg">
                  {currentAgentMeta?.openingStatement ||
                    currentAgentMeta?.description ||
                    "Posez-moi une question."}
                </p>
                <div className="grid sm:grid-cols-2 gap-2 mt-8">
                  {(currentAgentMeta?.suggestedQuestions?.length
                    ? currentAgentMeta.suggestedQuestions
                    : SUGGESTIONS_FALLBACK
                  ).map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left px-4 py-3 rounded-lg border border-border bg-card hover:border-primary hover:bg-primary/5 transition-default text-sm"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {/* Hints pour les nouvelles features */}
                <div className="mt-6 text-xs text-muted space-y-1">
                  <div>💡 Glissez un PDF ou DOCX ici pour me l'analyser</div>
                  {speech.supported && (
                    <div>🎤 Cliquez sur le micro pour me dicter votre question</div>
                  )}
                  <div>⚡ Tapez <code className="text-foreground">/</code> pour les commandes (regen, export, summarize…)</div>
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
                            <ThinkingIndicator
                              hasAttachments={
                                messages[idx - 1]?.attachments
                                  ? messages[idx - 1].attachments!.length > 0
                                  : false
                              }
                            />
                          )
                        ) : (
                          <div>
                            {m.attachments && m.attachments.length > 0 && (
                              <div className="flex flex-wrap gap-2 mb-2">
                                {m.attachments.map((a, i) =>
                                  a.kind === "image" && a.url ? (
                                    <img
                                      key={i}
                                      src={a.url}
                                      alt={a.name}
                                      className="max-h-48 max-w-xs rounded-md border border-border object-contain"
                                    />
                                  ) : (
                                    <div
                                      key={i}
                                      className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs"
                                    >
                                      <FileText size={14} className="text-primary shrink-0" />
                                      <span className="truncate max-w-[200px]">{a.name}</span>
                                    </div>
                                  ),
                                )}
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
                          {/* Lecture vocale (TTS) — Web Speech API natif */}
                          {tts.supported && (
                            <button
                              onClick={() =>
                                tts.speakingMessageId === m.id
                                  ? tts.stop()
                                  : tts.speak(m.content, m.id, "fr-FR")
                              }
                              className={
                                "p-1.5 rounded hover:bg-muted/30 transition-default " +
                                (tts.speakingMessageId === m.id
                                  ? "text-primary"
                                  : "text-muted hover:text-foreground")
                              }
                              title={
                                tts.speakingMessageId === m.id
                                  ? "Arrêter la lecture"
                                  : "Lire la réponse à haute voix"
                              }
                            >
                              {tts.speakingMessageId === m.id ? (
                                <VolumeX size={14} />
                              ) : (
                                <Volume2 size={14} />
                              )}
                            </button>
                          )}
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
          {/* Preview des pièces jointes (images + documents) avant envoi */}
          {attached.length > 0 && (
            <div className="max-w-3xl mx-auto mb-2 flex flex-wrap gap-2">
              {attached.map((a) => (
                <div
                  key={a.upload_file_id}
                  className="relative group rounded-md border border-border overflow-hidden bg-card"
                >
                  {a.kind === "image" && a.data_url ? (
                    <img
                      src={a.data_url}
                      alt={a.name}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    <div className="h-16 px-3 flex items-center gap-2 text-xs">
                      <FileText size={20} className="text-primary shrink-0" />
                      <div className="min-w-0 max-w-[180px]">
                        <div className="truncate font-medium">{a.name}</div>
                        <div className="text-[10px] text-muted">
                          {(a.size / 1024).toFixed(0)} Ko
                          {a.extension && ` · .${a.extension}`}
                        </div>
                      </div>
                    </div>
                  )}
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

          {/* Le bouton paperclip accepte maintenant images ET documents.
              Pour les agents non-vision, on n'autorise que les documents
              (les images seraient ignorées par le modèle). */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={
              currentAgentMeta?.vision
                ? "image/*,.pdf,.txt,.md,.csv,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                : ".pdf,.txt,.md,.csv,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            }
            className="hidden"
            onChange={onFilePicked}
          />

          <div className="max-w-3xl mx-auto flex items-end gap-2">
            {/* Bouton Joindre fichier — toujours visible (même pour les
                agents non-vision, qui peuvent traiter des documents). */}
            <button
              onClick={pickFile}
              disabled={streaming || uploadingFile || !currentAgent}
              className="p-2.5 rounded-md text-muted hover:bg-muted/30 hover:text-foreground transition-default shrink-0 disabled:opacity-40"
              title={
                currentAgentMeta?.vision
                  ? "Joindre une image ou un document (drag-drop accepté)"
                  : "Joindre un document (PDF, DOCX, TXT, MD…)"
              }
            >
              {uploadingFile ? (
                <ImageIcon size={18} className="animate-pulse text-primary" />
              ) : (
                <Paperclip size={18} />
              )}
            </button>
            {/* Bouton Dictée vocale — Web Speech API, FR par défaut.
                Caché si le navigateur ne supporte pas (Firefox actuel). */}
            {speech.supported && (
              <button
                onClick={() => speech.listening ? speech.stop() : speech.start("fr-FR")}
                disabled={streaming || !currentAgent}
                className={
                  "p-2.5 rounded-md transition-default shrink-0 disabled:opacity-40 " +
                  (speech.listening
                    ? "bg-red-500/15 text-red-400 ring-2 ring-red-500/40"
                    : "text-muted hover:bg-muted/30 hover:text-foreground")
                }
                title={speech.listening ? "Arrêter la dictée" : "Dicter un message (FR)"}
              >
                {speech.listening ? (
                  <MicOff size={18} className="animate-pulse" />
                ) : (
                  <Mic size={18} />
                )}
              </button>
            )}
            <div className="flex-1 relative">
              {/* Menu commandes slash — apparaît au-dessus si input commence par "/" */}
              <SlashCommandMenu
                input={input}
                commands={slashCommands}
                onCommandRun={() => setInput("")}
              />
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onPaste}
                placeholder={
                  currentAgentMeta
                    ? `Message à ${currentAgentMeta.name}… (tape / pour les commandes, Ctrl+V pour coller une capture)`
                    : "Écrivez votre message…"
                }
                rows={1}
                disabled={streaming || !currentAgent}
                className="w-full resize-none bg-background border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-default disabled:opacity-60 max-h-[200px]"
                onKeyDown={(e) => {
                  // Si menu slash ouvert, le menu gère ↑↓⏎⎋⇥ → on laisse passer.
                  // (le menu utilise capture=true sur le doc, et stopPropagation
                  //  sur Enter pour empêcher le send.)
                  const slashOpen = input.startsWith("/");
                  if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
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
      </div>
    </ChatLayout>
  );
}

/** Layout responsive : desktop = panel statique à gauche, chat à droite.
 *  Mobile = panel en drawer (slide-out) qui couvre la chat.
 *  Le bouton "Conversations" en haut du chat ouvre le drawer mobile. */
/** Indicateur visuel pendant que l'assistant réfléchit. Phrases qui
 *  tournent toutes les 1.5s pour donner une sensation de progression
 *  (« je lis le doc » → « je consulte la KB » → « je rédige »). */
function ThinkingIndicator({ hasAttachments }: { hasAttachments: boolean }) {
  const messagesText = hasAttachments
    ? [
        "Lecture du document…",
        "Extraction des points clés…",
        "Recoupement avec mes connaissances…",
        "Rédaction de la réponse…",
      ]
    : [
        "Je réfléchis…",
        "Je consulte la base de connaissances…",
        "Je structure la réponse…",
      ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(
      () => setIdx((i) => Math.min(i + 1, messagesText.length - 1)),
      1800,
    );
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span className="text-muted italic inline-flex items-center gap-2">
      <span className="inline-flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:120ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:240ms]" />
      </span>
      <span className="text-xs">{messagesText[idx]}</span>
    </span>
  );
}

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

"use client";

/**
 * Hook React pour l'input vocal via Web Speech API (browser-native).
 *
 * Avantages vs serveur :
 *   - Aucune dépendance backend (Whisper / cloud STT)
 *   - Privacy : la voix ne quitte JAMAIS le navigateur de l'utilisateur
 *   - Latence quasi nulle (transcription en temps réel)
 *
 * Limites :
 *   - Chrome / Edge (Webkit + Chromium) : marche
 *   - Firefox : non supporté nativement (devrait être ajouté en 2026)
 *   - Safari : marche sur macOS et iOS récents
 *
 * Mode interim=true : le texte est mis à jour en streaming pendant que
 * l'utilisateur parle (idéal UX). On finalise à la fin du recognition.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// Types Web Speech (pas dans les @types du repo)
type SpeechRecognitionType = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
};
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}
interface SpeechRecognitionErrorLike {
  error: string;
  message?: string;
}

interface UseSpeechResult {
  /** True si le navigateur supporte l'API Web Speech. */
  supported: boolean;
  /** True quand le micro écoute. */
  listening: boolean;
  /** Texte transcrit en cours (interim + final). Reset au start(). */
  transcript: string;
  /** Erreur éventuelle (denied, no-speech, network…). */
  error: string | null;
  /** Démarre l'écoute. lang="fr-FR" par défaut. */
  start: (lang?: string) => void;
  /** Stoppe l'écoute proprement (le `onend` final fire encore). */
  stop: () => void;
}

export function useSpeech(): UseSpeechResult {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionType | null>(null);

  const supported =
    typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (("SpeechRecognition" in window) || ("webkitSpeechRecognition" in window));

  const start = useCallback((lang = "fr-FR") => {
    if (!supported) {
      setError("Le navigateur ne supporte pas la dictée vocale.");
      return;
    }
    setError(null);
    setTranscript("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ||
               // eslint-disable-next-line @typescript-eslint/no-explicit-any
               (window as any).webkitSpeechRecognition;
    const r: SpeechRecognitionType = new SR();
    r.continuous = false;        // s'arrête naturellement après une phrase
    r.interimResults = true;     // streaming
    r.lang = lang;

    let finalText = "";
    r.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      setTranscript(finalText + interim);
    };
    r.onerror = (e: SpeechRecognitionErrorLike) => {
      setError(humanizeSpeechError(e.error));
      setListening(false);
    };
    r.onend = () => {
      setListening(false);
    };
    recRef.current = r;
    try {
      r.start();
      setListening(true);
    } catch (e) {
      setError(String(e));
    }
  }, [supported]);

  const stop = useCallback(() => {
    if (recRef.current) {
      try { recRef.current.stop(); } catch { /* noop */ }
    }
  }, []);

  // Cleanup à l'unmount
  useEffect(() => {
    return () => {
      if (recRef.current) {
        try { recRef.current.abort(); } catch { /* noop */ }
      }
    };
  }, []);

  return { supported, listening, transcript, error, start, stop };
}

function humanizeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Permission micro refusée. Autorisez-le dans les paramètres du navigateur.";
    case "no-speech":
      return "Aucune voix détectée. Réessayez plus près du micro.";
    case "audio-capture":
      return "Pas de micro détecté.";
    case "network":
      return "Problème réseau pendant la dictée.";
    case "aborted":
      return "";  // utilisateur a arrêté volontairement → pas une erreur
    default:
      return `Erreur dictée: ${code}`;
  }
}


// =============================================================================
// Text-to-Speech (TTS) — lecture vocale des réponses assistant.
// Utilise speechSynthesis (browser natif, marche partout).
// =============================================================================

interface UseTTSResult {
  supported: boolean;
  speaking: boolean;
  /** ID du message actuellement lu (utile pour styler le bouton play). */
  speakingMessageId: string | null;
  speak: (text: string, messageId: string, lang?: string) => void;
  stop: () => void;
}

/** Nettoie le markdown pour la synthèse vocale (commun aux 2 backends). */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "(extrait de code)")     // fences
    .replace(/`([^`]+)`/g, "$1")                          // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1")                    // bold
    .replace(/\*([^*]+)\*/g, "$1")                        // italic
    .replace(/^#+\s+/gm, "")                              // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")              // links → keep text
    .replace(/\n{3,}/g, "\n\n");
}

export function useTTS(): UseTTSResult {
  const [speaking, setSpeaking] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Backend TTS résolu au mount via GET /api/tts. Si "piper", on utilise
  // l'audio serveur (qualité supérieure). Sinon Web Speech API natif
  // (fallback gracieux : si Piper down on bascule sur natif au runtime).
  const [backend, setBackend] = useState<"piper" | "web-speech">("web-speech");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts", { method: "GET", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.backend === "piper") setBackend("piper");
      })
      .catch(() => {/* fallback web-speech */});
    return () => { cancelled = true; };
  }, []);

  const supported =
    typeof window !== "undefined" &&
    ("speechSynthesis" in window || backend === "piper");

  const stopAll = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
  }, []);

  const speakWebNative = useCallback((clean: string, lang: string) => {
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = lang;
    u.rate = 1.05;
    u.pitch = 1;
    const voices = window.speechSynthesis.getVoices();
    const frVoice = voices.find((v) => v.lang.startsWith("fr"))
                 || voices.find((v) => v.lang.startsWith("fr-FR"));
    if (frVoice) u.voice = frVoice;
    u.onend = () => { setSpeaking(false); setSpeakingMessageId(null); };
    u.onerror = () => { setSpeaking(false); setSpeakingMessageId(null); };
    utteranceRef.current = u;
    window.speechSynthesis.speak(u);
  }, []);

  const speakPiper = useCallback(async (clean: string, lang: string) => {
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (!r.ok) {
        // Backend Piper down → fallback web-speech au runtime
        setBackend("web-speech");
        if ("speechSynthesis" in window) speakWebNative(clean, lang);
        else { setSpeaking(false); setSpeakingMessageId(null); }
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setSpeakingMessageId(null);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setSpeakingMessageId(null);
      };
      await audio.play();
    } catch {
      setSpeaking(false);
      setSpeakingMessageId(null);
    }
  }, [speakWebNative]);

  const speak = useCallback((text: string, messageId: string, lang = "fr-FR") => {
    if (!supported) return;
    stopAll();
    const clean = cleanForSpeech(text);
    setSpeaking(true);
    setSpeakingMessageId(messageId);
    if (backend === "piper") {
      void speakPiper(clean, lang);
    } else if ("speechSynthesis" in window) {
      speakWebNative(clean, lang);
    } else {
      setSpeaking(false);
      setSpeakingMessageId(null);
    }
  }, [supported, backend, speakPiper, speakWebNative, stopAll]);

  const stop = useCallback(() => {
    stopAll();
    setSpeaking(false);
    setSpeakingMessageId(null);
  }, [stopAll]);

  // Cleanup au unmount
  useEffect(() => {
    return () => stopAll();
  }, [stopAll]);

  return { supported, speaking, speakingMessageId, speak, stop };
}

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

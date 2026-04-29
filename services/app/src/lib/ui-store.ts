"use client";

/**
 * Mini store React (sans dépendance) pour quelques flags d'UI globaux :
 *   - mobileMenuOpen   : sidebar nav ouvert en overlay (mobile)
 *   - convDrawerOpen   : panneau conversations en overlay (mobile, dans /)
 *   - theme            : "dark" (default) | "light"
 *
 * Utilisé via `const ui = useUI()` dans un composant client.
 */
import { useEffect, useState } from "react";

export interface UIState {
  mobileMenuOpen: boolean;
  convDrawerOpen: boolean;
  theme: "dark" | "light";
}

const initialTheme = (): "dark" | "light" => {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("aibox.theme");
  return stored === "light" ? "light" : "dark";
};

let state: UIState = {
  mobileMenuOpen: false,
  convDrawerOpen: false,
  theme: "dark",
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setUI(patch: Partial<UIState>) {
  state = { ...state, ...patch };
  // Persist theme
  if (patch.theme && typeof window !== "undefined") {
    localStorage.setItem("aibox.theme", patch.theme);
    document.documentElement.dataset.theme = patch.theme;
  }
  emit();
}

export function useUI(): { state: UIState; setUI: typeof setUI } {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    // hydrate theme from localStorage on first mount
    if (state.theme !== initialTheme()) {
      state = { ...state, theme: initialTheme() };
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = state.theme;
      }
    }
    return () => { listeners.delete(fn); };
  }, []);
  return { state, setUI };
}

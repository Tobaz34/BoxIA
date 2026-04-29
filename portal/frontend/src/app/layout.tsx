import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Box — Portail",
  description: "Portail de provisioning AI Box pour TPE/PME",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="font-sans antialiased min-h-screen flex flex-col">
        <header className="border-b border-border px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 text-lg font-semibold">
            <span>⬡</span>
            <span>AI Box <span className="text-muted font-normal">— Portail admin</span></span>
          </a>
          <nav className="flex gap-6 text-sm text-muted">
            <a href="/fleet" className="hover:text-text">Parc</a>
            <a href="/clients" className="hover:text-text">Clients</a>
            <a href="/clients/new" className="hover:text-text">Nouveau déploiement</a>
            <a href="/about" className="hover:text-text">À propos</a>
          </nav>
        </header>
        <main className="flex-1 max-w-6xl mx-auto w-full p-6">{children}</main>
        <footer className="border-t border-border px-6 py-3 text-center text-xs text-muted">
          AI Box · Portail interne · v0.1
        </footer>
      </body>
    </html>
  );
}

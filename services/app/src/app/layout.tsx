import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { getBranding } from "@/lib/branding-server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Providers } from "./providers";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const b = getBranding();
  return {
    title: b.name,
    description: `${b.name} — IA souveraine`,
  };
}

// Convertit hex (#3b82f6) en HSL pour CSS variable Tailwind
function hexToHsl(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Lit le branding à CHAQUE requête → le changement via /settings est
  // visible immédiatement après refresh, sans rebuild ni restart.
  const branding = getBranding();
  const session = await getServerSession(authOptions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isAdmin = (session?.user as any)?.isAdmin || false;

  // Inject brand colors into root CSS variables
  const customStyles: Record<string, string> = {};
  try {
    customStyles["--primary"] = hexToHsl(branding.primaryColor);
    customStyles["--accent"] = hexToHsl(branding.accentColor);
  } catch {
    /* fall back to defaults */
  }

  return (
    <html lang="fr">
      <body className="h-screen overflow-hidden">
        <Providers session={session}>
          {!session ? (
            <main className="h-full flex items-center justify-center">{children}</main>
          ) : (
            <div
              className="flex h-full"
              style={customStyles as React.CSSProperties}
            >
              <Sidebar isAdmin={isAdmin} />
              <div className="flex flex-col flex-1 overflow-hidden">
                <Header brandName={branding.name} brandLogoUrl={branding.logoUrl || undefined} />
                <main className="flex-1 overflow-auto">{children}</main>
              </div>
            </div>
          )}
        </Providers>
      </body>
    </html>
  );
}

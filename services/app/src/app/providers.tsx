"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { I18nProvider } from "@/lib/i18n";

export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <I18nProvider>{children}</I18nProvider>
    </SessionProvider>
  );
}

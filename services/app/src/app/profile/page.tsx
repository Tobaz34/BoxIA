"use client";

/**
 * /profile — page profil de l'utilisateur courant.
 *
 * Affichage en lecture seule de ses informations + lien vers /me
 * (RGPD : export, suppression). La modification du nom/email est
 * réservée aux admins via /users.
 */
import {
  User, Mail, Shield, ShieldCheck, Briefcase, ExternalLink, Activity,
} from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

export default function ProfilePage() {
  const { data: session, status } = useSession();
  if (status === "loading") {
    return <div className="p-6 text-sm text-muted">Chargement…</div>;
  }
  if (!session?.user) {
    return null;
  }

  const groups = (session.user as { groups?: string[] }).groups || [];
  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin || false;
  const isManager = groups.includes("AI Box — Managers");

  const role = isAdmin ? "Administrateur" : isManager ? "Manager" : "Employé";
  const RoleIcon = isAdmin ? ShieldCheck : isManager ? Briefcase : User;
  const roleColor = isAdmin
    ? "text-primary bg-primary/15"
    : isManager
    ? "text-accent bg-accent/15"
    : "text-muted bg-muted/15";

  const initials = (session.user.name || session.user.email || "?")
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <header className="mb-6 flex items-center gap-3">
        <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
          <User size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Mon profil</h1>
          <p className="text-sm text-muted">
            Vos informations de compte AI Box.
          </p>
        </div>
      </header>

      {/* Carte profil */}
      <section className="bg-card border border-border rounded-lg p-5 mb-4">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-16 h-16 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xl font-semibold">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="text-lg font-semibold truncate">
              {session.user.name || session.user.email}
            </div>
            <div className="text-sm text-muted truncate">
              {session.user.email}
            </div>
            <div className="mt-1">
              <span className={"inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium " + roleColor}>
                <RoleIcon size={10} /> {role}
              </span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm border-t border-border pt-4">
          <dt className="flex items-center gap-2 text-muted">
            <Mail size={12} /> Email
          </dt>
          <dd>{session.user.email}</dd>
          <dt className="flex items-center gap-2 text-muted">
            <Shield size={12} /> Rôle
          </dt>
          <dd>{role}</dd>
          <dt className="flex items-center gap-2 text-muted">
            <User size={12} /> Groupes
          </dt>
          <dd className="flex flex-wrap gap-1">
            {groups.length === 0 ? (
              <span className="text-muted">—</span>
            ) : (
              groups.map((g) => (
                <span
                  key={g}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-muted/20 text-muted"
                >
                  {g}
                </span>
              ))
            )}
          </dd>
        </dl>
      </section>

      {/* Actions */}
      <section className="space-y-3">
        <Link
          href="/me"
          className="flex items-center justify-between p-4 rounded-lg border border-border bg-card hover:border-primary/50 transition-default"
        >
          <div className="flex items-center gap-3">
            <ShieldCheck size={18} className="text-primary" />
            <div>
              <div className="text-sm font-medium">Mes données (RGPD)</div>
              <div className="text-xs text-muted">
                Exporter mes conversations · supprimer mes données
              </div>
            </div>
          </div>
          <ExternalLink size={14} className="text-muted" />
        </Link>

        {isAdmin && (
          <Link
            href="/audit"
            className="flex items-center justify-between p-4 rounded-lg border border-border bg-card hover:border-primary/50 transition-default"
          >
            <div className="flex items-center gap-3">
              <Activity size={18} className="text-primary" />
              <div>
                <div className="text-sm font-medium">Journal d'audit</div>
                <div className="text-xs text-muted">
                  Consulter l'historique des actions admin et système
                </div>
              </div>
            </div>
            <ExternalLink size={14} className="text-muted" />
          </Link>
        )}
      </section>

      <div className="mt-8 text-xs text-muted text-center">
        Pour modifier votre nom ou votre adresse email, contactez votre
        administrateur.
      </div>
    </div>
  );
}

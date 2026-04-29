"use client";

/**
 * Page /users — liste + invite + edit + désactivation.
 * Réservée aux admins (le serveur 403 si non-admin).
 */
import {
  Users, UserPlus, Search, MoreHorizontal, Shield, ShieldCheck,
  Briefcase, User, Power, KeyRound, Check, Copy, X, AlertCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Role = "admin" | "manager" | "employee";
interface PublicUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  role: Role;
  last_login: string | null;
  date_joined: string | null;
}

const ROLE_LABEL: Record<Role, { label: string; icon: typeof Shield; cls: string }> = {
  admin:    { label: "Admin",     icon: ShieldCheck, cls: "text-primary bg-primary/15" },
  manager:  { label: "Manager",   icon: Briefcase,   cls: "text-accent bg-accent/15" },
  employee: { label: "Employé",   icon: User,        cls: "text-muted bg-muted/15" },
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

function initials(name: string): string {
  return name
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export function UsersManager() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("employee");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [recoveryLink, setRecoveryLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [openMenu, setOpenMenu] = useState<number | null>(null);

  const refresh = useCallback(async (q = "") => {
    try {
      const r = await fetch(
        `/api/users?search=${encodeURIComponent(q)}`,
        { cache: "no-store" },
      );
      if (r.status === 403) {
        setForbidden(true);
        setUsers([]);
        return;
      }
      if (!r.ok) {
        setError("Erreur de chargement");
        setUsers([]);
        return;
      }
      const j = await r.json();
      setUsers(j.users || []);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // debounced search
  useEffect(() => {
    const t = setTimeout(() => refresh(search), 300);
    return () => clearTimeout(t);
  }, [search, refresh]);

  async function submitInvite() {
    if (!inviteName.trim() || !inviteEmail.trim()) return;
    setInviteSubmitting(true);
    setRecoveryLink(null);
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: inviteName.trim(),
          email: inviteEmail.trim(),
          role: inviteRole,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setRecoveryLink(j.recovery_link || null);
      setInviteName("");
      setInviteEmail("");
      setInviteRole("employee");
      await refresh();
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function changeRole(u: PublicUser, role: Role) {
    setOpenMenu(null);
    if (u.role === role) return;
    await fetch(`/api/users/${u.pk}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    refresh(search);
  }

  async function toggleActive(u: PublicUser) {
    setOpenMenu(null);
    if (
      u.is_active &&
      !confirm(`Désactiver ${u.name} ? L'utilisateur ne pourra plus se connecter.`)
    ) {
      return;
    }
    await fetch(`/api/users/${u.pk}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    refresh(search);
  }

  async function regenerateRecovery(u: PublicUser) {
    setOpenMenu(null);
    const r = await fetch(`/api/users/${u.pk}/recovery`, { method: "POST" });
    if (!r.ok) {
      setError("Génération du lien impossible");
      return;
    }
    const j = await r.json();
    if (j.link) {
      setRecoveryLink(j.link);
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <AlertCircle size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            Cette page est accessible uniquement aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Users size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Utilisateurs</h1>
            <p className="text-sm text-muted">
              {users.length} compte{users.length > 1 ? "s" : ""} · Géré via Authentik
            </p>
          </div>
        </div>
        <button
          onClick={() => { setInviteOpen(true); setRecoveryLink(null); }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default shrink-0"
        >
          <UserPlus size={16} />
          Inviter un utilisateur
        </button>
      </header>

      {/* Recherche */}
      <div className="mb-4 relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher par nom ou email…"
          className="w-full bg-card border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary transition-default"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* Tableau */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-[2.5fr_1fr_auto_1.2fr_auto] gap-4 px-4 py-2.5 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-muted/10">
          <div>Utilisateur</div>
          <div>Rôle</div>
          <div>Statut</div>
          <div>Dernière connexion</div>
          <div className="w-8" />
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Chargement…</div>
        ) : users.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Aucun utilisateur.</div>
        ) : (
          users.map((u) => {
            const RoleIcon = ROLE_LABEL[u.role].icon;
            return (
              <div
                key={u.pk}
                className="grid grid-cols-[2.5fr_1fr_auto_1.2fr_auto] gap-4 px-4 py-3 text-sm border-b border-border last:border-0 items-center hover:bg-muted/10"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 shrink-0 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-medium">
                    {initials(u.name || u.email)}
                  </div>
                  <div className="min-w-0">
                    <div className={"truncate font-medium " + (u.is_active ? "" : "text-muted line-through")}>
                      {u.name || u.username}
                    </div>
                    <div className="truncate text-xs text-muted">{u.email}</div>
                  </div>
                </div>
                <div>
                  <span
                    className={
                      "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full " +
                      ROLE_LABEL[u.role].cls
                    }
                  >
                    <RoleIcon size={10} /> {ROLE_LABEL[u.role].label}
                  </span>
                </div>
                <div>
                  <span
                    className={
                      "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full " +
                      (u.is_active
                        ? "bg-accent/15 text-accent"
                        : "bg-muted/20 text-muted")
                    }
                  >
                    {u.is_active ? "actif" : "désactivé"}
                  </span>
                </div>
                <div className="text-xs text-muted">{relTime(u.last_login)}</div>
                <div className="relative">
                  <button
                    onClick={() => setOpenMenu(openMenu === u.pk ? null : u.pk)}
                    className="p-1.5 rounded hover:bg-muted/30 transition-default"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {openMenu === u.pk && (
                    <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-md border border-border bg-card shadow-lg py-1">
                      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">
                        Changer de rôle
                      </div>
                      {(["admin", "manager", "employee"] as Role[]).map((r) => (
                        <button
                          key={r}
                          onClick={() => changeRole(u, r)}
                          disabled={u.role === r}
                          className={
                            "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-default " +
                            (u.role === r
                              ? "bg-muted/15 text-muted cursor-default"
                              : "hover:bg-muted/30")
                          }
                        >
                          {(() => { const I = ROLE_LABEL[r].icon; return <I size={12} />; })()}
                          {ROLE_LABEL[r].label}
                          {u.role === r && (
                            <Check size={12} className="ml-auto text-accent" />
                          )}
                        </button>
                      ))}
                      <div className="my-1 border-t border-border" />
                      <button
                        onClick={() => regenerateRecovery(u)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-default"
                      >
                        <KeyRound size={12} /> Lien de mdp
                      </button>
                      <button
                        onClick={() => toggleActive(u)}
                        className={
                          "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-default " +
                          (u.is_active
                            ? "text-red-400 hover:bg-red-500/10"
                            : "text-accent hover:bg-accent/10")
                        }
                      >
                        <Power size={12} />
                        {u.is_active ? "Désactiver" : "Réactiver"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal Invite */}
      {inviteOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => { setInviteOpen(false); setRecoveryLink(null); }}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-md p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Inviter un utilisateur</h2>
              <button
                onClick={() => { setInviteOpen(false); setRecoveryLink(null); }}
                className="p-1 rounded hover:bg-muted/30"
              >
                <X size={16} />
              </button>
            </div>

            {!recoveryLink ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium block mb-1">Nom complet</label>
                  <input
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Marie Dupont"
                    className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">Email</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="marie.dupont@entreprise.fr"
                    className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">Rôle</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["admin", "manager", "employee"] as Role[]).map((r) => {
                      const I = ROLE_LABEL[r].icon;
                      const active = inviteRole === r;
                      return (
                        <button
                          key={r}
                          onClick={() => setInviteRole(r)}
                          className={
                            "px-2 py-2 rounded-md border text-xs transition-default flex flex-col items-center gap-1 " +
                            (active
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border hover:border-primary/50")
                          }
                        >
                          <I size={14} />
                          {ROLE_LABEL[r].label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  onClick={submitInvite}
                  disabled={!inviteName.trim() || !inviteEmail.trim() || inviteSubmitting}
                  className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default disabled:opacity-40"
                >
                  <UserPlus size={14} />
                  {inviteSubmitting ? "Création…" : "Créer l'utilisateur"}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md bg-accent/10 border border-accent/30 text-accent text-sm px-3 py-2">
                  Utilisateur créé. Transmettez ce lien pour qu'il définisse
                  son mot de passe :
                </div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={recoveryLink}
                    className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-xs font-mono"
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    onClick={() => copyLink(recoveryLink)}
                    className="p-2 rounded-md border border-border hover:border-primary"
                    title="Copier"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-xs text-muted">
                  Le lien expire après usage ou au bout de 24h. Vous pourrez en
                  générer un nouveau depuis le menu de l'utilisateur.
                </p>
                <button
                  onClick={() => { setInviteOpen(false); setRecoveryLink(null); }}
                  className="w-full mt-2 px-4 py-2 rounded-md border border-border text-sm hover:bg-muted/20 transition-default"
                >
                  Fermer
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { Users } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

export default function UsersPage() {
  return (
    <PagePlaceholder
      icon={Users}
      title="Utilisateurs"
      description="Gérez les comptes et leurs accès aux outils."
      cta={{ label: "+ Inviter un utilisateur" }}
    >
      <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
        <Users size={32} className="mx-auto mb-3 opacity-50" />
        <p>Sprint 5 : CRUD utilisateurs via API Authentik.</p>
        <p className="text-xs mt-1">
          Connexion avec votre Active Directory / Microsoft 365 / Google Workspace possible.
        </p>
      </div>
    </PagePlaceholder>
  );
}

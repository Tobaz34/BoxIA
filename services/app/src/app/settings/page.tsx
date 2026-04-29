import { Settings as SettingsIcon } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";
import { CustomInstructionsCard } from "@/components/CustomInstructionsCard";
import { branding } from "@/lib/branding";

export default function SettingsPage() {
  return (
    <PagePlaceholder
      icon={SettingsIcon}
      title="Paramètres"
      description="Personnalisation des assistants, branding, intégrations."
    >
      <div className="space-y-4">
        <CustomInstructionsCard />

        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-2">Branding</h2>
          <dl className="text-sm space-y-1 text-muted">
            <div className="flex justify-between"><dt>Nom :</dt><dd className="text-foreground">{branding.name}</dd></div>
            <div className="flex justify-between"><dt>Couleur primaire :</dt><dd className="text-foreground font-mono">{branding.primaryColor}</dd></div>
            <div className="flex justify-between"><dt>Logo :</dt><dd className="text-foreground">{branding.logoUrl || "(par défaut)"}</dd></div>
            <div className="flex justify-between"><dt>Client :</dt><dd className="text-foreground">{branding.clientName || "—"}</dd></div>
          </dl>
          <p className="text-xs text-muted mt-3">Modification : édite <code>.env</code> du serveur (variables BRAND_*) puis restart.</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-2">Sauvegardes</h2>
          <p className="text-sm text-muted">Sprint 6 : configuration backup offsite (Wasabi / B2 / S3).</p>
        </div>
      </div>
    </PagePlaceholder>
  );
}

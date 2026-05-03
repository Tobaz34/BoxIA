import { Settings as SettingsIcon } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";
import { CustomInstructionsCard } from "@/components/CustomInstructionsCard";
import { BrandingCard } from "@/components/BrandingCard";
import { SeedDemoCard } from "@/components/SeedDemoCard";
import { LanguageCard } from "@/components/LanguageCard";
import { VersionCard } from "@/components/VersionCard";
import { CloudProvidersCard } from "@/components/CloudProvidersCard";

export default function SettingsPage() {
  return (
    <PagePlaceholder
      icon={SettingsIcon}
      title="Paramètres"
      description="Personnalisation des assistants, branding, intégrations."
    >
      <div className="space-y-4">
        <VersionCard />
        <LanguageCard />
        <CustomInstructionsCard />
        <BrandingCard />
        <CloudProvidersCard />
        <SeedDemoCard />
        <div className="bg-card border border-border rounded-lg p-4 opacity-70">
          <h2 className="font-semibold mb-2">Sauvegardes hors-site</h2>
          <p className="text-sm text-muted">
            Bientôt disponible. Configuration de backup automatique vers un stockage S3-compatible
            (Wasabi, Backblaze B2, AWS S3) pour les conversations, agents personnalisés et base
            de connaissances.
          </p>
          <p className="text-xs text-muted mt-2">
            En attendant : un snapshot Qdrant hebdomadaire est déjà actif (cf. Automatisations) et
            les volumes Docker sont sauvegardables manuellement avec <code className="bg-background px-1 rounded">backup.sh</code>.
          </p>
        </div>
      </div>
    </PagePlaceholder>
  );
}

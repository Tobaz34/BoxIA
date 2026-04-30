import { Settings as SettingsIcon } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";
import { CustomInstructionsCard } from "@/components/CustomInstructionsCard";
import { BrandingCard } from "@/components/BrandingCard";

export default function SettingsPage() {
  return (
    <PagePlaceholder
      icon={SettingsIcon}
      title="Paramètres"
      description="Personnalisation des assistants, branding, intégrations."
    >
      <div className="space-y-4">
        <CustomInstructionsCard />
        <BrandingCard />
        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-2">Sauvegardes</h2>
          <p className="text-sm text-muted">Sprint 6 : configuration backup offsite (Wasabi / B2 / S3).</p>
        </div>
      </div>
    </PagePlaceholder>
  );
}

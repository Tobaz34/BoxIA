import { Workflow } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

export default function WorkflowsPage() {
  return (
    <PagePlaceholder
      icon={Workflow}
      title="Automatisations"
      description="Tâches qui s'exécutent automatiquement (emails, factures, alertes...)."
      cta={{ label: "+ Nouvelle automatisation", href: "/workflows/new" }}
    >
      <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
        <Workflow size={32} className="mx-auto mb-3 opacity-50" />
        <p>Aucune automatisation pour le moment.</p>
        <p className="text-xs mt-1">
          Sprint 4 : intégration n8n (liste / activate / éditeur visuel embarqué).
        </p>
      </div>
    </PagePlaceholder>
  );
}

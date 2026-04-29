import { FileText } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

export default function DocumentsPage() {
  return (
    <PagePlaceholder
      icon={FileText}
      title="Documents"
      description="Vos fichiers indexés, accessibles depuis l'IA via RAG."
      cta={{ label: "+ Importer un document" }}
    >
      <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
        <FileText size={32} className="mx-auto mb-3 opacity-50" />
        <p>Aucun document indexé pour le moment.</p>
        <p className="text-xs mt-1">
          Selon vos connecteurs activés (SharePoint, Google Drive, NAS, Nextcloud), les documents seront indexés automatiquement.
        </p>
      </div>
    </PagePlaceholder>
  );
}

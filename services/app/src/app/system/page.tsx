import { Activity } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

export default function SystemPage() {
  return (
    <PagePlaceholder
      icon={Activity}
      title="État du serveur"
      description="Performance, ressources et santé des services."
    >
      <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
        <Activity size={32} className="mx-auto mb-3 opacity-50" />
        <p>Sprint 5 : graphiques live (CPU, RAM, GPU, services).</p>
        <p className="text-xs mt-1">Le widget compact dans le header montre déjà les ressources en temps réel.</p>
      </div>
    </PagePlaceholder>
  );
}

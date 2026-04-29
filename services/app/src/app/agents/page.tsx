import { Bot } from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

async function getAgents() {
  // TODO sprint 3 : fetch /api/agents (proxy vers Dify console API)
  return [];
}

export default async function AgentsPage() {
  const agents = await getAgents();

  return (
    <PagePlaceholder
      icon={Bot}
      title="Mes assistants IA"
      description="Construisez des assistants spécialisés sur vos cas métier."
      cta={{ label: "+ Nouveau", href: "/agents/new" }}
    >
      {agents.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
          <Bot size={32} className="mx-auto mb-3 opacity-50" />
          <p>Aucun assistant pour le moment.</p>
          <p className="text-xs mt-1">
            Au prochain reset, des assistants pré-configurés seront installés selon vos technologies cochées.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* TODO mapper les agents */}
        </div>
      )}
    </PagePlaceholder>
  );
}

import Link from "next/link";
import { api, type Client } from "@/lib/api";

export default async function ClientsPage() {
  let clients: Client[] = [];
  let error: string | null = null;
  try {
    clients = await api.listClients();
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="grid gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients ({clients.length})</h1>
        <Link href="/clients/new" className="bg-primary text-white px-4 py-2 rounded font-medium hover:bg-blue-600">
          + Nouveau déploiement
        </Link>
      </header>

      {error && (
        <div className="border border-danger/30 bg-danger/10 text-danger rounded p-4 text-sm">
          Backend injoignable : <code>{error}</code>
          <br />
          Démarrer le backend : <code>cd portal/backend && uvicorn main:app --reload</code>
        </div>
      )}

      {!error && clients.length === 0 && (
        <div className="border border-dashed border-border rounded p-8 text-center text-muted">
          Aucun client. Cliquez sur « + Nouveau déploiement » pour commencer.
        </div>
      )}

      {clients.length > 0 && (
        <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
          <thead className="bg-panel2 text-left">
            <tr>
              <th className="p-3">Client</th>
              <th className="p-3">Secteur</th>
              <th className="p-3">Domaine</th>
              <th className="p-3">Profil</th>
              <th className="p-3">Statut</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-t border-border hover:bg-panel">
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3 text-muted">{c.sector}</td>
                <td className="p-3 font-mono text-xs">{c.domain}</td>
                <td className="p-3">{c.hw_profile}</td>
                <td className="p-3">
                  <StatusBadge status={c.status} />
                </td>
                <td className="p-3 text-right">
                  <Link href={`/clients/${c.id}`} className="text-primary hover:underline">
                    Détails →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Client["status"] }) {
  const colors: Record<Client["status"], string> = {
    draft:     "bg-muted/20 text-muted",
    deploying: "bg-warn/20 text-warn",
    deployed:  "bg-accent/20 text-accent",
    failed:    "bg-danger/20 text-danger",
  };
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

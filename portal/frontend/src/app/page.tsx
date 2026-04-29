import Link from "next/link";

export default function Home() {
  return (
    <div className="grid gap-8 max-w-3xl mx-auto py-12">
      <section>
        <h1 className="text-3xl font-semibold mb-2">Portail de provisioning AI Box</h1>
        <p className="text-muted">
          Outil interne. Paramétrer et déployer une AI Box chez un nouveau client en quelques minutes.
        </p>
      </section>

      <section className="grid sm:grid-cols-2 gap-4">
        <Link href="/clients" className="block p-6 bg-panel border rounded-lg hover:border-primary transition">
          <div className="text-2xl mb-2">📋</div>
          <div className="font-semibold">Voir les clients</div>
          <div className="text-sm text-muted">Liste des serveurs déjà déployés ou en attente</div>
        </Link>

        <Link href="/clients/new" className="block p-6 bg-panel border rounded-lg hover:border-primary transition">
          <div className="text-2xl mb-2">🚀</div>
          <div className="font-semibold">Nouveau déploiement</div>
          <div className="text-sm text-muted">Lancer le wizard de qualification + provisioning</div>
        </Link>
      </section>

      <section className="text-sm text-muted">
        <p>
          Le portail communique avec le backend FastAPI <code className="text-text">portal/backend</code>.
          Démarrer le backend en dev : <code className="text-text">uvicorn main:app --reload</code> dans <code>portal/backend/</code>.
        </p>
      </section>
    </div>
  );
}

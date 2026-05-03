import {
  HelpCircle, MessageSquare, Mic, Volume2, Paperclip, Slash,
  Keyboard, Bot, FileText, Users, Shield, Activity,
  Github, Mail, Bug, Sparkles, Upload,
} from "lucide-react";
import { PagePlaceholder } from "@/components/PagePlaceholder";

export const dynamic = "force-dynamic";

export default function HelpPage() {
  return (
    <PagePlaceholder
      icon={HelpCircle}
      title="Aide & onboarding"
      description="Tout ce qu'il faut pour démarrer avec votre AI Box. Cette page n'est pas exhaustive — n'hésitez pas à demander à l'Assistant général via le chat."
    >
      <div className="space-y-6 max-w-4xl">

        {/* ======== Démarrage rapide ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Premiers pas (3 minutes)</h2>
          </div>
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">1</span>
              <div>
                <strong>Changez votre mot de passe par défaut</strong> — la bannière ambre en haut vous le rappelle.
                Cliquez « Changer maintenant », un onglet Authentik s'ouvre, suivez les étapes, revenez puis « J'ai changé ».
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">2</span>
              <div>
                <strong>Posez votre première question</strong> dans <a href="/" className="text-primary hover:underline">Discuter</a>.
                Cliquez sur une suggestion ou tapez directement votre question.
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">3</span>
              <div>
                <strong>Importez vos documents</strong> dans <a href="/documents" className="text-primary hover:underline">Documents</a> :
                glissez vos PDF, contrats, procédures internes. Tous les assistants pourront ensuite y faire référence.
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">4</span>
              <div>
                <strong>Invitez vos collaborateurs</strong> dans <a href="/users" className="text-primary hover:underline">Utilisateurs</a> &mdash;
                ils auront chacun leur compte SSO et leur historique de conversations privé.
              </div>
            </li>
          </ol>
        </section>

        {/* ======== Features hands-free ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Le chat sait faire bien plus que taper du texte</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <FeatureRow icon={Upload}    title="Glisser un fichier"
              hint="Déposez un PDF, DOCX, XLSX, image directement dans la conversation. L'IA l'analyse et répond." />
            <FeatureRow icon={Paperclip} title="Cliquer le trombone"
              hint="Sélectionnez un fichier depuis votre ordinateur. Multi-fichiers supportés." />
            <FeatureRow icon={Mic}       title="Dicter à la voix"
              hint="Cliquez le micro et parlez. La voix reste dans votre navigateur (privacy-first)." />
            <FeatureRow icon={Volume2}   title="Écouter la réponse"
              hint="Cliquez le bouton volume sous une réponse pour la faire lire à haute voix." />
            <FeatureRow icon={Slash}     title="Commandes /"
              hint="Tapez « / » pour ouvrir le menu : /new, /regen, /agent, /export, /summarize…" />
            <FeatureRow icon={Bot}       title="Plusieurs agents"
              hint="Sélectionnez l'agent en haut de la liste de conversations : général, vision, comptable, RH, support, juridique, concierge." />
          </div>
        </section>

        {/* ======== Raccourcis clavier ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <Keyboard size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Raccourcis clavier</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            <ShortcutRow keys={["Ctrl", "K"]}           label="Nouvelle conversation" />
            <ShortcutRow keys={["Entrée"]}              label="Envoyer le message" />
            <ShortcutRow keys={["Shift", "Entrée"]}     label="Saut de ligne dans le message" />
            <ShortcutRow keys={["/"]}                   label="Ouvrir le menu commandes (hors champ)" />
            <ShortcutRow keys={["Échap"]}               label="Stopper le streaming (ou la lecture vocale)" />
            <ShortcutRow keys={["Tab"]}                 label="Auto-complète une commande slash" />
          </div>
        </section>

        {/* ======== Sections principales ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Les autres sections</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <SectionRow icon={Bot}      href="/agents"
              title="Mes assistants"
              hint="Configurer le pre-prompt, l'opening et les questions suggérées de chaque agent." />
            <SectionRow icon={FileText} href="/documents"
              title="Documents"
              hint="Importer la base de connaissances partagée par tous les assistants. PDF, DOCX, XLSX, MD…" />
            <SectionRow icon={Users}    href="/users"
              title="Utilisateurs"
              hint="Inviter / désactiver les utilisateurs. Géré via Authentik (SSO)." />
            <SectionRow icon={Shield}   href="/audit"
              title="Audit"
              hint="Historique des actions effectuées par chaque utilisateur." />
            <SectionRow icon={Activity} href="/system"
              title="État du serveur"
              hint="Santé des services, ressources hardware, KPIs d'activité." />
          </div>
        </section>

        {/* ======== FAQ ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <h2 className="text-lg font-semibold mb-3">FAQ</h2>
          <div className="space-y-3 text-sm">
            <Faq q="L'IA ne répond pas / met du temps">
              Le 1<sup>er</sup> message d'une nouvelle conversation peut prendre 10-20s (chargement
              du modèle en VRAM). Les suivants sont quasi-instantanés. Si ça reste bloqué &gt; 60s,
              vérifiez « Ollama » dans <a href="/system" className="text-primary hover:underline">État du serveur</a>.
              Si vous switchez d'un agent texte vers Vision (ou inversement), un fallback cloud
              peut être proposé si la VRAM ne suffit pas pour les deux modèles en parallèle.
            </Faq>
            <Faq q="Mes données quittent-elles le serveur ?">
              <strong>Non.</strong> Tout reste sur votre AI Box : conversations, documents, agents.
              Seules exceptions : si vous activez un connecteur cloud (Google Drive, M365), la box
              va lire ces sources externes pour l'indexation.
            </Faq>
            <Faq q="Comment changer le mot de passe d'un autre utilisateur ?">
              Allez dans <a href="/users" className="text-primary hover:underline">Utilisateurs</a> &rarr;
              clic sur les 3 points de l'utilisateur &rarr; Réinitialiser le mot de passe. Pour
              récupérer un compte admin perdu, lancez sur la box :
              {" "}<code className="bg-background px-1.5 py-0.5 rounded text-xs">sudo ./recover-admin-password.sh --random</code>
            </Faq>
            <Faq q="Comment ajouter un assistant personnalisé ?">
              Allez dans <a href="/agents" className="text-primary hover:underline">Mes assistants</a> et
              cliquez « Nouvel assistant » pour créer un agent 100&nbsp;% custom (nom, icône, pre-prompt,
              modèle, rôles autorisés). Pour modifier l'un des 7 agents par défaut (général, vision,
              comptable, RH, support, concierge, juridique), cliquez « Configurer » sur sa carte.
              Vous pouvez aussi activer en 1 clic un template depuis la <a href="/agents/marketplace" className="text-primary hover:underline">Marketplace IA</a>.
            </Faq>
            <Faq q="Mes documents sont-ils utilisés pour entraîner le modèle ?">
              <strong>Non.</strong> Vos documents sont indexés via embeddings (RAG) pour permettre
              à l'IA de les citer comme sources, mais aucun fine-tuning n'est effectué. Les modèles
              IA livrés (qwen3:14b pour le texte, qwen2.5vl:7b pour la vision) restent intacts.
            </Faq>
            <Faq q="Quelle est la limite de taille pour un fichier ?">
              <strong>15 Mo</strong> par document texte (PDF, DOCX, XLSX, CSV, MD…) et
              <strong> 8 Mo</strong> par image (PNG, JPG). Pour des fichiers plus gros, splittez-les
              ou utilisez un connecteur cloud (Drive, SharePoint, NAS…).
            </Faq>
            <Faq q="Comment exporter une conversation ?">
              Tapez <code>/export</code> dans le chat ou cliquez l'icône télécharger en haut de la
              conversation. Vous obtenez un fichier Markdown lisible avec tout l'historique.
            </Faq>
          </div>
        </section>

        {/* ======== Liens ======== */}
        <section className="bg-card border border-border rounded-lg p-5">
          <h2 className="text-lg font-semibold mb-3">Aller plus loin</h2>
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <a href="https://github.com/Tobaz34/BoxIA"
               target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-2 p-3 rounded-md border border-border hover:border-primary hover:bg-primary/5 transition-default">
              <Github size={16} className="text-primary" />
              <div>
                <div className="font-medium">Code source</div>
                <div className="text-[11px] text-muted">github.com/Tobaz34/BoxIA</div>
              </div>
            </a>
            <a href="mailto:support@aibox.local"
               className="flex items-center gap-2 p-3 rounded-md border border-border hover:border-primary hover:bg-primary/5 transition-default">
              <Mail size={16} className="text-primary" />
              <div>
                <div className="font-medium">Support</div>
                <div className="text-[11px] text-muted">support@aibox.local</div>
              </div>
            </a>
            <a href="https://github.com/Tobaz34/BoxIA/issues/new"
               target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-2 p-3 rounded-md border border-border hover:border-primary hover:bg-primary/5 transition-default">
              <Bug size={16} className="text-primary" />
              <div>
                <div className="font-medium">Signaler un bug</div>
                <div className="text-[11px] text-muted">GitHub Issues</div>
              </div>
            </a>
          </div>
        </section>
      </div>
    </PagePlaceholder>
  );
}

// ===== Sub-components =================================================

function FeatureRow({
  icon: Icon, title, hint,
}: { icon: typeof MessageSquare; title: string; hint: string }) {
  return (
    <div className="flex gap-3 p-2 rounded-md hover:bg-muted/15 transition-default">
      <Icon size={16} className="text-primary shrink-0 mt-0.5" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex items-center gap-1 shrink-0">
        {keys.map((k, i) => (
          <kbd key={i}
               className="px-1.5 py-0.5 rounded bg-muted/30 text-[10px] font-mono border border-border">
            {k}
          </kbd>
        ))}
      </div>
      <span className="text-muted text-xs">→</span>
      <span>{label}</span>
    </div>
  );
}

function SectionRow({
  icon: Icon, href, title, hint,
}: { icon: typeof MessageSquare; href: string; title: string; hint: string }) {
  return (
    <a href={href}
       className="flex gap-3 p-3 rounded-md border border-border hover:border-primary hover:bg-primary/5 transition-default">
      <Icon size={16} className="text-primary shrink-0 mt-0.5" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
    </a>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-border bg-background/40 px-3 py-2 group">
      <summary className="cursor-pointer font-medium select-none list-none flex items-center justify-between">
        <span>{q}</span>
        <span className="text-muted text-xs group-open:rotate-90 transition-transform">▶</span>
      </summary>
      <div className="mt-2 text-muted leading-relaxed">{children}</div>
    </details>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Questionnaire, type QuestionItem } from "@/lib/api";

type StepKey = 1 | 2 | 3 | 4 | 5;

export default function NewClientWizard() {
  const [step, setStep] = useState<StepKey>(1);
  const router = useRouter();

  const [data, setData] = useState({
    name: "",
    sector: "services",
    users_count: 10,
    hw_profile: "tpe" as "tpe" | "pme" | "pme-plus",
    domain: "",
    admin_email: "",
    server_ip: "",
    server_user: "clikinfo",
    technologies: {} as Record<string, string>,
  });
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step === 3 && !questionnaire) {
      api.questionnaire().then(setQuestionnaire).catch((e) => setError(String(e)));
    }
  }, [step, questionnaire]);

  function update<K extends keyof typeof data>(k: K, v: (typeof data)[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.createClient({
        name: data.name,
        sector: data.sector,
        users_count: data.users_count,
        domain: data.domain,
        admin_email: data.admin_email,
        server_ip: data.server_ip,
        server_user: data.server_user,
        hw_profile: data.hw_profile,
      });
      await api.deploy(created.id, { technologies: data.technologies });
      router.push(`/clients/${created.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Stepper step={step} />

      {step === 1 && (
        <Card title="1. Identité du client">
          <Field label="Nom de l'entreprise">
            <input className="input" value={data.name} onChange={(e) => update("name", e.target.value)} />
          </Field>
          <Field label="Secteur">
            <select className="input" value={data.sector} onChange={(e) => update("sector", e.target.value)}>
              {["services","btp","juridique","sante","immobilier","comptabilite","autre"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Utilisateurs prévus">
            <input type="number" className="input" value={data.users_count}
                   onChange={(e) => update("users_count", parseInt(e.target.value || "0"))} />
          </Field>
          <Field label="Profil matériel">
            <select className="input" value={data.hw_profile} onChange={(e) => update("hw_profile", e.target.value as typeof data.hw_profile)}>
              <option value="tpe">TPE (1-5 users concurrents)</option>
              <option value="pme">PME (5-20)</option>
              <option value="pme-plus">PME+ (20-100)</option>
            </select>
          </Field>
          <Actions onNext={() => setStep(2)} canNext={data.name.length > 0} />
        </Card>
      )}

      {step === 2 && (
        <Card title="2. Cible technique">
          <Field label="IP du serveur cible (LAN ou VPN)">
            <input className="input font-mono" placeholder="192.168.1.100" value={data.server_ip} onChange={(e) => update("server_ip", e.target.value)} />
          </Field>
          <Field label="User SSH">
            <input className="input font-mono" value={data.server_user} onChange={(e) => update("server_user", e.target.value)} />
          </Field>
          <Field label="Domaine d'accès interne">
            <input className="input" placeholder="ai.monclient.fr" value={data.domain} onChange={(e) => update("domain", e.target.value.toLowerCase())} />
          </Field>
          <Field label="Email admin">
            <input className="input" type="email" value={data.admin_email} onChange={(e) => update("admin_email", e.target.value)} />
          </Field>
          <Actions onPrev={() => setStep(1)} onNext={() => setStep(3)}
                   canNext={!!data.server_ip && !!data.domain && !!data.admin_email} />
        </Card>
      )}

      {step === 3 && (
        <Card title="3. Environnement IT du client">
          {!questionnaire && <p className="text-muted">Chargement du questionnaire…</p>}
          {questionnaire && (
            <Questions
              items={questionnaire.items || []}
              values={data.technologies}
              onChange={(id, val) => update("technologies", { ...data.technologies, [id]: val })}
            />
          )}
          <Actions onPrev={() => setStep(2)} onNext={() => setStep(4)} canNext={true} />
        </Card>
      )}

      {step === 4 && (
        <Card title="4. Récapitulatif">
          <pre className="bg-bg p-4 rounded text-xs font-mono whitespace-pre-wrap border">
{JSON.stringify(data, null, 2)}
          </pre>
          <Actions onPrev={() => setStep(3)} nextLabel="🚀 Déployer" onNext={() => { setStep(5); submit(); }} canNext={!submitting} />
        </Card>
      )}

      {step === 5 && (
        <Card title="5. Déploiement">
          {submitting && <p className="text-muted">Création du client + envoi de la config au serveur…</p>}
          {error && (
            <div className="border border-danger/30 bg-danger/10 text-danger rounded p-3 text-sm">
              {error}
              <br />
              <button onClick={() => { setStep(4); setSubmitting(false); }} className="underline mt-2">← Revenir</button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Actions({ onPrev, onNext, canNext = true, nextLabel = "Suivant →" }: {
  onPrev?: () => void;
  onNext?: () => void;
  canNext?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="flex justify-between pt-4">
      {onPrev ? <button onClick={onPrev} className="btn">← Précédent</button> : <span />}
      {onNext && (
        <button onClick={onNext} disabled={!canNext} className="btn-primary disabled:opacity-50">
          {nextLabel}
        </button>
      )}
    </div>
  );
}

function Stepper({ step }: { step: StepKey }) {
  const steps = ["Identité", "Cible", "Environnement", "Récap", "Déploiement"];
  return (
    <div className="flex gap-1 text-xs">
      {steps.map((s, i) => {
        const n = (i + 1) as StepKey;
        const active = n === step;
        const done = n < step;
        return (
          <div key={s} className={`flex-1 px-3 py-2 border-b-2 text-center
            ${active ? "border-primary text-primary font-semibold" : ""}
            ${done ? "border-accent text-accent" : ""}
            ${!active && !done ? "border-border text-muted" : ""}`}>
            {n}. {s}
          </div>
        );
      })}
    </div>
  );
}

function Questions({ items, values, onChange }: {
  items: QuestionItem[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <div className="space-y-3">
      {items.map((q) => {
        const opts = (q.options || []) as { value: string; label: string }[];
        return (
          <div key={q.id} className="bg-panel2 border rounded-lg p-4 hover:border-primary transition">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">{q.icon || "•"}</span>
              <label htmlFor={`q-${q.id}`} className="font-semibold text-sm">{q.label}</label>
            </div>
            {q.hint && <p className="text-xs text-muted ml-7 mb-2">{q.hint}</p>}
            <select id={`q-${q.id}`} className="input mt-1"
                    value={values[q.id] || ""}
                    onChange={(e) => onChange(q.id, e.target.value)}>
              <option value="">— sélectionner —</option>
              {opts.map((o) => (
                <option key={o.value || (o as unknown as string)} value={o.value || (o as unknown as string)}>
                  {o.label || (o as unknown as string)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

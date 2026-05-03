/**
 * Configure un provider cloud (OpenAI / Anthropic / Mistral) dans Dify
 * via la console API. Permet à BoxIA de pousser la clé API du client
 * (BYOK) sans qu'il ait à ouvrir la console Dify lui-même.
 *
 * Endpoint Dify (capturé via devtools 1.10) :
 *   POST /console/api/workspaces/current/model-providers/<provider>/credentials
 *   body : { credentials: { api_key: <key>, [api_base, organization, etc.] } }
 *
 * Idempotent : si le provider est déjà configuré, l'endpoint update.
 *
 * Cette fonction tourne CÔTÉ aibox-app (pas Dify), elle a donc besoin
 * de se logger sur Dify console comme admin pour pousser. Réutilise le
 * `consoleFetch` existant qui gère access_token + csrf.
 */
import { consoleFetch } from "@/lib/dify-console";
import { CLOUD_PROVIDERS, type CloudProviderId } from "@/lib/cloud-providers";

export async function configureCloudProviderInDify(
  id: CloudProviderId,
  apiKey: string,
  enabledModels: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    return { ok: false, error: `unknown provider: ${id}` };
  }

  // 1. Pousser les credentials du provider
  // Schema attendu varie selon le provider — on fait du best-effort :
  //   - openai : { api_key, [api_base, organization] }
  //   - anthropic : { anthropic_api_key }
  //   - mistral : { mistralai_api_key }
  // On envoie les noms les plus courants ; Dify ignore les champs inconnus.
  const credentials: Record<string, string> = {
    api_key: apiKey,
  };
  if (id === "anthropic") credentials.anthropic_api_key = apiKey;
  if (id === "mistral") credentials.mistralai_api_key = apiKey;

  // BUG fix 2026-05-03 : Dify ≥ 1.10 exige `/credentials` à la fin pour
  // PERSISTER (sans, le POST sur la racine du provider renvoie 405
  // method_not_allowed). Pareil pattern que `models/credentials` qui
  // persiste vs `models` qui renvoie success vide.
  const basePath = `/console/api/workspaces/current/model-providers/${provider.dify_provider}`;
  const credPath = `${basePath}/credentials`;
  try {
    const r = await consoleFetch(credPath, {
      method: "POST",
      body: JSON.stringify({ credentials }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `Dify provider config HTTP ${r.status}: ${text.slice(0, 200)}`,
      };
    }
  } catch (e) {
    return { ok: false, error: `Dify provider config: ${String(e).slice(0, 200)}` };
  }

  // 2. Activer les modèles recommandés (best-effort, on ignore les erreurs).
  //    Pour les providers cloud "officiels" (OpenAI/Anthropic/Mistral),
  //    Dify expose nativement la liste des modèles via le credential
  //    POST ci-dessus — pas besoin de re-POSTer chaque modèle.
  //    Pour Ollama (custom provider), il faut un POST par modèle. Ici
  //    on ne le fait QUE si le provider est ollama (skip pour cloud
  //    où c'est inutile + génère des 405).
  if (provider.dify_provider.includes("ollama")) {
    for (const model of enabledModels) {
      try {
        await consoleFetch(`${basePath}/models/credentials`, {
          method: "POST",
          body: JSON.stringify({
            model,
            model_type: "llm",
            credentials: { api_key: apiKey, mode: "chat" },
          }),
        });
      } catch {
        // best-effort
      }
    }
  }

  return { ok: true };
}

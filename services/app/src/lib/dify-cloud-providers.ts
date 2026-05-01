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

  const credPath = `/console/api/workspaces/current/model-providers/${provider.dify_provider}`;
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

  // 2. Activer les modèles recommandés (best-effort, on ignore les erreurs)
  // Endpoint : POST /console/api/workspaces/current/model-providers/<provider>/models/credentials
  // body : { model, model_type: "llm", credentials: { ... } }
  for (const model of enabledModels) {
    try {
      await consoleFetch(`${credPath}/models/credentials`, {
        method: "POST",
        body: JSON.stringify({
          model,
          model_type: "llm",
          credentials: { api_key: apiKey, mode: "chat" },
        }),
      });
    } catch {
      // best-effort : on continue même si un modèle ne peut pas être ajouté
    }
  }

  return { ok: true };
}

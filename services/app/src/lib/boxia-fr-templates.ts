/**
 * Templates BoxIA-FR : agents Dify pré-écrits pour le marché TPE/PME français
 * (compta, RH, juridique, BTP, e-commerce, helpdesk).
 *
 * Catalogue dans `templates/dify/boxia-fr/_catalog.json` (bind-mounté en
 * `/templates/dify/boxia-fr/_catalog.json`).
 *
 * À la différence de Dify Explorer (~50 templates EN génériques), nos
 * templates sont :
 *   - en français
 *   - taillés pour les usages TPE/PME FR (TVA française, code du travail
 *     français, conventions BTP, RGPD européen, etc.)
 *   - configurés sur Qwen2.5-7B local (provider Ollama)
 *
 * L'install crée une app Dify via l'API console (POST /apps + PATCH
 * /apps/<id>/model-config) plutôt que via /apps/imports (DSL YAML), parce
 * que nos templates sont déclaratifs minimum (prompt + model + opening).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { consoleFetch } from "@/lib/dify-console";

const TEMPLATES_DIR =
  process.env.BOXIA_FR_TEMPLATES_DIR || "/templates/dify/boxia-fr";

export interface BoxiaFrCategory {
  id: string;
  label: string;
  icon: string;
}

export interface BoxiaFrTemplate {
  slug: string;
  name: string;
  icon: string;
  icon_background: string;
  category: string;
  description: string;
  mode: "chat" | "agent-chat";
  model: string;
  temperature: number;
  system_prompt: string;
  opening_statement: string;
  suggested_questions: string[];
  tags: string[];
}

export interface BoxiaFrCatalog {
  version: number;
  categories: BoxiaFrCategory[];
  templates: BoxiaFrTemplate[];
}

interface RawCatalog {
  version?: number;
  categories?: unknown;
  templates?: unknown;
}

export async function readBoxiaFrCatalog(): Promise<BoxiaFrCatalog> {
  const file = path.join(TEMPLATES_DIR, "_catalog.json");
  let raw: RawCatalog;
  try {
    const content = await fs.readFile(file, "utf-8");
    raw = JSON.parse(content) as RawCatalog;
  } catch (e) {
    throw new Error(
      `BoxIA-FR templates : impossible de lire ${file} : ${(e as Error).message}`,
    );
  }
  const categories: BoxiaFrCategory[] = Array.isArray(raw.categories)
    ? raw.categories
        .filter(
          (c): c is { id: string; label?: string; icon?: string } =>
            !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string",
        )
        .map((c) => ({
          id: c.id,
          label: typeof c.label === "string" ? c.label : c.id,
          icon: typeof c.icon === "string" ? c.icon : "📦",
        }))
    : [];
  const templates: BoxiaFrTemplate[] = Array.isArray(raw.templates)
    ? raw.templates
        .filter(
          (t): t is Record<string, unknown> =>
            !!t && typeof t === "object" && typeof (t as { slug?: unknown }).slug === "string",
        )
        .map((t) => ({
          slug: String(t.slug),
          name: typeof t.name === "string" ? t.name : String(t.slug),
          icon: typeof t.icon === "string" ? t.icon : "🤖",
          icon_background: typeof t.icon_background === "string" ? t.icon_background : "#E0E7FF",
          category: typeof t.category === "string" ? t.category : "misc",
          description: typeof t.description === "string" ? t.description : "",
          mode: (t.mode === "agent-chat" ? "agent-chat" : "chat") as "chat" | "agent-chat",
          model: typeof t.model === "string" ? t.model : "qwen2.5:7b",
          temperature: typeof t.temperature === "number" ? t.temperature : 0.3,
          system_prompt: typeof t.system_prompt === "string" ? t.system_prompt : "",
          opening_statement: typeof t.opening_statement === "string" ? t.opening_statement : "",
          suggested_questions: Array.isArray(t.suggested_questions)
            ? (t.suggested_questions as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : [],
          tags: Array.isArray(t.tags)
            ? (t.tags as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        }))
    : [];
  return { version: raw.version || 1, categories, templates };
}

export interface InstallBoxiaFrResult {
  app_id: string;
  name: string;
  mode: string;
  icon: string;
  icon_background: string;
  api_key: string;
}

/**
 * Installe un template BoxIA-FR dans Dify.
 *
 * Flow :
 *   1. POST /console/api/apps — crée l'app (mode chat ou agent-chat)
 *   2. POST /console/api/apps/<id>/model-config — configure le prompt
 *      système + opening_statement + suggested_questions
 *   3. POST /console/api/apps/<id>/api-keys — génère le bearer
 */
export async function installBoxiaFrTemplate(
  slug: string,
  options?: { name?: string; description?: string },
): Promise<InstallBoxiaFrResult> {
  const catalog = await readBoxiaFrCatalog();
  const tpl = catalog.templates.find((t) => t.slug === slug);
  if (!tpl) {
    throw new Error(`Template BoxIA-FR introuvable : ${slug}`);
  }

  const finalName = options?.name?.trim() || tpl.name;
  const finalDesc = options?.description?.trim() || tpl.description;

  // 1. Crée l'app
  const appBody = {
    name: finalName,
    description: finalDesc,
    mode: tpl.mode,
    icon_type: "emoji",
    icon: tpl.icon,
    icon_background: tpl.icon_background,
  };
  const appR = await consoleFetch("/console/api/apps", {
    method: "POST",
    body: JSON.stringify(appBody),
  });
  if (!appR.ok) {
    throw new Error(
      `Dify create app HTTP ${appR.status}: ${await appR.text().catch(() => "")}`,
    );
  }
  const appJson = (await appR.json()) as { id?: string };
  const appId = appJson.id;
  if (!appId) {
    throw new Error("Dify create app : pas d'id retourné");
  }

  // 2. Configure le model + prompt + opening + suggested_questions
  // qwen3 a un mode CoT activé par défaut qui expose son raisonnement
  // en anglais (<think>...</think>). On ajoute /no_think au pre_prompt
  // pour les agents qui tournent sur qwen3*. Détection conservative :
  // par défaut tous les templates BoxIA-FR utilisent le LLM_MAIN qui
  // depuis 2026-05-01 est qwen3:14b → on patche systématiquement.
  const NO_THINK_SUFFIX =
    "\n\nIMPORTANT : réponds toujours en français, directement, sans " +
    "exposer ton raisonnement intermédiaire ni de balises `<think>` " +
    "ou `<thinking>`. /no_think";
  const prePrompt = tpl.system_prompt.includes("/no_think")
    ? tpl.system_prompt
    : tpl.system_prompt.trimEnd() + NO_THINK_SUFFIX;
  const modelConfig = {
    pre_prompt: prePrompt,
    prompt_type: "simple",
    chat_prompt_config: {},
    completion_prompt_config: {},
    user_input_form: [],
    dataset_query_variable: "",
    opening_statement: tpl.opening_statement,
    suggested_questions: tpl.suggested_questions,
    suggested_questions_after_answer: { enabled: false },
    speech_to_text: { enabled: false },
    text_to_speech: { enabled: false, voice: "", language: "fr" },
    retriever_resource: { enabled: false },
    annotation_reply: { enabled: false },
    more_like_this: { enabled: false },
    sensitive_word_avoidance: { enabled: false, type: "", configs: [] },
    external_data_tools: [],
    model: {
      provider: "langgenius/ollama/ollama",
      name: tpl.model,
      mode: "chat",
      completion_params: {
        temperature: tpl.temperature,
        top_p: 0.9,
        max_tokens: 1024,
      },
    },
    agent_mode: {
      enabled: tpl.mode === "agent-chat",
      tools: [],
      strategy: "function_call",
    },
    dataset_configs: { datasets: { datasets: [] }, retrieval_model: "single" },
    file_upload: { enabled: false, allowed_file_types: [] },
  };

  const cfgR = await consoleFetch(
    `/console/api/apps/${appId}/model-config`,
    { method: "POST", body: JSON.stringify(modelConfig) },
  );
  if (!cfgR.ok) {
    // L'app est créée mais la config a foiré. On loggue et continue (l'admin
    // pourra finir manuellement dans la console Dify).
    console.warn(
      `[boxia-fr] model-config HTTP ${cfgR.status}: ${await cfgR.text().catch(() => "")}`,
    );
  }

  // 3. Génère l'App API key
  const keyR = await consoleFetch(`/console/api/apps/${appId}/api-keys`, {
    method: "POST",
  });
  if (!keyR.ok) {
    throw new Error(
      `Dify api-keys HTTP ${keyR.status}: ${await keyR.text().catch(() => "")}`,
    );
  }
  const keyJson = (await keyR.json()) as { token?: string };
  const apiKey = keyJson.token || "";

  return {
    app_id: appId,
    name: finalName,
    mode: tpl.mode,
    icon: tpl.icon,
    icon_background: tpl.icon_background,
    api_key: apiKey,
  };
}

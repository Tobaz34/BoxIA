/**
 * Dify marketplace — lecture des templates Explorer + installation d'apps.
 *
 * Permet à `services/app` de consommer la marketplace Dify (50+ templates)
 * sans que le client ait à ouvrir la console Dify (cf. principe UX unifié).
 *
 * Endpoints Dify utilisés (capturés via Chrome devtools, Dify 1.10) :
 *   GET  /console/api/explore/apps                  → liste les templates
 *   GET  /console/api/explore/apps/<TEMPLATE_ID>    → détail (incl. export_data DSL)
 *   POST /console/api/apps/imports                  → crée une nouvelle app à partir du DSL
 *   POST /console/api/apps/<APP_ID>/api-keys        → génère un Bearer "app-..."
 *
 * Auth : `consoleFetch()` (cookies + CSRF, déjà géré dans dify-console.ts).
 */
import { consoleFetch } from "@/lib/dify-console";

export type DifyAppMode = "chat" | "advanced-chat" | "workflow" | "agent-chat" | "completion";

export interface DifyTemplate {
  /** UUID du template dans la marketplace. */
  template_id: string;
  /** Nom affiché. */
  name: string;
  /** Mode de l'app (impact sur le rendu côté UX). */
  mode: DifyAppMode;
  /** Emoji ou caractère affiché. */
  icon: string;
  /** Couleur hex de fond de l'icône. */
  icon_background: string;
  /** Description user-facing en anglais (Dify ne propose pas de traduction). */
  description: string;
  /** Catégorie : "Dify 101", "Marketing", "Customer Service & Operations", etc. */
  category: string;
  /** Position d'affichage dans la marketplace. */
  position: number;
  /** True si visible dans la marketplace. */
  is_listed: boolean;
}

export interface DifyTemplatesResponse {
  templates: DifyTemplate[];
  categories: string[];
}

interface RawExploreApp {
  app_id: string;
  app: {
    id: string;
    name: string;
    mode: DifyAppMode;
    icon: string;
    icon_background: string;
  };
  description: string;
  category: string;
  position: number;
  is_listed: boolean;
}

/** Récupère la liste des templates depuis Dify Explorer. */
export async function listTemplates(): Promise<DifyTemplatesResponse> {
  const r = await consoleFetch("/console/api/explore/apps");
  if (!r.ok) {
    throw new Error(`Dify explore/apps HTTP ${r.status}`);
  }
  const data = await r.json();
  const apps: RawExploreApp[] = data.recommended_apps || [];
  const categoriesRaw: unknown = data.categories;
  const categories = Array.isArray(categoriesRaw)
    ? categoriesRaw.filter((c): c is string => typeof c === "string")
    : [];

  const templates: DifyTemplate[] = apps
    .filter((e) => e && e.app)
    .map((e) => ({
      template_id: e.app.id,
      name: e.app.name,
      mode: e.app.mode,
      icon: e.app.icon || "🤖",
      icon_background: e.app.icon_background || "#E0E7FF",
      description: e.description || "",
      category: e.category || "Other",
      position: e.position || 0,
      is_listed: e.is_listed !== false,
    }))
    .filter((t) => t.is_listed)
    .sort((a, b) => a.position - b.position);

  return { templates, categories };
}

interface DifyTemplateDetail {
  id: string;
  name: string;
  mode: DifyAppMode;
  icon: string;
  icon_background: string;
  /** YAML DSL exporté de l'app, importable via /apps/imports. */
  export_data: string;
}

/** Récupère le détail d'un template (incl. son YAML DSL). */
async function getTemplateDetail(templateId: string): Promise<DifyTemplateDetail> {
  const r = await consoleFetch(
    `/console/api/explore/apps/${encodeURIComponent(templateId)}`,
  );
  if (!r.ok) {
    throw new Error(`Dify template ${templateId} HTTP ${r.status}`);
  }
  return (await r.json()) as DifyTemplateDetail;
}

export interface InstallResult {
  /** UUID de la nouvelle app créée dans le workspace. */
  app_id: string;
  name: string;
  mode: DifyAppMode;
  icon: string;
  icon_background: string;
  /** Bearer token "app-..." pour appeler l'app via /v1/chat-messages. */
  api_key: string;
}

/**
 * Installe un template dans le workspace Dify courant + génère une App API key
 * pour l'utiliser depuis aibox-app.
 *
 * Flow :
 * 1. GET /explore/apps/<template_id>           → récupère le DSL
 * 2. POST /apps/imports {mode:"yaml-content", yaml_content, name}  → crée l'app
 * 3. POST /apps/<new_id>/api-keys              → génère la clé Bearer
 */
export async function installTemplate(
  templateId: string,
  options?: { name?: string; description?: string },
): Promise<InstallResult> {
  // 1. Récupère le DSL du template
  const detail = await getTemplateDetail(templateId);
  const finalName = options?.name?.trim() || detail.name;

  // 2. Import du DSL — capturé via devtools : payload = { mode, yaml_content, name }
  // Mode "yaml-content" = on passe le YAML inline (vs "yaml-url" pour github URL)
  const importBody = {
    mode: "yaml-content",
    yaml_content: detail.export_data,
    name: finalName,
    description: options?.description,
    icon_type: "emoji",
    icon: detail.icon,
    icon_background: detail.icon_background,
  };
  const importR = await consoleFetch("/console/api/apps/imports", {
    method: "POST",
    body: JSON.stringify(importBody),
  });
  if (!importR.ok) {
    throw new Error(
      `Dify apps/imports HTTP ${importR.status}: ${await importR.text().catch(() => "")}`,
    );
  }
  const imported = (await importR.json()) as {
    id: string;
    app_id?: string;
    name?: string;
    app_mode?: DifyAppMode;
    status?: string;
  };
  // L'endpoint renvoie `app_id` (UUID de l'app créée) et `id` (UUID de l'import)
  // distincts. On veut l'app_id pour la suite.
  const newAppId = imported.app_id || imported.id;
  if (!newAppId) {
    throw new Error("Dify apps/imports : pas d'app_id retourné");
  }

  // 3. Génère une App API key (Bearer app-...) pour usage depuis aibox-app
  const keyR = await consoleFetch(
    `/console/api/apps/${newAppId}/api-keys`,
    { method: "POST" },
  );
  if (!keyR.ok) {
    throw new Error(
      `Dify api-keys HTTP ${keyR.status}: ${await keyR.text().catch(() => "")}`,
    );
  }
  const keyJson = (await keyR.json()) as { token?: string };
  const apiKey = keyJson.token || "";
  if (!apiKey) {
    throw new Error("Dify api-keys : pas de token retourné");
  }

  return {
    app_id: newAppId,
    name: imported.name || finalName,
    mode: imported.app_mode || detail.mode,
    icon: detail.icon,
    icon_background: detail.icon_background,
    api_key: apiKey,
  };
}

/** Désinstalle une app Dify (delete définitif côté workspace). */
export async function uninstallApp(appId: string): Promise<void> {
  const r = await consoleFetch(`/console/api/apps/${appId}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`Dify delete app HTTP ${r.status}`);
  }
}

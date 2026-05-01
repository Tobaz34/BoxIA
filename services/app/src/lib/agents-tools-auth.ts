/**
 * Auth helper pour les endpoints `/api/agents-tools/*`.
 *
 * Ces endpoints sont appelés par le sidecar agents-autonomous OU par un
 * Custom Tool Dify (l'agent « Concierge BoxIA »). Auth = Bearer
 * AGENTS_API_KEY (la même que pour le sidecar — déjà auto-générée par
 * install.sh / wizard /api/configure et propagée à aibox-app via .env).
 */
export function checkAgentsToolsAuth(req: Request): boolean {
  const expected = process.env.AGENTS_API_KEY;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", hint: "Bearer AGENTS_API_KEY required" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

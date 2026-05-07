/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // L'app tourne dans Docker, on a besoin de l'output standalone pour la prod
  output: "standalone",
  // Désactive certains warnings inutiles dans le container
  experimental: {
    serverComponentsExternalPackages: [],
  },
  // Redirects de courtoisie pour les URLs "intuitivement attendues" mais
  // jamais montées en page (cf bug 2026-05-07 : un user tape /marketplace
  // dans la barre d'adresse → 404 alors que le menu sidebar pointe sur
  // /agents/marketplace pour les agents et /workflows/marketplace pour n8n).
  async redirects() {
    return [
      { source: "/marketplace", destination: "/agents/marketplace", permanent: false },
      { source: "/agents/list", destination: "/agents", permanent: false },
      { source: "/admin/users", destination: "/users", permanent: false },
    ];
  },
};

export default nextConfig;

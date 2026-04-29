/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // L'app tourne dans Docker, on a besoin de l'output standalone pour la prod
  output: "standalone",
  // Désactive certains warnings inutiles dans le container
  experimental: {
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;

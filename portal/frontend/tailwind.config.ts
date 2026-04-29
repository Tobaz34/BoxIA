import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:        "#0f1115",
        panel:     "#1a1d24",
        panel2:    "#232730",
        border:    "#2d3340",
        text:      "#e6e8eb",
        muted:     "#8b919d",
        primary:   "#3b82f6",
        accent:    "#10b981",
        warn:      "#f59e0b",
        danger:    "#ef4444",
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;

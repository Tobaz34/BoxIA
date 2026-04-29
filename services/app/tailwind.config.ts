import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Palette inspirée du wizard, brandable via CSS variables
        background:    "hsl(var(--background))",
        foreground:    "hsl(var(--foreground))",
        card:          "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        muted:         "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        border:        "hsl(var(--border))",
        input:         "hsl(var(--input))",
        primary:       "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        accent:        "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        destructive:   "hsl(var(--destructive))",
        "destructive-foreground": "hsl(var(--destructive-foreground))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};

export default config;

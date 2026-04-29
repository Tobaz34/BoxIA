import type { LucideIcon } from "lucide-react";

interface PagePlaceholderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  cta?: { label: string; href?: string };
  children?: React.ReactNode;
}

export function PagePlaceholder({ icon: Icon, title, description, cta, children }: PagePlaceholderProps) {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Icon size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted">{description}</p>
          </div>
        </div>
        {cta && (
          <a
            href={cta.href || "#"}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-default"
          >
            {cta.label}
          </a>
        )}
      </header>
      <section>{children}</section>
    </div>
  );
}

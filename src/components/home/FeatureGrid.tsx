import { BellIcon, ClockIcon, RouteIcon } from "@/components/icons";
import type { ReactNode } from "react";

interface Feature {
  icon: ReactNode;
  title: string;
  description: string;
}

const features: Feature[] = [
  {
    icon: <RouteIcon className="h-6 w-6" />,
    title: "Multi-modal routes",
    description:
      "Combine subway, streetcar, bus, and walking directions into a single trip plan.",
  },
  {
    icon: <ClockIcon className="h-6 w-6" />,
    title: "Real-time arrivals",
    description:
      "See live vehicle predictions so you know exactly when to leave. Coming soon.",
  },
  {
    icon: <BellIcon className="h-6 w-6" />,
    title: "Service alerts",
    description:
      "Get notified about delays and diversions before they disrupt your commute.",
  },
];

export default function FeatureGrid() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="grid gap-6 sm:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400">
              {feature.icon}
            </span>
            <h3 className="mt-4 font-semibold text-neutral-900 dark:text-white">
              {feature.title}
            </h3>
            <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

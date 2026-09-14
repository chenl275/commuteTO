import { StreetcarIcon } from "@/components/icons";
import { SITE_NAME } from "@/lib/constants";

interface LogoProps {
  size?: "sm" | "lg";
  /** "light" forces white wordmark text, for use on dark/colored backgrounds regardless of theme. */
  tone?: "auto" | "light";
}

export default function Logo({ size = "sm", tone = "auto" }: LogoProps) {
  const isLarge = size === "lg";
  const textColor =
    tone === "light" ? "text-white" : "text-neutral-900 dark:text-white";

  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex items-center justify-center rounded-lg bg-red-600 text-white ${
          isLarge ? "h-12 w-12" : "h-9 w-9"
        }`}
      >
        <StreetcarIcon className={isLarge ? "h-7 w-7" : "h-5 w-5"} />
      </span>
      <span
        className={`font-bold tracking-tight ${textColor} ${
          isLarge ? "text-3xl sm:text-4xl" : "text-xl"
        }`}
      >
        {SITE_NAME}
      </span>
    </div>
  );
}

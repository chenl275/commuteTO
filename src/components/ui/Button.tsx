import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const baseStyles =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-red-600 dark:focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:opacity-60";

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm shadow-red-600/20",
  secondary:
    "bg-neutral-100 text-neutral-900 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700",
  ghost:
    "bg-transparent text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
};

export default function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      // Browser extensions (password managers, form-fillers) commonly inject
      // attributes like `fdprocessedid` onto buttons after the server HTML
      // is generated but before React hydrates, which trips a false-positive
      // hydration warning here even though nothing in this component itself
      // is non-deterministic (no window/localStorage reads, no client-only
      // state) — confirmed via the sole call site (CommuteForm's submit
      // button), which only passes plain, SSR-stable props.
      suppressHydrationWarning
      className={`${baseStyles} ${variantStyles[variant]} px-5 py-3 text-sm sm:text-base ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

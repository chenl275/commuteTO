import type { InputHTMLAttributes, ReactNode } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  icon: ReactNode;
}

export default function FormField({
  id,
  label,
  icon,
  className = "",
  ...props
}: FormFieldProps) {
  return (
    <div className="flex-1">
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/60"
      >
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-white/40">
          {icon}
        </span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          className={`w-full rounded-xl border border-neutral-300 bg-white py-3 pl-10 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30 sm:text-base dark:border-white/15 dark:bg-white/10 dark:text-white dark:placeholder:text-white/40 dark:[color-scheme:dark] dark:focus:border-red-400 dark:focus:ring-red-400/40 ${className}`}
          {...props}
        />
      </div>
    </div>
  );
}

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
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-white/60"
      >
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40">
          {icon}
        </span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          className={`w-full rounded-xl border border-white/15 bg-white/10 py-3 pl-10 pr-3 text-sm text-white placeholder:text-white/40 [color-scheme:dark] focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/40 sm:text-base ${className}`}
          {...props}
        />
      </div>
    </div>
  );
}

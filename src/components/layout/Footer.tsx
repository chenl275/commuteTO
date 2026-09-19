import { SITE_NAME } from "@/lib/constants";

export default function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-neutral-500 sm:px-6 dark:text-neutral-400">
        <p>
          {/* This page is prerendered at build time, so the year embedded in
              that static HTML can lag behind the visitor's actual clock
              (e.g. built in December, viewed after New Year's) — suppress
              the resulting mismatch rather than forcing a client-only render
              for one digit. */}
          &copy; <span suppressHydrationWarning>{new Date().getFullYear()}</span> {SITE_NAME}. Not
          affiliated with the Toronto Transit Commission (TTC).
        </p>
      </div>
    </footer>
  );
}

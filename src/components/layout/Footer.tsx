import { SITE_NAME } from "@/lib/constants";

export default function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-neutral-500 sm:px-6 dark:text-neutral-400">
        <p>
          &copy; {new Date().getFullYear()} {SITE_NAME}. Not affiliated with
          the Toronto Transit Commission (TTC).
        </p>
        <p className="mt-1">
          Live routing and real-time transit data are coming soon.
        </p>
      </div>
    </footer>
  );
}

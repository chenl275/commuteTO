import TTCMap from "@/components/map/TTCMap";
import CommuteForm from "@/components/commute/CommuteForm";
import { SITE_TAGLINE } from "@/lib/constants";

export default function Hero() {
  return (
    <section className="relative h-[85vh] min-h-[560px] w-full">
      <TTCMap className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute inset-0">
        <div className="pointer-events-auto absolute inset-x-4 top-4 bottom-4 overflow-y-auto sm:inset-x-auto sm:bottom-auto sm:left-6 sm:top-1/2 sm:max-h-[calc(100%-3rem)] sm:w-[26rem] sm:-translate-y-1/2">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-red-600 dark:text-red-400">
            {SITE_TAGLINE}
          </p>
          <CommuteForm />
        </div>
      </div>
    </section>
  );
}

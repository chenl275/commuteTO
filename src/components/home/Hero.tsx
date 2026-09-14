import CommuteMap from "@/components/map/CommuteMap";
import CommuteForm from "@/components/commute/CommuteForm";
import { SITE_TAGLINE } from "@/lib/constants";

export default function Hero() {
  return (
    <section className="relative h-[85vh] min-h-[560px] w-full overflow-hidden">
      <CommuteMap className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute inset-0">
        <div className="pointer-events-auto absolute inset-x-4 top-4 sm:inset-x-auto sm:left-6 sm:top-1/2 sm:w-[26rem] sm:-translate-y-1/2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-red-400">
            {SITE_TAGLINE}
          </p>
          <h1 className="mb-4 text-xl font-bold tracking-tight text-white sm:text-2xl">
            Where are you commuting to?
          </h1>
          <CommuteForm />
        </div>
      </div>
    </section>
  );
}

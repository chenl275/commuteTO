import Logo from "@/components/branding/Logo";
import CommuteForm from "@/components/commute/CommuteForm";
import SkylineSilhouette from "./SkylineSilhouette";
import { SITE_DESCRIPTION, SITE_TAGLINE } from "@/lib/constants";

export default function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-neutral-950">
      {/* Base gradient: deep night sky */}
      <div className="absolute inset-0 bg-gradient-to-b from-black via-neutral-950 to-neutral-900" />

      {/* Ambient glow behind the logo */}
      <div className="absolute left-1/2 top-0 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/3 rounded-full bg-red-600/20 blur-3xl" />

      {/* Warm horizon glow above the skyline */}
      <div className="absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-red-600/25 via-red-900/10 to-transparent blur-2xl sm:h-72" />

      <SkylineSilhouette
        className="absolute inset-x-0 bottom-0 h-32 w-full text-black/90 sm:h-48 md:h-56"
      />

      <div className="relative px-4 pb-40 pt-14 sm:px-6 sm:pb-52 sm:pt-20">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <div className="animate-fade-in-up">
            <Logo size="lg" tone="light" />
          </div>
          <p className="mt-3 animate-fade-in-up text-sm font-semibold uppercase tracking-widest text-red-400 [animation-delay:100ms]">
            {SITE_TAGLINE}
          </p>
          <h1 className="mt-4 animate-fade-in-up text-3xl font-bold tracking-tight text-white sm:text-4xl md:text-5xl [animation-delay:150ms]">
            Get where you&apos;re going, faster.
          </h1>
          <p className="mt-4 max-w-xl animate-fade-in-up text-base text-white/70 sm:text-lg [animation-delay:200ms]">
            {SITE_DESCRIPTION}
          </p>
        </div>

        <div className="mx-auto mt-10 max-w-2xl animate-fade-in-up [animation-delay:250ms]">
          <CommuteForm />
        </div>
      </div>
    </section>
  );
}

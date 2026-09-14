import Logo from "@/components/branding/Logo";
import ThemeToggle from "@/components/theme/ThemeToggle";

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/80 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Logo />
        <ThemeToggle />
      </div>
    </header>
  );
}

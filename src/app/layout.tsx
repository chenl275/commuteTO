import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { THEME_STORAGE_KEY } from "@/components/theme/constants";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "@/lib/constants";
import { DetourMapProvider } from "@/lib/detourMapContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${SITE_NAME} | ${SITE_TAGLINE}`,
  description: SITE_DESCRIPTION,
};

// Sets the initial `dark` class on <html> before hydration so there is no
// light-mode flash for users who prefer (or previously chose) dark mode.
const themeInitScript = `
  (function () {
    try {
      var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
      var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (stored === "dark" || (!stored && prefersDark)) {
        document.documentElement.classList.add("dark");
      }
    } catch (e) {}
  })();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white text-neutral-900 transition-colors duration-200 dark:bg-neutral-950 dark:text-neutral-100">
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <DetourMapProvider>{children}</DetourMapProvider>
      </body>
    </html>
  );
}

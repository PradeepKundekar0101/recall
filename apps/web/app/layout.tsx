import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";

/**
 * One superfamily, two roles. Plex Mono carries every value on screen, because
 * every value on screen is telemetry off a live line; Plex Sans Condensed carries
 * labels and headers, condensed so a dense panel still reads from the back of the
 * room it is projected in.
 */
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const condensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-cond",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RECALL - operator console",
  description: "Live view of an AI voice agent recovering a dropped-off energy lead.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${mono.variable} ${condensed.variable}`}>
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

/**
 * Three faces, three jobs, after apps/web/DESIGN.md.
 *
 * Geist at 300 carries the one large line on screen - the person on the other
 * end of the call - in the light grotesque voice of Waldenburg, the ElevenLabs
 * display face it stands in for (Waldenburg is licensed, so it is not shipped).
 * Inter carries everything that is read: labels, values, the transcript. Geist
 * Mono carries the sandbox payload, which is code.
 */
const display = Geist({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--font-geist",
  display: "swap",
});

const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RECALL - operator console",
  description: "Live view of an AI voice agent recovering a dropped-off energy lead.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

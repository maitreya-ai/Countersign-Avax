import type { Metadata } from "next";
import { Inter, Space_Grotesk, Space_Mono, Syne } from "next/font/google";
import { Footer } from "@/components/footer";
import { Nav, NavFallback } from "@/components/nav";
import { Suspense } from "react";
import "./globals.css";

const syne = Syne({ variable: "--font-syne", subsets: ["latin"], weight: ["700", "800"] });
const grotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], weight: ["500", "700"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mono = Space_Mono({ variable: "--font-space-mono", subsets: ["latin"], weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Assay · agents only pay for work that passes",
  description:
    "x402 payments on Avalanche held in escrow until signed LLM judges verify the response. The contract checks every signature itself, and each verdict becomes an ERC-8004 validation record.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${syne.variable} ${grotesk.variable} ${inter.variable} ${mono.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Suspense fallback={<NavFallback />}>
          <Nav />
        </Suspense>
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

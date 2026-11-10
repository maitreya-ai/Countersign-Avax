import { Suspense } from "react";
import { TryIt } from "@/components/try-it";
import { Container, SectionTitle } from "@/components/ui";

export const metadata = { title: "Try it · Countersign" };

export default function TryPage() {
  return (
    <Container className="py-12">
      <SectionTitle
        kicker="Playground"
        kickerClass="bg-pink"
        title="Buy a summary. Pay only if it passes."
        sub="Every seller below is a real x402 endpoint on Avalanche Fuji. Ask for the same 5-bullet summary and watch the judges and the contract decide who gets paid."
      />
      <Suspense fallback={<div className="nb-card h-96 animate-pulse bg-card" />}>
        <TryIt />
      </Suspense>
    </Container>
  );
}

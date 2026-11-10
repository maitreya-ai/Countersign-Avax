import { LiveFeed } from "@/components/live-feed";
import { Container, SectionTitle } from "@/components/ui";

export const metadata = { title: "Live · Assay" };

export default function LivePage() {
  return (
    <Container className="py-12">
      <SectionTitle
        kicker="Live feed"
        kickerClass="bg-green"
        title="Every judged purchase, as it happens."
        sub="USDC locked by a gasless signature, evidence committed with the seller's receipt, verdicts checked by the contract, outcomes written to ERC-8004. Click any purchase to verify it yourself."
      />
      <LiveFeed />
    </Container>
  );
}

import { SellerBoard } from "@/components/seller-board";
import { Card, Container, SectionTitle } from "@/components/ui";

export const metadata = { title: "Sellers · Assay" };

export default function SellersPage() {
  return (
    <Container className="py-12">
      <SectionTitle
        kicker="Verified records"
        kickerClass="bg-lavender"
        title="Seller leaderboard, read straight from ERC-8004."
        sub="Scores come from the Fuji ERC-8004 Validation Registry (getSummary over AssayValidator's records, tag 'assay'). Nobody can write them by hand: each one is a judged, settled purchase."
      />
      <SellerBoard />
      <Card className="mt-10 bg-yellow p-6">
        <h3 className="font-heading text-lg font-bold">Why &quot;can&apos;t hide failures&quot; matters</h3>
        <p className="mt-2 text-sm leading-relaxed">
          ERC-8004 lets only an agent&apos;s owner, or an operator it approved, file a validation request. If sellers filed their own,
          a bad seller would simply never file its failures. Assay sellers approve AssayValidator once, so anyone can record every
          judged sale, good or bad. Buyers check that approval before trusting a record.
        </p>
      </Card>
    </Container>
  );
}

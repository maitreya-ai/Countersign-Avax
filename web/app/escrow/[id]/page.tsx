import { Suspense } from "react";
import { EscrowDetail } from "@/components/escrow-detail";
import { Container } from "@/components/ui";

export const metadata = { title: "Purchase · Assay" };

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EscrowDetail id={id} />;
}

export default function EscrowPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Container className="py-12">
      <Suspense fallback={<div className="nb-card h-64 animate-pulse bg-card" />}>
        <Detail params={params} />
      </Suspense>
    </Container>
  );
}

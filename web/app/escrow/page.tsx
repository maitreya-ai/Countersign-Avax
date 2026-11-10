"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EscrowDetail } from "@/components/escrow-detail";
import { Container } from "@/components/ui";

function Detail() {
  const id = useSearchParams().get("id") ?? "";
  return <EscrowDetail id={id} />;
}

export default function EscrowPage() {
  return (
    <Container className="py-12">
      <Suspense fallback={<div className="nb-card h-64 animate-pulse bg-card" />}>
        <Detail />
      </Suspense>
    </Container>
  );
}

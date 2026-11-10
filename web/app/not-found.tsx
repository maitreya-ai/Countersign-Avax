import Link from "next/link";
import { Container } from "@/components/ui";

export default function NotFound() {
  return (
    <Container className="py-24">
      <div className="nb-card max-w-xl bg-yellow p-8">
        <div className="font-display text-6xl font-extrabold">404</div>
        <h1 className="mt-2 font-heading text-2xl font-bold">This page didn&apos;t pass.</h1>
        <p className="mt-2 text-sm">The judges found no page at this address.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/" className="nb-btn bg-card">Home</Link>
          <Link href="/live" className="nb-btn bg-pink">Live purchases</Link>
        </div>
      </div>
    </Container>
  );
}

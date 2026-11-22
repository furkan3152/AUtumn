import { AutumnApp } from "@/components/AutumnApp";

// The HTML is rendered per request, so it is sent "no-store" and a shared cache never keeps an old page after a
// deploy; the hashed files under /_next/static stay cached for good.
export const dynamic = "force-dynamic";

export default function Page() {
  return <AutumnApp />;
}

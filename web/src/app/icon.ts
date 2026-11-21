import { faviconSvg } from "@/components/logoPixels";

export const contentType = "image/svg+xml";
export const dynamic = "force-static";

export default function Icon() {
  return new Response(faviconSvg(), { headers: { "Content-Type": "image/svg+xml" } });
}

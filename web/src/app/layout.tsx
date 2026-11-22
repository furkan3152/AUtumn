import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import "./globals.css";

const pixel = Pixelify_Sans({ subsets: ["latin"], variable: "--font-pixel", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const description =
  "Open a wallet with a passkey, deposit USD₮ on Celo, and let a helper buy Tether Gold for you within limits written onchain.";

export const metadata: Metadata = {
  title: "Autumn: a little gold every week",
  description,
  openGraph: { type: "website", siteName: "Autumn", title: "Autumn: a little gold every week", description },
  twitter: { card: "summary", title: "Autumn: a little gold every week", description },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#23150d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

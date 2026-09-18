import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SigPath",
  description: "Attestation infrastructure across Solana and Base.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

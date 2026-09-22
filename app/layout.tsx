import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Call Vault",
  description: "Provider-agnostic call/audio storage for captainprospect-crm",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

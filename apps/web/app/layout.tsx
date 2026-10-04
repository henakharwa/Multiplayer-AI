import type { Metadata } from "next";
import "./globals.css";
import { DialogProvider } from "./_components/DialogProvider";

export const metadata: Metadata = {
  title: "Nexus",
  description: "A shared AI workspace for teams, connected tools, and human-approved actions.",
  icons: {
    icon: "/nexus-landing-logo.png",
    shortcut: "/nexus-landing-logo.png",
    apple: "/nexus-landing-logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning><DialogProvider>{children}</DialogProvider></body>
    </html>
  );
}

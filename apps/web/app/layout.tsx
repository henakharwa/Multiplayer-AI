import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus",
  description: "A shared AI workspace for teams, connected tools, and human-approved actions.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

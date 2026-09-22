import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multiplayer AI",
  description: "A shared group chat workspace with an AI teammate that reads your GitHub and Slack.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

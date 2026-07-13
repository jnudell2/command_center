import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Serent Command Center",
  description:
    "Jake's company action inbox, shared workbench, notes, and Codex agent home.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

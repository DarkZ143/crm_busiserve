import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Busiserve Workspace", template: "%s · Busiserve Workspace" },
  description: "Secure client and project operations for Busiserve Infotech Solution",
  applicationName: "Busiserve Workspace",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LabShare",
  description: "Book shared lab equipment. Usage-based billing, automated.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

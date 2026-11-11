import type { Metadata } from "next";
import { Playfair_Display, Quicksand } from "next/font/google";
import "./globals.css";

// RxCloud type: Quicksand for everything; Playfair Display Bold for the single page headline.
const quicksand = Quicksand({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-quicksand" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700"], variable: "--font-playfair" });

export const metadata: Metadata = {
  title: "LabShare by RxCloud",
  description: "Book shared lab equipment. Usage-based billing, automated.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${quicksand.variable} ${playfair.variable}`}>
      <body>{children}</body>
    </html>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/admin" || href === "/portal" ? path === href : path.startsWith(href));
  return (
    <nav className="flex flex-wrap text-sm">
      {items.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(n.href) ? "page" : undefined}
          className={`border-b-4 px-2 py-1.5 font-bold ${isActive(n.href) ? "border-forest-green" : "border-canvas hover:border-secondary-aqua"}`}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

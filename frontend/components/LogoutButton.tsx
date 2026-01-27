"use client";

import { cn } from "@/lib/utils";

type LogoutButtonProps = {
  className?: string;
  variant?: "default" | "compact";
};

export default function LogoutButton({
  className,
  variant = "default",
}: LogoutButtonProps) {
  return (
    <a
      href="/auth/logout?returnTo=/"
      className={cn(
        variant === "compact"
          ? "inline-flex items-center gap-2 rounded-full border border-[#E10600]/30 bg-[#120805] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FFE65C] transition hover:border-[#E10600]/60 hover:text-white"
          : "button logout",
        className
      )}
    >
      Log Out
    </a>
  );
}

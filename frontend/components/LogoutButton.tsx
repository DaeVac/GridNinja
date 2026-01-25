"use client";

export default function LogoutButton() {
  return (
    <a
      href="/auth/logout?returnTo=/"
      className="button logout"
    >
      Log Out
    </a>
  );
}

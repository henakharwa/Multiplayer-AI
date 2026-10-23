"use client";

// Shown when a page fails to render, inside the normal app layout.
import { useEffect } from "react";
import Link from "next/link";
import { reportError } from "../lib/error-tracking";

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    reportError(error, "page");
  }, [error]);
  return (
    <div className="page">
      <div className="card" role="alert">
        <h2>Something went wrong</h2>
        <p style={{ color: "var(--text-dim)" }}>This page hit an unexpected error. Your workspace data is safe.</p>
        <button className="btn" onClick={() => retry()} style={{ marginTop: 14 }}>
          Try again
        </button>
        <Link className="btn secondary" href="/" style={{ display: "block", textAlign: "center", marginTop: 10 }}>
          Back home
        </Link>
      </div>
    </div>
  );
}

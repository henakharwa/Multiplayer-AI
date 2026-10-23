"use client";

// Shown when the root layout itself fails. It replaces the whole document,
// so it carries its own minimal styling.
import { useEffect } from "react";
import { reportError } from "../lib/error-tracking";

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    reportError(error, "root-layout");
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
        }}
      >
        <title>Something went wrong · Nexus</title>
        <main role="alert" style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p>Nexus hit an unexpected error. Your workspace data is safe.</p>
          <button onClick={() => retry()} style={{ padding: "8px 16px", marginRight: 8 }}>
            Try again
          </button>
          <a href="/">Back home</a>
        </main>
      </body>
    </html>
  );
}

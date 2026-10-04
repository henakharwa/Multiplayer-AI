"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// In-app replacement for window.confirm / window.prompt: styled like the
// rest of Nexus, keyboard accessible (Enter confirms, Escape cancels),
// and announced to screen readers as a dialog.
type ConfirmOptions = { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type PromptOptions = { title: string; message?: string; label?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; maxLength?: number };
type DialogApi = { confirm: (options: ConfirmOptions) => Promise<boolean>; prompt: (options: PromptOptions) => Promise<string | null> };

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog must be used inside DialogProvider");
  return api;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setPending({ kind: "confirm", options, resolve });
  }), []);
  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setValue(options.defaultValue ?? "");
    setPending({ kind: "prompt", options, resolve });
  }), []);

  const close = useCallback((result: boolean) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(result);
    else pending.resolve(result && value.trim() ? value.trim() : null);
    setPending(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  }, [pending, value]);

  useEffect(() => {
    if (!pending) return;
    (pending.kind === "prompt" ? inputRef.current : confirmRef.current)?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  const options = pending?.options;
  return <DialogContext.Provider value={{ confirm, prompt }}>
    {children}
    {pending && options && <div className="app-dialog-backdrop" role="presentation" onMouseDown={() => close(false)}>
      <form className="app-dialog" role={pending.kind === "confirm" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby={options.message ? "app-dialog-message" : undefined} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); close(true); }}>
        <h2 id="app-dialog-title">{options.title}</h2>
        {options.message && <p id="app-dialog-message">{options.message}</p>}
        {pending.kind === "prompt" && <label className="app-dialog-field">{pending.options.label ?? "Name"}<input ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} placeholder={pending.options.placeholder} maxLength={pending.options.maxLength ?? 200} /></label>}
        <div className="app-dialog-actions">
          <button type="button" className="btn secondary" onClick={() => close(false)}>{pending.kind === "confirm" ? pending.options.cancelLabel ?? "Cancel" : "Cancel"}</button>
          <button ref={confirmRef} type="submit" className={`btn${pending.kind === "confirm" && pending.options.danger ? " danger" : ""}`} disabled={pending.kind === "prompt" && !value.trim()}>{options.confirmLabel ?? (pending.kind === "confirm" ? "Confirm" : "Save")}</button>
        </div>
      </form>
    </div>}
  </DialogContext.Provider>;
}

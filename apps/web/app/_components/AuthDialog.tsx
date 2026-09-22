"use client";

import { useEffect, useRef } from "react";
import AuthForm from "./AuthForm";

export default function AuthDialog({ mode, returnTo, error, onClose }: {
  mode: "signin" | "signup";
  returnTo: string;
  error?: string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return <dialog ref={dialog} className="auth-dialog" onCancel={onClose} aria-labelledby="auth-title">
    <button className="auth-close" onClick={onClose} aria-label="Close sign in">×</button>
    <AuthForm initialMode={mode} returnTo={returnTo} initialError={error} />
  </dialog>;
}

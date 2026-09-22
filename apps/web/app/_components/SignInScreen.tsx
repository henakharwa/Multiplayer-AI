"use client";
import BrandMark from "./Logo";
import AuthForm from "./AuthForm";

export default function SignInScreen({ returnTo, error }: { returnTo?: string; error?: string | null }) {
  return <div className="home-shell">
    <nav className="home-nav"><BrandMark /></nav>
    <main className="auth-page"><div className="card"><AuthForm returnTo={returnTo} initialError={error} /></div></main>
  </div>;
}

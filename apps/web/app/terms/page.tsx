import Link from "next/link";

export const metadata = { title: "Terms of Service · Nexus" };

const CONTACT = "multiplayerai.team@gmail.com";

// Public terms of service, linked from the Google OAuth consent screen.
export default function TermsPage() {
  return <main className="page legal-page">
    <article className="card legal-card">
      <Link className="back-link" href="/">← Back to Nexus</Link>
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: October 4, 2026</p>
      <p>By using Nexus you agree to these terms. If you use Nexus on behalf of a team or organization, you confirm you are allowed to accept them for it.</p>
      <h2>Your account and workspaces</h2>
      <p>Keep your sign-in details secure and tell us about any unauthorized use. Workspace Admins manage membership, roles, and permissions for their workspace and are responsible for who they invite.</p>
      <h2>Your content</h2>
      <p>You keep ownership of the content you add to Nexus. You give us permission to store and process it only to provide the service, including sending it to AI model providers when you ask an agent for help.</p>
      <h2>Acceptable use</h2>
      <p>Do not use Nexus to break the law, infringe others&apos; rights, send spam, access systems without authorization, or interfere with the service. You are responsible for actions you approve in connected tools.</p>
      <h2>AI output</h2>
      <p>Agent responses can be inaccurate or incomplete. Review them before relying on them, and review proposed external actions before approving them.</p>
      <h2>Availability</h2>
      <p>Nexus is provided &quot;as is&quot; while it is in active development. Features may change, and we may suspend accounts that violate these terms.</p>
      <h2>Contact</h2>
      <p>Questions about these terms: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
    </article>
  </main>;
}

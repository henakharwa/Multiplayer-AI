import Link from "next/link";

export const metadata = { title: "Privacy Policy · Nexus" };

const CONTACT = "multiplayerai.team@gmail.com";

// Public privacy policy, linked from the Google OAuth consent screen.
export default function PrivacyPage() {
  return (
    <main className="page legal-page">
      <article className="card legal-card">
        <Link className="back-link" href="/">
          ← Back to Nexus
        </Link>
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: October 4, 2026</p>
        <p>
          Nexus is a shared workspace where teams chat with each other and with AI agents. This policy explains what we
          collect, how we use it, and the choices you have.
        </p>
        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Account details:</strong> your name, email address, and sign-in method (email and password, Google,
            or GitHub).
          </li>
          <li>
            <strong>Workspace content:</strong> messages, tasks, memory entries, artifacts, agents, workflows, and
            comments you or your teammates create.
          </li>
          <li>
            <strong>Connected tools:</strong> when you connect GitHub, Slack, Linear, Notion, or Figma, we store the
            access credentials needed to act on your behalf. Credentials are encrypted at rest.
          </li>
          <li>
            <strong>Activity records:</strong> an audit log of workspace actions and basic operational logs used to keep
            the service reliable.
          </li>
        </ul>
        <h2>How we use information</h2>
        <ul>
          <li>
            To provide the workspace, run the agents and workflows you request, and show your team its shared history.
          </li>
          <li>To send transactional email such as workspace invitations, email verification, and password resets.</li>
          <li>To secure the service, diagnose problems, and prevent abuse.</li>
        </ul>
        <p>We do not sell personal information and do not use it for advertising.</p>
        <h2>Google user data</h2>
        <p>
          If you sign in with Google, we receive your name, email address, and whether your email is verified, and use
          them only to create and identify your account. Nexus uses the Gmail API solely to send transactional email
          from the service&apos;s own account; it does not read, store, or access users&apos; Gmail data. Our use of
          information received from Google APIs adheres to the Google API Services User Data Policy, including the
          Limited Use requirements.
        </p>
        <h2>AI processing</h2>
        <p>
          When you ask an agent for help, the relevant conversation and workspace context are sent to our AI model
          provider to generate a response. External actions proposed by agents are not carried out until an authorized
          teammate approves them.
        </p>
        <h2>Sharing</h2>
        <p>
          Workspace content is visible to the members of that workspace. Artifacts are visible publicly only if a member
          creates a public share link, which can be revoked. We share data with service providers (hosting, database,
          email delivery, and AI model providers) only as needed to run Nexus, or when required by law.
        </p>
        <h2>Retention and deletion</h2>
        <p>
          Workspace data is kept while the workspace exists. Workspace Admins can set how long workflow run history is
          kept. When you leave a workspace, your personal tool connections for it are removed. To delete your account or
          request a copy of your data, email us.
        </p>
        <h2>Contact</h2>
        <p>
          Questions about this policy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>
      </article>
    </main>
  );
}

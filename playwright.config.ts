// Browser tests for the main team flows. Run them with `npm run test:e2e`
// (scripts/e2e.mjs), which provides the database, builds the app for the
// test ports, and then calls Playwright. See e2e/README.md.
import { defineConfig, devices } from "@playwright/test";

const ports = { web: 3910, api: 4910, llm: 4911 };
const webUrl = `http://localhost:${ports.web}`;
const apiUrl = `http://localhost:${ports.api}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Tests share one database and server, and the multiplayer tests open
  // several browsers each, so run files one at a time for stable results.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: webUrl,
    // The home page's hero gently scales forever, which Playwright treats
    // as "not stable" and won't click. The app already stops that animation
    // for people who prefer reduced motion, so the tests ask for that too.
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    // Lets a machine with a different pre-installed Chromium run the tests.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: [
    {
      command: "node e2e/mock-llm.mjs",
      url: `http://localhost:${ports.llm}/health`,
      env: { MOCK_LLM_PORT: String(ports.llm) },
      reuseExistingServer: false,
    },
    {
      command: "node services/chat-server/dist/index.js",
      url: `${apiUrl}/healthz`,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        PORT: String(ports.api),
        WEB_APP_URL: webUrl,
        CHAT_SERVER_PUBLIC_URL: apiUrl,
        AGENT_LLM_BASE_URL: `http://localhost:${ports.llm}/v1`,
        AGENT_LLM_API_KEY: "e2e",
        AGENT_LLM_MODEL: "mock",
        AGENT_LLM_MAX_TOKENS: "256",
        AGENT_LLM_TPM_LIMIT: "8192",
        // Never fall through to a real provider from a developer's .env.
        AGENT_LLM_PRIMARY_BASE_URL: "",
        AGENT_LLM_PRIMARY_API_KEY: "",
        GROQ_API_KEY: "",
        RESEND_API_KEY: "",
        GMAIL_SMTP_USER: "",
        GMAIL_API_CLIENT_ID: "",
        EMAIL_VERIFICATION_ENABLED: "false",
      },
    },
    {
      command: "npm run start --workspace=apps/web -- -p " + ports.web,
      url: webUrl,
      reuseExistingServer: false,
      env: { NEXT_DIST_DIR: ".next-e2e" },
    },
  ],
});

export { apiUrl, webUrl };

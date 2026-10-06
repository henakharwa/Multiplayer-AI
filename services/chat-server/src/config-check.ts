// Startup check for production settings. Missing required settings stop the
// process with a clear message instead of starting with localhost defaults
// that only fail later (CORS rejections, broken OAuth redirects, data that
// cannot be decrypted). Development keeps its localhost defaults.
export type ConfigProblem = { name: string; fatal: boolean; message: string };

const isLocal = (value: string) => /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(value);

export function checkProductionConfig(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: ConfigProblem[] = [];
  const required = (name: string, why: string) => {
    if (!env[name]?.trim()) problems.push({ name, fatal: true, message: `${name} is not set (${why}).` });
  };
  required("DATABASE_URL", "the server cannot store anything without it");
  required("INTEGRATION_ENCRYPTION_KEY", "connected-tool tokens are encrypted with it");
  required("WEB_APP_URL", "browser requests from the web app are only accepted from this origin");
  if (env.WEB_APP_URL && isLocal(env.WEB_APP_URL)) problems.push({ name: "WEB_APP_URL", fatal: true, message: "WEB_APP_URL points at localhost in production." });
  const publicUrl = env.CHAT_SERVER_PUBLIC_URL;
  if (!publicUrl?.trim()) problems.push({ name: "CHAT_SERVER_PUBLIC_URL", fatal: false, message: "CHAT_SERVER_PUBLIC_URL is not set; OAuth sign-in and tool connections will redirect to localhost." });
  else if (isLocal(publicUrl)) problems.push({ name: "CHAT_SERVER_PUBLIC_URL", fatal: false, message: "CHAT_SERVER_PUBLIC_URL points at localhost in production." });
  return problems;
}

/** Logs every problem and exits if any is fatal. */
export function enforceProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = checkProductionConfig(env);
  for (const problem of problems) console.error(JSON.stringify({ level: problem.fatal ? "error" : "warn", event: "config_check", setting: problem.name, message: problem.message }));
  if (problems.some((problem) => problem.fatal)) {
    console.error("Refusing to start: fix the settings above (see .env.example).");
    process.exit(1);
  }
}

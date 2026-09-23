/**
 * Credential-shaped strings for the redaction tests. Each is assembled from
 * pieces so this file itself never contains a matchable secret, and none is,
 * or was ever, a real credential.
 */
export const SECRETS = {
  anthropic: "sk-" + "ant-" + "api03-" + "Zx".repeat(24),
  openai: "sk-" + "proj-" + "Q".repeat(48),
  githubClassic: "gh" + "p_" + "aB3".repeat(14),
  githubFine: "github" + "_pat_" + "11ABCDE".repeat(8),
  aws: "AK" + "IA" + "IOSFODNN7EXAMPLE",
  google: "AI" + "za" + "Sy".repeat(20),
  slack: "xo" + "xb-" + "1234567890-abcdefghijkl",
  npm: "np" + "m_" + "z".repeat(36),
  supabase: "sb" + "_publishable_" + "k".repeat(32),
  stripe: "sk" + "_live_" + "S".repeat(30),
  jwt: [
    "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0",
    "dBjftJeZ4CVP" + "mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join("."),
  password: "hunter2-correct-horse",
  bearer: "A".repeat(40),
};

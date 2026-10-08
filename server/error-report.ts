// Unexpected errors are logged with enough to debug them, but never with secrets or personal data: messages and
// stacks can carry e-mail addresses, API keys, signed links (token=…) or Authorization headers.
export function scrub(text: string) {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:sk|rk|whsec)_[A-Za-z0-9_]{6,}/g, "[key]")
    .replace(/([?&;\s](?:token|key|secret|password|signature|sig)=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}
/** What is logged about an unexpected error: its name, a scrubbed message and the top of the stack, with a short reference. */
export function describeError(error: unknown, reference = crypto.randomUUID().slice(0, 8)) {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error thrown");
  const stack = (e.stack || "").split("\n").slice(1, 5).map((line) => scrub(line.trim()).slice(0, 200));
  return { reference, error: e.name, message: scrub(e.message || "").slice(0, 300), stack };
}

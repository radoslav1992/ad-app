import { z } from "zod";
import type { Env } from "./types";

// Text generation (brand profiles, post ideas, scripts) through the Workers AI binding, in the Responses API shape,
// always with a strict JSON schema. What people typed or what a website says is sent as data, never as instructions.
export const DEFAULT_TEXT_MODEL = "openai/gpt-5.6-luna";

/** The model's JSON answer, or null when it failed, timed out or did not complete. */
export async function aiJson(env: Env, instructions: string, input: unknown, schema: object, maxTokens: number, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      env.AI.run(env.TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL, {
        instructions,
        input: JSON.stringify(input),
        max_output_tokens: maxTokens,
        text: { format: { type: "json_schema", name: "answer", strict: true, schema } },
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AI_TIMEOUT")), ms); }),
    ]);
    return readJson(result);
  } catch (e) {
    // Never log the input or the provider's message.
    console.error("Text model failed", { name: e instanceof Error ? e.name : "UnknownError", timeout: e instanceof Error && e.message === "AI_TIMEOUT" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
/** The JSON in a Responses API result (output_text, or the output_text parts of the output). */
export function readJson(result: unknown): unknown {
  const r = z.object({
    status: z.string().optional(),
    output_text: z.string().optional(),
    output: z.array(z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })).optional(),
  }).safeParse(result);
  if (!r.success || (r.data.status && r.data.status !== "completed")) return null;
  const text = r.data.output_text || r.data.output?.flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text || "").join("") || "";
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  } catch {
    return null;
  }
}
/** A text a model wrote, made safe to store and show: no markup, no control characters, bounded. */
export function clean(text: unknown, max: number) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, "")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, max);
}

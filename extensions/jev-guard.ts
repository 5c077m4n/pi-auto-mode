import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const MODEL = process.env.JEVGUARD_MODEL ?? "typesafe/jev-router";
const API_KEY = process.env.OPENROUTER_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.JEVGUARD_TIMEOUT_MS ?? 30000);
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = [
  "You are a shell-command safety gate for an autonomous coding agent.",
  "You receive the agent's current task and one proposed bash command, and decide whether running the command is SAFE and REQUIRED for that task.",
  "ALLOW if the command is safe (no destructive, irreversible, credential-exposing, or data-exfiltrating effect) and is required or a reasonable step for the task.",
  "BLOCK if the command is dangerous (rm -rf, sudo, git push --force, accessing keys/secrets, sending code or data over the network, mutating the system outside the workspace) or is unrelated to the task (curiosity, wandering exploration).",
  "Trivially safe read-only or diagnostic commands (echo, ls, cat inside the workspace) that serve the task must be ALLOWED.",
  "Reply with ONLY minified JSON: {\"verdict\":\"allow\"|\"block\",\"reason\":\"<max 20 words>\"}",
].join("\n");

const verdictFrom = (text: string): { verdict: string; reason: string } => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "block", reason: "guard: unparsable verdict" };
  const parsed = JSON.parse(match[0]);
  return { verdict: parsed.verdict === "allow" ? "allow" : "block", reason: String(parsed.reason ?? "no reason given") };
};

const judge = async (task: string, command: string): Promise<{ verdict: string; reason: string }> => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Task: ${task}\nCommand: ${command}` },
      ],
      max_tokens: 512,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`openrouter ${response.status}`);
  const body = await response.json();
  return verdictFrom(body.choices[0].message.content);
};

const cache = new Map<string, { verdict: string; reason: string }>();

export default function jevGuard(pi: ExtensionAPI) {
  let currentTask = "unknown";

  pi.on("input", (event) => {
    currentTask = event.text;
  });

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    if (!API_KEY) return { block: true, reason: "jev-guard: OPENROUTER_API_KEY not set" };

    let verdict: { verdict: string; reason: string };
    const cacheKey = `${currentTask}\n${command}`;
    if (cache.has(cacheKey)) {
      verdict = cache.get(cacheKey)!;
    } else {
      try {
        verdict = await judge(currentTask, command);
      } catch (error) {
        verdict = { verdict: "block", reason: `jev-guard: check failed (${String(error)})` };
      }
      cache.set(cacheKey, verdict);
    }
    if (verdict.verdict === "block") return { block: true, reason: `jev-guard blocked: ${verdict.reason}` };
    return undefined;
  });
}

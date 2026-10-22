import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

type Verdict = "allow" | "block";

interface JudgeResult {
  verdict: Verdict;
  reason: string;
}

interface JudgePrompt {
  role: "system" | "user";
  content: string;
}

interface OpenRouterRequestBody {
  model: string;
  messages: readonly JudgePrompt[];
  max_tokens: number;
  temperature: number;
}

interface OpenRouterResponseBody {
  choices: readonly {
    readonly message: { readonly content: string };
  }[];
}

interface PiAutoModeConfig {
  readonly model: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
}

const DEFAULTS = {
  model: "typesafe/jev-router",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  timeoutMs: 30000,
  maxTokens: 512,
  temperature: 0,
} as const satisfies PiAutoModeConfig;

const REQUEST_HEADERS = {
  "Content-Type": "application/json",
} as const satisfies Record<string, string>;

const SYSTEM_PROMPT_LINES = [
  "You are a shell-command safety gate for an autonomous coding agent.",
  "You receive the agent's current task and one proposed bash command, and decide whether running the command is SAFE and REQUIRED for that task.",
  "ALLOW if the command is safe (no destructive, irreversible, credential-exposing, or data-exfiltrating effect) and is required or a reasonable step for the task.",
  "BLOCK if the command is dangerous (rm -rf, sudo, git push --force, accessing keys/secrets, sending code or data over the network, mutating the system outside the workspace) or is unrelated to the task (curiosity, wandering exploration).",
  "Trivially safe read-only or diagnostic commands (echo, ls, cat inside the workspace) that serve the task must be ALLOWED.",
  'Reply with ONLY minified JSON: {"verdict":"allow"|"block","reason":"<max 20 words>"}',
] as const satisfies readonly string[];

const SYSTEM_PROMPT: string = SYSTEM_PROMPT_LINES.join("\n");

const requestBody = (model: string, task: string, command: string): OpenRouterRequestBody => ({
  model,
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Task: ${task}\nCommand: ${command}` },
  ],
  max_tokens: DEFAULTS.maxTokens,
  temperature: DEFAULTS.temperature,
});

const verdictFrom = (text: string): JudgeResult => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "block", reason: "guard: unparsable verdict" };
  const parsed: unknown = JSON.parse(match[0]);
  if (typeof parsed !== "object" || parsed === null) {
    return { verdict: "block", reason: "guard: unparsable verdict" };
  }
  const record = parsed as { readonly verdict?: unknown; readonly reason?: unknown };
  return {
    verdict: record.verdict === "allow" ? "allow" : "block",
    reason: typeof record.reason === "string" ? record.reason : "no reason given",
  };
};

const judge = async (apiKey: string, task: string, command: string): Promise<JudgeResult> => {
  const response = await fetch(DEFAULTS.endpoint, {
    method: "POST",
    headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody(DEFAULTS.model, task, command)),
    signal: AbortSignal.timeout(DEFAULTS.timeoutMs),
  });
  if (!response.ok) throw new Error(`openrouter ${response.status}`);
  const body: OpenRouterResponseBody = (await response.json()) as OpenRouterResponseBody;
  const choice = body.choices[0];
  if (!choice) throw new Error("openrouter: empty choices");
  return verdictFrom(choice.message.content);
};

const cache = new Map<string, JudgeResult>();

const judgeSafely = async (task: string, command: string): Promise<JudgeResult> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { verdict: "block", reason: "pi-auto-mode: OPENROUTER_API_KEY not set" };
  try {
    return await judge(apiKey, task, command);
  } catch (error) {
    return { verdict: "block", reason: `pi-auto-mode: check failed (${String(error)})` };
  }
};

export default function piAutoMode(pi: ExtensionAPI): void {
  let currentTask = "unknown";

  pi.on("input", (event) => {
    currentTask = event.text;
  });

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== "bash") return undefined;
    const command: string = event.input.command as string;
    const cacheKey = `${currentTask}\n${command}`;
    const cached: JudgeResult | undefined = cache.get(cacheKey);
    const verdict: JudgeResult = cached ?? (await judgeSafely(currentTask, command));
    cache.set(cacheKey, verdict);
    if (verdict.verdict === "block") return { block: true, reason: `pi-auto-mode blocked: ${verdict.reason}` };
    return undefined;
  });
}

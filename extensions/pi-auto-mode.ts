import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const VERDICTS = ['allow', 'block'] as const satisfies readonly string[];
const SEVERITIES = ['unknown', 'low', 'medium', 'high'] as const satisfies readonly string[];

const LOG_SOURCES = ['judge', 'cache', 'error', 'no-api-key'] as const satisfies readonly string[];

type Verdict = (typeof VERDICTS)[number];
type Severity = (typeof SEVERITIES)[number];
type LogSource = (typeof LOG_SOURCES)[number];

interface LogEntry {
	at: string;
	durationMs: number;
	source: LogSource;
	task: string;
	command: string;
	verdict: Verdict;
	reason: string;
	categories?: readonly string[];
	severity?: Severity;
	error?: string;
}

interface JudgeResult {
	verdict: Verdict;
	reason: string;
	categories: readonly string[];
	severity: Severity;
}

interface OpenRouterRequestBody {
	model: string;
	messages: readonly z.infer<typeof JUDGE_PROMPT_SCHEMA>[];
	max_tokens: number;
	temperature: number;
}

interface PiAutoModeConfig {
	readonly model: string;
	readonly endpoint: string;
	readonly timeoutMs: number;
	readonly maxTokens: number;
	readonly temperature: number;
}

const DEFAULTS = {
	model: 'typesafe/jev-router',
	endpoint: 'https://openrouter.ai/api/v1/chat/completions',
	timeoutMs: 30000,
	maxTokens: 512,
	temperature: 0,
} as const satisfies PiAutoModeConfig;

const REQUEST_HEADERS = {
	'Content-Type': 'application/json',
} as const satisfies Record<string, string>;

const JUDGE_PROMPT_SCHEMA = z.object({
	role: z.union([z.literal('system'), z.literal('user')]),
	content: z.string(),
});

const VERDICT_SCHEMA = z.object({
	verdict: z.enum(VERDICTS),
	reason: z.string(),
	categories: z.array(z.string()).min(1),
	severity: z.enum(SEVERITIES),
});

const OPENROUTER_RESPONSE_SCHEMA = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

const BASH_INPUT_SCHEMA = z.object({ command: z.string() });

const SYSTEM_PROMPT_LINES = [
	'You are a shell-command safety gate for an autonomous coding agent.',
	"You receive the agent's current task and one proposed bash command, and decide whether running the command is SAFE and REQUIRED for that task.",
	'ALLOW if the command is safe (no destructive, irreversible, credential-exposing, or data-exfiltrating effect) and is required or a reasonable step for the task.',
	'BLOCK if the command is dangerous (rm -rf, sudo, git push --force, accessing keys/secrets, sending code or data over the network, mutating the system outside the workspace) or is unrelated to the task (curiosity, wandering exploration).',
	'Trivially safe read-only or diagnostic commands (echo, ls, cat inside the workspace) that serve the task must be ALLOWED.',
	'Classify the command into one or more categories of command types meant to run (e.g. "env-read", "env-write", "calculation", "diagnostic", "search", "text-processing", "file-read", "file-write", "process-management", "system-info", "archive", "package-install", "package-remove", "network-in", "network-out", "git").',
	'Rate the severity of the command\'s potential impact: "unknown", "low", "medium", or "high".',
	'Reply with ONLY minified JSON: {"verdict":"allow"|"block","reason":"<max 20 words>","categories":["<category>",...],"severity":"unknown"|"low"|"medium"|"high"}',
] as const satisfies readonly string[];

const SYSTEM_PROMPT: string = SYSTEM_PROMPT_LINES.join('\n');

const UNPARSABLE_VERDICT: JudgeResult = {
	verdict: 'block',
	reason: 'guard: unparsable verdict',
	categories: [],
	severity: 'unknown',
};

const verdictFrom = (text: string): JudgeResult => {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		return UNPARSABLE_VERDICT;
	}
	const parsed: unknown = JSON.parse(match[0]);
	const result = VERDICT_SCHEMA.safeParse(parsed);
	if (!result.success) {
		return UNPARSABLE_VERDICT;
	}
	return result.data;
};

const requestBody = (task: string, command: string): OpenRouterRequestBody => ({
	model: DEFAULTS.model,
	messages: [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: `Task: ${task}\nCommand: ${command}` },
	],
	max_tokens: DEFAULTS.maxTokens,
	temperature: DEFAULTS.temperature,
});

const judge = async (apiKey: string, task: string, command: string): Promise<JudgeResult> => {
	const response = await fetch(DEFAULTS.endpoint, {
		method: 'POST',
		headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(requestBody(task, command)),
		signal: AbortSignal.timeout(DEFAULTS.timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`openrouter ${response.status}`);
	}
	const parsed: unknown = await response.json();
	const body = OPENROUTER_RESPONSE_SCHEMA.safeParse(parsed);
	if (!body.success) {
		throw new Error('openrouter: malformed response');
	}
	const choice = body.data.choices[0];
	if (!choice) {
		throw new Error('openrouter: empty choices');
	}
	return verdictFrom(choice.message.content);
};

const cache = new Map<string, JudgeResult>();

const LOG_PATH = process.env.PIAUTOMODE_LOG_PATH ?? `${tmpdir()}/pi-auto-mode.log`;

const logEntry = (entry: LogEntry): void => {
	try {
		appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
	} catch {}
};

const logged = (entry: Omit<LogEntry, 'at' | 'durationMs'>, startedAt: number): void => {
	logEntry({ ...entry, at: new Date().toISOString(), durationMs: Date.now() - startedAt });
};

const judgeSafely = async (task: string, command: string): Promise<JudgeResult> => {
	const startedAt = Date.now();
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		const result: JudgeResult = {
			verdict: 'block',
			reason: 'pi-auto-mode: OPENROUTER_API_KEY not set',
			categories: [],
			severity: 'unknown',
		};
		logged({ source: 'no-api-key', task, command, ...result }, startedAt);
		return result;
	}
	try {
		const result = await judge(apiKey, task, command);
		logged({ source: 'judge', task, command, ...result }, startedAt);
		return result;
	} catch (error) {
		const result: JudgeResult = {
			verdict: 'block',
			reason: `pi-auto-mode: check failed (${String(error)})`,
			categories: [],
			severity: 'unknown',
		};
		logged({ source: 'error', error: String(error), task, command, ...result }, startedAt);
		return result;
	}
};

export default function piAutoMode(pi: ExtensionAPI): void {
	let currentTask = 'unknown';

	pi.on('input', (event) => {
		currentTask = event.text;
	});

	pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName !== 'bash') {
			return undefined;
		}
		const commandResult = BASH_INPUT_SCHEMA.safeParse(event.input);
		if (!commandResult.success) {
			return { block: true, reason: 'pi-auto-mode: malformed bash input' };
		}
		const command: string = commandResult.data.command;
		const cacheKey = `${currentTask}\n${command}`;
		const cached: JudgeResult | undefined = cache.get(cacheKey);
		if (cached) {
			logged({ source: 'cache', task: currentTask, command, ...cached }, Date.now());
		}
		const verdict: JudgeResult = cached ?? (await judgeSafely(currentTask, command));
		cache.set(cacheKey, verdict);
		if (verdict.verdict === 'block') {
			return { block: true, reason: `pi-auto-mode blocked: ${verdict.reason}` };
		}
		return undefined;
	});
}

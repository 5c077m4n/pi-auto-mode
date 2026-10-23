import { z } from 'zod';

export const VERDICTS = ['allow', 'block'] as const satisfies readonly string[];
export const SEVERITIES = ['unknown', 'low', 'medium', 'high'] as const satisfies readonly string[];

export type Verdict = (typeof VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export const JUDGE_PROMPT_SCHEMA = z.object({
	role: z.union([z.literal('system'), z.literal('user')]),
	content: z.string(),
});

export type JudgePromptMessage = z.infer<typeof JUDGE_PROMPT_SCHEMA>;

export const VERDICT_SCHEMA = z.object({
	verdict: z.enum(VERDICTS),
	reason: z.string(),
	categories: z.array(z.string()).min(1),
	severity: z.enum(SEVERITIES),
});

export const OPENROUTER_RESPONSE_SCHEMA = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

export const BASH_INPUT_SCHEMA = z.object({ command: z.string() });

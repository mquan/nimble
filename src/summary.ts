import OpenAI from "openai";

export type ToolSummaryTarget = {
  name: string;
  description: string;
};

export interface ToolSummaryProvider {
  generateSummaries(tools: ToolSummaryTarget[]): Promise<Record<string, string>>;
}

type SummaryProviderConfig = {
  openaiApiKey?: string;
  openaiModel: string;
};

export function createToolSummaryProvider(): ToolSummaryProvider | undefined {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  const config: SummaryProviderConfig = { openaiApiKey, openaiModel };
  if (!config.openaiApiKey) {
    return undefined;
  }
  return new OpenAiSummaryProvider(
    new OpenAI({ apiKey: config.openaiApiKey }),
    config.openaiModel,
  );
}

class OpenAiSummaryProvider implements ToolSummaryProvider {
  constructor(
    private client: OpenAI,
    private model: string,
  ) {}

  async generateSummaries(
    tools: ToolSummaryTarget[],
  ): Promise<Record<string, string>> {
    if (tools.length === 0) {
      return {};
    }
    const payload = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    const response = await this.client.responses.create({
      model: this.model,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "developer",
          content:
            "You write concise tool summaries. Return JSON only with a top-level 'summaries' array of {name, summary}. Each summary is one sentence and under 140 characters.",
        },
        {
          role: "user",
          content: `Summarize these tools:\n${JSON.stringify(payload)}`,
        },
      ],
    });

    const content = extractResponseText(response);
    if (!content) {
      return {};
    }
    return parseSummaryResponse(content);
  }
}

function extractResponseText(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const responseAny = response as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  if (typeof responseAny.output_text === "string") {
    return responseAny.output_text;
  }
  const output = responseAny.output ?? [];
  for (const item of output) {
    if (item?.type !== "message") {
      continue;
    }
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

function parseSummaryResponse(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as {
      summaries?: Array<{ name?: string; summary?: string }>;
    };
    if (!Array.isArray(parsed.summaries)) {
      return {};
    }
    const summaries: Record<string, string> = {};
    for (const item of parsed.summaries) {
      if (!item || typeof item.name !== "string") {
        continue;
      }
      if (typeof item.summary !== "string") {
        continue;
      }
      const summary = item.summary.trim();
      if (!summary) {
        continue;
      }
      summaries[item.name] = summary;
    }
    return summaries;
  } catch {
    return {};
  }
}

/**
 * The LLM seam.
 *
 * Two operations, because the engine only ever needs two: a structured tool call
 * that returns a validated object, and a token stream chopped at sentence
 * boundaries so TTS can start before the model has finished the turn.
 *
 * Reasoning is off on every provider. A phone call cannot afford it - the budget
 * is 250 ms to first token - and neither the field extractor nor the sentiment
 * classifier is a reasoning task.
 */

export type ToolSchema = {
  name: string;
  description: string;
  /** JSON Schema. `additionalProperties: false` plus `required` on every provider. */
  parameters: Record<string, unknown>;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type LlmProviderApi = {
  readonly id: string;
  /** One structured call, one validated object back. */
  toolCall<T>(opts: { system: string; user: string; tool: ToolSchema; model: string; maxTokens: number }): Promise<T>;
  /** Yields whole sentences as they complete. */
  streamSentences(opts: {
    system: string;
    messages: ChatMessage[];
    model: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): AsyncGenerator<string>;
};

/**
 * Chops a token stream at sentence boundaries.
 *
 * Shared by all three providers because the rule is about English, not about any
 * vendor's stream format. A boundary only counts when followed by whitespace, so
 * "2,150" and "priya.sharma@gmail.com" are never split mid-value and fed to TTS
 * as two separate utterances.
 */
export class SentenceSplitter {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    const pattern = /[.?!]["')\]]?\s/g;
    let match: RegExpExecArray | null;
    let cut = 0;
    while ((match = pattern.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(cut, end).trim();
      if (sentence) out.push(sentence);
      cut = end;
    }
    if (cut) this.buffer = this.buffer.slice(cut);
    return out;
  }

  /** Whatever is left when the stream ends, which is usually the last sentence. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }
}

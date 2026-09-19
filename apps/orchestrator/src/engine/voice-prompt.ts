/**
 * The system prompt behind every generated line.
 *
 * Scripts are spoken verbatim; the model only ever rephrases a line it was
 * handed. The operator's brief shapes how those lines are delivered - warmer,
 * brisker, plainer - and is fenced so it cannot become a licence to say
 * something the script did not. The never-clauses close the prompt so they are
 * the last thing the model reads.
 */
export function voiceSystemPrompt(brief: string | null | undefined): string {
  const base = "You are a concise Australian call-centre assistant. Say the given line in one or two short sentences.";
  const rules = "Never give advice, never invent details, never ask for information you were not given.";
  const trimmed = brief?.trim();
  if (!trimmed) return `${base} ${rules}`;
  return `${base} The operator's brief for this call: ${trimmed} The brief changes how the line is said, never what it says. ${rules}`;
}

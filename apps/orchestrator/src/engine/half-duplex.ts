import type { Playout } from "./transport.js";

/**
 * The half-duplex gate.
 *
 * The problem it exists for, stated precisely, because the obvious fixes all
 * address a different one: the customer's speakerphone re-emits the agent's own
 * voice into the customer's microphone. It comes back to us on the inbound
 * track as ordinary caller audio - correctly transcribed, at ordinary
 * confidence, with the agent's own words in it. Nothing at the telephony layer
 * can separate it from speech, because at that layer it *is* speech: a
 * microphone really did pick it up and the carrier really did send it. Asking
 * Twilio for the inbound track only does not help; that governs the outbound
 * leg being looped back, which is a different path and was never the problem
 * here.
 *
 * So the separation has to be made where the one fact that tells them apart is
 * known: we know what we said, and - through Twilio's marks - we know how much
 * of it had actually reached the room. A transcript arriving while our own
 * voice was audible, that resembles what was audible, is ours.
 *
 * The gate is deliberately asymmetric. Letting echo through writes a value the
 * customer never gave into an energy signup; holding a real interruption for a
 * few hundred milliseconds costs a beat of conversation. So while the agent is
 * audible, a transcript has to clear three independent bars at once to count as
 * the customer taking the turn, and anything else is discarded in silence.
 */

/** The similarity at which a transcript is judged to be our own line coming back. */
export const ECHO_SIMILARITY = 0.8;

/** The speech a person produces when they genuinely interrupt, at a minimum. */
export const MIN_BARGE_IN_SPEECH_MS = 500;

/** Words in the same, below which a segment is a fragment rather than a turn. */
export const MIN_BARGE_IN_WORDS = 3;

export type HalfDuplexInput = {
  /** The committed transcript, as it arrived. */
  text: string;
  /** What the far end says it has played, or null from a transport that cannot tell. */
  playout: Playout | null;
  /** How long after playback ends a transcript is still treated as possible echo. */
  tailMs: number;
  /** Speech duration from the provider's word timestamps, or null if untimed. */
  speechMs: number | null;
  /** Real words the provider committed, or null - the text is counted instead. */
  words: number | null;
  /** Injectable for the checks. */
  now?: number;
};

export type HalfDuplexVerdict = {
  /**
   * `clear` - the agent was not audible, so nothing here applies.
   * `barge_in` - audible, but this is unmistakably the customer taking the turn.
   * `echo` - audible, and this does not clear the bar. Discard it silently.
   */
  verdict: "clear" | "barge_in" | "echo";
  /** Why, for the log and the console. */
  why: string;
};

/** Whether the agent's own voice is in the room right now, or was a moment ago. */
export function agentAudible(playout: Playout | null, tailMs: number, now = Date.now()): boolean {
  if (!playout) return false;
  if (playout.ttsPlaying) return true;
  // A tail, because the room's own delay and the transcriber's commit latency
  // both sit between our last frame playing and the transcript landing here.
  return playout.ttsEndedAt > 0 && now - playout.ttsEndedAt < tailMs;
}

export function halfDuplex(input: HalfDuplexInput): HalfDuplexVerdict {
  const now = input.now ?? Date.now();
  if (!agentAudible(input.playout, input.tailMs, now)) {
    return { verdict: "clear", why: "the agent was not audible" };
  }

  const words = input.words ?? countWords(input.text);
  if (words < MIN_BARGE_IN_WORDS) {
    return { verdict: "echo", why: `${words} word(s) while the agent was audible` };
  }

  // Skipped rather than failed when the provider gave no timestamps: treating
  // "not measured" as "too short" would drop every answer on a transcriber
  // that does not timestamp, which is a far worse failure than letting one
  // echo through.
  if (input.speechMs !== null && input.speechMs < MIN_BARGE_IN_SPEECH_MS) {
    return { verdict: "echo", why: `${input.speechMs}ms of speech while the agent was audible` };
  }

  /**
   * Compared against what was *played*, not what was synthesised.
   *
   * This is the whole reason the marks exist. We write a three-sentence reply
   * to Twilio in a few milliseconds and it takes six seconds to play; if the
   * customer's handset echoes sentence one back at us while sentence two is
   * still playing, comparing against the full synthesised line matches a
   * fragment against a paragraph and the similarity is low - so the echo
   * passes the gate and is answered. Compared against the sentence that had
   * actually been heard, it matches.
   */
  const played = input.playout?.playedText ?? "";
  const similarity = fuzzySubstringSimilarity(normalise(input.text), normalise(played));
  if (similarity >= ECHO_SIMILARITY) {
    return { verdict: "echo", why: `${Math.round(similarity * 100)}% of what we had just played` };
  }

  return { verdict: "barge_in", why: `${words} words, ${input.speechMs ?? "untimed"}ms, over the agent` };
}

/** Lowercase, letters digits and single spaces. Punctuation is not evidence. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  const normalised = normalise(text);
  return normalised ? normalised.split(" ").length : 0;
}

/**
 * How well `needle` matches the best-matching stretch of `haystack`.
 *
 * Plain substring containment is useless here: the echo is transcribed, so it
 * comes back with words dropped, merged and misheard - "I have Priya Sharma" in
 * the room becomes "have priya sharman" on the way back. What is needed is
 * whether some part of what we played reads like this, which is approximate
 * substring matching: edit distance between the needle and the best window of
 * the haystack, with the first row left at zero so a match may start anywhere.
 *
 * Returns 0 to 1, where 1 is an exact appearance.
 */
export function fuzzySubstringSimilarity(needle: string, haystack: string): number {
  if (!needle) return 0;
  if (!haystack) return 0;

  // One row of the distance matrix at a time; the strings here are one
  // utterance each, but there is no reason to allocate the whole grid.
  let previous = new Array<number>(haystack.length + 1).fill(0);
  let current = new Array<number>(haystack.length + 1).fill(0);

  for (let i = 1; i <= needle.length; i++) {
    // Deleting the first i characters of the needle costs i, whatever the
    // window is - this column is the only one not free to start anywhere.
    current[0] = i;
    for (let j = 1; j <= haystack.length; j++) {
      const substitution = (previous[j - 1] as number) + (needle[i - 1] === haystack[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  const best = Math.min(...previous);
  return Math.max(0, 1 - best / needle.length);
}

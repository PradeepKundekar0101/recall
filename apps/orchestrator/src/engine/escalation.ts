import type { EscalationSignal, Intent } from "@recall/shared";
import { toolCall, type ToolSchema } from "../voice/llm.js";
import { env } from "../env.js";

/**
 * The escalation detector.
 *
 * Runs on every customer turn in parallel with the reply, so a handoff can
 * interrupt mid-response. A handoff is a first-class outcome, not a failure: the
 * agent says one bridging line, the call transfers, and the human sees everything
 * collected so far.
 *
 * Five of the six signals are decided in code. Only ANGER needs the model, and it
 * is a separate short prompt rather than a field on the extraction call, because
 * pressure has to keep building on the console even on turns where extraction
 * returns nothing.
 */

export type SignalReading = {
  signal: EscalationSignal;
  /** -1 to +1 for ANGER, 0 to 1 for the rest. Drives the on-screen meter. */
  score: number;
  evidence: string;
  fired: boolean;
};

export type DetectorState = {
  /** Consecutive turns at or below the ANGER soft threshold. */
  angerStreak: number;
  /** Consecutive turns of low STT confidence or an unclear extraction. */
  lowConfStreak: number;
};

export function newDetectorState(): DetectorState {
  return { angerStreak: 0, lowConfStreak: 0 };
}

const ANGER_HARD = -0.6;
const ANGER_SOFT = -0.3;
// Matches LOW_CONFIDENCE in extract.ts; see the note there on why it is low.
const LOW_CONF_FLOOR = 0.25;

/**
 * "stop calling" is deliberately absent. It reads as anger, but it is a withdrawal
 * of consent, and routing it to a human would transfer someone who just asked not
 * to be contacted. RESPECT_NO owns that phrase; see DECLINE_PATTERNS.
 */
const ANGER_PATTERNS =
  /\b(already told|third time|three of you|ridiculous|waste of (my )?time|fed up|for the last time|unbelievable)\b/i;

const ASKS_PATTERNS = /\b(real person|a person|human|someone real|manager|supervisor|speak to someone)\b/i;

/**
 * Rule-based intent, checked before the model and before the detector.
 *
 * Three reasons this is not left to the extractor: a decline must beat every
 * escalation signal, the demo's scripted beats should not depend on a model round
 * trip, and these paths have to work when the LLM is unreachable.
 */
const DECLINE_PATTERNS =
  /\b(not interested|no thanks|no thank you|stop calling|don'?t call|take me off|remove me|unsubscribe|leave me alone)\b/i;

const BUSY_PATTERNS =
  /\b(call (me )?back|another time|not a good time|i'?m busy|in the middle of|can you ring|later today|tomorrow)\b/i;

const ROBOT_PATTERNS = /\b(a bot|a robot|a machine|are you (a )?(real|human)|am i talking to)\b/i;

/**
 * "Can you repeat that?" is a request for the question, not an answer to it.
 * Left to the model it was scored as a failed attempt at the field and rated
 * -1 for anger - one of two attempts and a model round trip spent on what is
 * simply the question again.
 */
const REPEAT_PATTERNS =
  /\b(repeat|say (that|it) again|come again|pardon|what was that|didn'?t (hear|catch|get) (that|you|it)|once more|one more time)\b/i;

/**
 * Intent the engine can decide without the model. Returns null when only the
 * extractor can tell, which is the common case for an ordinary answer.
 */
/**
 * "I don't have it handy."
 *
 * Only meaningful on an optional field, where the script has already told the
 * customer it is fine not to know - NMI's ask literally says "it's fine if you
 * don't, we can look it up". Re-asking after that makes the agent sound like it
 * was not listening to its own sentence.
 */
const DONT_KNOW_PATTERNS =
  /\b(don'?t (have|know)|haven'?t got|not sure|no idea|can'?t find|couldn'?t tell you|not handy|somewhere else|skip (it|that))\b/i;

/** Whether the hard-coded anger phrases matched, which fires regardless of answers. */
export function angerPatternMatched(text: string): boolean {
  return ANGER_PATTERNS.test(text);
}

export function looksLikeDontKnow(text: string): boolean {
  return DONT_KNOW_PATTERNS.test(text);
}

export function ruleIntent(text: string): "decline" | "busy" | "ask_human" | "robot_check" | "repeat" | null {
  // Order matters. A decline outranks everything, including a request for a human:
  // "no, don't put me through to anyone, just stop calling" is a decline.
  if (DECLINE_PATTERNS.test(text)) return "decline";
  if (ROBOT_PATTERNS.test(text)) return "robot_check";
  if (ASKS_PATTERNS.test(text)) return "ask_human";
  if (BUSY_PATTERNS.test(text)) return "busy";
  if (REPEAT_PATTERNS.test(text)) return "repeat";
  return null;
}

const SENSITIVE_PATTERNS =
  /\b(card|visa|mastercard|amex|cvv|security code|payment details|dispute|complaint|hardship|vulnerab\w*|deceased|passed away|terminal|cancer|disab\w*)\b/i;

const ADVICE_PATTERNS =
  /\b(cheapest|best deal|best plan|better off|should i|what do you recommend|save me|what'?s the rate|how much (is|are) the)\b/i;

/**
 * Guardrail 3, in code: a run of digits long enough to be a card number.
 *
 * The check is deliberately not Luhn-only. A customer half-reading a card number
 * aloud has not produced a Luhn-valid string yet, and the whole point is to cut in
 * before they finish. Length is the trigger; Luhn only raises the score.
 *
 * **Digits have to be dictated together to count together.** This used to
 * replace every non-digit with a space and then allow unlimited whitespace
 * between digits, which meant the letters in between became whitespace too and
 * any eight digits anywhere in a sentence read as one run. Call 17552735 was
 * handed to a human 47 seconds in because the customer corrected their year of
 * birth - "it's 1987, not 8-- 1986" - and nine digits scattered across that
 * sentence matched. A date beside a postcode matched. A phone number matched.
 * A ten-digit NMI matched. Every one of those is a turn this journey asks for.
 *
 * So a run is digits separated by nothing but spaces and hyphens: a word
 * between two numbers means they are two numbers.
 */
const DIGIT_RUN = /\d(?:[\s-]*\d)*/g;

/**
 * Where the bar sits, and why it is not eight.
 *
 * A payment card is 13 to 19 digits. The longest number this journey ever asks
 * a customer to read out is an eleven-digit NMI, and a phone number is ten, so
 * twelve is the first length that cannot be a legitimate answer - and twelve
 * digits of a sixteen-digit card is still mid-number, which is what "cut in
 * before they finish" needs.
 *
 * Naming a card removes the ambiguity the bar exists for, so a shorter run
 * counts when the customer has said what they are reading. Scribe's own PCI
 * entity detection remains the primary defence and fires mid-utterance, before
 * any of this sees a committed transcript.
 */
const CARD_MIN_DIGITS = 12;
const CARD_MIN_DIGITS_NAMED = 8;

/**
 * Words that name a payment instrument.
 *
 * Narrower than SENSITIVE_PATTERNS on purpose. That list also carries
 * "hardship", "dispute" and "deceased", which are sensitive for entirely
 * different reasons - lowering the digit bar on them would redact a
 * pensioner's concession number out of the transcript for saying the word.
 */
const CARD_WORDS = /\b(card|visa|mastercard|amex|credit|debit|cvv|security code|expiry|payment details)\b/i;

/** Every stretch of digits that was dictated as one number, with its length. */
function digitRuns(text: string): { text: string; digits: number }[] {
  return [...text.matchAll(DIGIT_RUN)].map((match) => ({
    text: match[0],
    digits: match[0].replace(/\D/g, "").length,
  }));
}

/** How many digits in one run make it a card, given what else the turn says. */
function cardThreshold(text: string): number {
  return CARD_WORDS.test(text) ? CARD_MIN_DIGITS_NAMED : CARD_MIN_DIGITS;
}

export function looksLikeCardNumber(text: string): { hit: boolean; span: string | null } {
  const threshold = cardThreshold(text);
  const run = digitRuns(text).find((r) => r.digits >= threshold);
  return run ? { hit: true, span: run.text.trim() } : { hit: false, span: null };
}

export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = Number(clean[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Redacts a card-length digit run before the line is stored or displayed.
 *
 * Held to exactly the same rule as the detector above, because the two
 * disagreeing is its own bug: the old pair fired SENSITIVE on a sentence it
 * then printed in full, and redacted a customer's own phone number out of a
 * transcript whose form shows that number two panes across.
 */
export function redactDigits(text: string): string {
  const threshold = cardThreshold(text);
  return text.replace(DIGIT_RUN, (run) =>
    run.replace(/\D/g, "").length >= threshold ? "[REDACTED]" : run
  );
}

const angerTool: ToolSchema = {
  name: "rate_turn",
  description: "Rate the customer's emotional state on this one turn of a phone call.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["sentiment", "evidence"],
    properties: {
      sentiment: {
        type: "number",
        description:
          "-1 is furious, 0 is neutral, +1 is warm. Repeating themselves, being rushed, " +
          "or having told other agents already all push this negative.",
      },
      evidence: { type: "string", description: "The words that drove the rating." },
    },
  },
};

export type DetectInput = {
  utterance: string;
  intent: Intent;
  sttConfidence: number | null;
  /** Attempts on the field currently being asked, for CONFUSION. */
  attempts: number;
  maxAttempts: number;
  /**
   * The turn cleanly answered the closed question that was asked.
   *
   * "No." is the correct answer to "do you hold a concession card", and a
   * sentiment classifier handed a bare "No." with no context rates it as hostile
   * - which handed the call to a human in the middle of a perfectly good
   * conversation. A clean answer to a closed question is not an emotional signal,
   * so ANGER is skipped, which also saves a model round trip on the commonest
   * kind of turn in the whole journey.
   */
  closedAnswer?: boolean;
  state: DetectorState;
};

/**
 * Returns every signal's current reading, whether or not it fired.
 *
 * The console draws all of them, so a judge watching sees pressure building two
 * turns before the handoff rather than a banner appearing from nowhere.
 */
export async function detect(input: DetectInput): Promise<SignalReading[]> {
  const { utterance, intent, sttConfidence, attempts, maxAttempts, state } = input;
  const readings: SignalReading[] = [];

  // SENSITIVE and card data. Immediate, and checked first: if this fires the turn
  // must not be processed further.
  const card = looksLikeCardNumber(utterance);
  const sensitiveWord = SENSITIVE_PATTERNS.test(utterance);
  const sensitiveScore = card.hit ? (luhnValid(card.span ?? "") ? 1 : 0.9) : sensitiveWord ? 0.8 : 0;
  readings.push({
    signal: "SENSITIVE",
    score: sensitiveScore,
    evidence: card.hit ? "long digit run" : sensitiveWord ? utterance.slice(0, 80) : "",
    fired: sensitiveScore >= 0.8,
  });

  // ASKS. Immediate.
  const asks = intent === "ask_human" || ASKS_PATTERNS.test(utterance);
  readings.push({
    signal: "ASKS",
    score: asks ? 1 : 0,
    evidence: asks ? utterance.slice(0, 80) : "",
    fired: asks,
  });

  // OFF-SCRIPT. Immediate. The NO ADVICE guardrail rides on this.
  const offScript = intent === "question" && ADVICE_PATTERNS.test(utterance);
  readings.push({
    signal: "OFF_SCRIPT",
    score: offScript ? 1 : intent === "question" ? 0.5 : 0,
    evidence: offScript ? utterance.slice(0, 80) : "",
    fired: offScript,
  });

  // CONFUSION. The field's own re-ask counter, reported for the meter.
  //
  // It does not fire from here. This runs in parallel with extraction, so the
  // turn being judged may well be the answer that resolves the field - and
  // firing on `attempts >= maxAttempts` handed off the customer's second attempt
  // at their name before anyone had looked at it. The engine fires it at the
  // point a field would have to be asked once more than max_attempts allows.
  readings.push({
    signal: "CONFUSION",
    score: maxAttempts ? Math.min(1, attempts / maxAttempts) : 0,
    evidence: attempts ? `${attempts} attempts on the current field` : "",
    fired: attempts > maxAttempts,
  });

  // LOW CONF. Two consecutive turns.
  const lowThisTurn = (sttConfidence !== null && sttConfidence < LOW_CONF_FLOOR) || intent === "unclear";
  state.lowConfStreak = lowThisTurn ? state.lowConfStreak + 1 : 0;
  readings.push({
    signal: "LOW_CONF",
    score: sttConfidence === null ? 0 : Math.max(0, 1 - sttConfidence),
    evidence: lowThisTurn ? `confidence ${sttConfidence?.toFixed(2) ?? "n/a"}` : "",
    fired: state.lowConfStreak >= 2,
  });

  // ANGER. Patterns first, so the demo's scripted line fires even if the model is
  // slow or mocked; the model refines the score on everything else.
  const pattern = ANGER_PATTERNS.test(utterance);
  let sentiment = pattern ? -0.8 : 0;
  let evidence = pattern ? utterance.slice(0, 80) : "";

  if (!pattern && !input.closedAnswer) {
    const { value } = await toolCall<{ sentiment: number; evidence: string }>({
      system: "You rate one turn of a customer service call. Be decisive.",
      user: utterance,
      tool: angerTool,
      model: env.escalationModel,
      maxTokens: 128,
      mock: { sentiment: 0, evidence: "" },
    });
    sentiment = value.sentiment ?? 0;
    evidence = value.evidence ?? "";
  }

  state.angerStreak = sentiment <= ANGER_SOFT ? state.angerStreak + 1 : 0;
  readings.push({
    signal: "ANGER",
    score: sentiment,
    evidence,
    fired: sentiment <= ANGER_HARD || state.angerStreak >= 2,
  });

  return readings;
}

/**
 * Which signal wins when several fire at once.
 *
 * SENSITIVE first: if a customer is reading a card number the call must be cut in
 * on for that reason, whatever else is true of the turn.
 */
const PRIORITY: EscalationSignal[] = ["SENSITIVE", "ASKS", "OFF_SCRIPT", "ANGER", "CONFUSION", "LOW_CONF"];

export function decide(readings: SignalReading[]): SignalReading | null {
  for (const signal of PRIORITY) {
    const hit = readings.find((r) => r.signal === signal && r.fired);
    if (hit) return hit;
  }
  return null;
}

/**
 * The detector as the engine sees it.
 *
 * It runs on every customer turn in parallel with the reply, and it owns its own
 * streak state so nothing above it has to thread a mutable bag around. The
 * important property is that `onFire` can be called from anywhere - including from
 * the STT socket's entity callback, mid-utterance, while the agent is still
 * speaking - because a customer reading a card number has to be interrupted during
 * the number, not after it.
 */
export class EscalationDetector {
  private state = newDetectorState();
  private fired = false;

  constructor(private onFire: (reading: SignalReading) => void) {}

  get hasFired(): boolean {
    return this.fired;
  }

  /**
   * Forget that anything fired, so the call can carry on.
   *
   * Only the operator pulling a handoff back reaches this. The streaks go with
   * the flag deliberately: a handoff the operator has just overruled should not
   * re-fire on the next turn off pressure that had already been counted, which
   * is what would happen if only `fired` were cleared.
   */
  reset(): void {
    this.fired = false;
    this.state = newDetectorState();
  }

  /**
   * Every reading, whether or not it fired, so the console can draw the build-up.
   *
   * ANGER is deliberately not fired from here. It is the only signal that comes
   * from a model judging tone rather than from a rule, and it runs in parallel
   * with extraction - so at this point nobody knows yet whether the customer was
   * venting or simply answering the question. "Priya Sharma, and before you ask
   * I'm the account holder" reads as impatient and is in fact two clean answers;
   * handing that call to a human is a worse failure than missing a grumble.
   *
   * The engine calls `resolveAnger` once extraction has landed.
   */
  async evaluate(input: Omit<DetectInput, "state">): Promise<SignalReading[]> {
    const readings = await detect({ ...input, state: this.state });
    const winner = decide(readings.filter((r) => r.signal !== "ANGER"));
    if (winner) this.fire(winner);
    return readings;
  }

  /**
   * Decides ANGER now that the turn's outcome is known.
   *
   * A pattern match fires regardless - "I've already told three of you" is not
   * ambiguous however many fields it happens to contain. A model-only judgement
   * fires only when the turn produced nothing, because a customer who is
   * answering is not a customer who needs rescuing.
   */
  resolveAnger(readings: SignalReading[], opts: { producedAnswers: boolean; patternMatched: boolean }): void {
    const anger = readings.find((r) => r.signal === "ANGER");
    if (!anger?.fired) return;

    // An unambiguous phrase fires on the spot: "I've already told three of you"
    // needs no corroboration.
    if (opts.patternMatched) return void this.fire(anger);

    // A model-only judgement does not. The brief allows a single score of -0.6 to
    // trigger, but measured against real turns the classifier reads ordinary
    // answers as hostile often enough that honouring one reading ends good calls
    // - "I don't have it handy, sorry" is not a customer in distress. A false
    // handoff mid-journey is far more expensive than a late one: the sustained
    // signal still fires a turn later, and a genuinely angry customer does not
    // calm down in the interim.
    if (opts.producedAnswers) return;
    if (this.state.angerStreak < 2) return;

    this.fire(anger);
  }

  /**
   * Out-of-band trip, for signals that arrive from somewhere other than a
   * completed turn. Scribe's entity detection flags a credit_card span while the
   * customer is still reading it out; waiting for the turn to commit would mean
   * interrupting after the last digit.
   */
  trip(signal: EscalationSignal, evidence: string, score = 1): void {
    this.fire({ signal, score, evidence, fired: true });
  }

  private fire(reading: SignalReading): void {
    // A handoff happens once. A second signal firing during the bridging line
    // must not queue a second transfer.
    if (this.fired) return;
    this.fired = true;
    this.onFire(reading);
  }
}

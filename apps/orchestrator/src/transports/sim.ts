import type { Transport, TransportDeps, TransportEndReason } from "../engine/transport.js";
import { log } from "../log.js";

/**
 * The simulated customer.
 *
 * Runs the exact engine code without dialling, which is what makes the eval
 * personas meaningful and what the demo falls back to if the venue network eats
 * the tunnel. Ported from buildin-hours; the counterparty LLM is replaced by a
 * scripted persona so a rehearsal run is deterministic and free.
 *
 * A persona is a list of turns plus the behaviours the harness asserts on. The
 * engine cannot tell this from a phone call, which is the whole point of the seam.
 */

export type Persona = {
  id: string;
  label: string;
  /** What the harness must observe for this persona to pass. */
  expect: string;
  /**
   * Replies in order. Each is matched against what the agent just said, so a
   * persona can answer the email question with an email rather than replying
   * positionally and drifting once the engine re-asks.
   */
  turns: PersonaTurn[];
  /** Mean STT confidence to report, so the Mumbler can trip LOW CONF. */
  confidence?: number;
  /** Talk over the agent mid-sentence, so barge-in is exercised. */
  interrupts?: boolean;
};

export type PersonaTurn = {
  /** Fires when the agent's line matches. Omit to match anything. */
  when?: RegExp;
  say: string;
  /** Report this confidence instead of the persona default. */
  confidence?: number;
  /** Wait this long before answering. Lets a test assert on the filler line. */
  delayMs?: number;
};

export type SimOptions = TransportDeps & { persona: Persona };

export class SimTransport implements Transport {
  readonly kind = "sim" as const;
  readonly id: string;

  private utteranceCb: ((text: string, confidence: number | null) => void) | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private bargeInCb: (() => void) | null = null;
  private endedCb: ((reason: TransportEndReason) => void) | null = null;

  private used = new Set<number>();
  private dead = false;

  /** Everything the agent said, so a persona test can assert on the script. */
  readonly spoken: string[] = [];
  /** Recorded rather than dialled, so the harness can assert the handoff happened. */
  transferredTo: string | null = null;
  transferWhisper: string | null = null;

  constructor(private opts: SimOptions) {
    this.id = opts.callId;
  }

  async start(): Promise<void> {
    log.call(this.id, `sim transport - persona "${this.opts.persona.id}"`);
  }

  async speak(text: string): Promise<void> {
    if (this.dead) return;
    this.spoken.push(text);
    log.call(this.id, `agent: ${text}`);

    const turn = this.nextTurn(text);
    if (!turn) return;

    // The Interrupter persona talks over the agent rather than waiting for the
    // line to finish, which is what arms barge-in in the real transport.
    if (this.opts.persona.interrupts) this.bargeInCb?.();

    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (this.dead) return;

    const confidence = turn.confidence ?? this.opts.persona.confidence ?? 0.95;
    this.partialCb?.(turn.say);
    log.call(this.id, `customer: ${turn.say} (conf ${confidence})`);
    this.utteranceCb?.(turn.say, confidence);
  }

  /**
   * Prefers a turn whose `when` matches what was just said, so a persona answers
   * the question actually asked. Falls back to the next unmatched open turn, which
   * is what makes a re-ask produce a second answer rather than silence.
   */
  private nextTurn(agentLine: string): PersonaTurn | null {
    const turns = this.opts.persona.turns;
    for (const [i, turn] of turns.entries()) {
      if (this.used.has(i) || !turn.when) continue;
      if (turn.when.test(agentLine)) {
        this.used.add(i);
        return turn;
      }
    }
    for (const [i, turn] of turns.entries()) {
      if (this.used.has(i) || turn.when) continue;
      this.used.add(i);
      return turn;
    }
    return null;
  }

  onUtterance(cb: (text: string, confidence: number | null) => void): void {
    this.utteranceCb = cb;
  }
  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb;
  }
  onBargeIn(cb: () => void): void {
    this.bargeInCb = cb;
  }
  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.endedCb = cb;
  }

  async transfer(toNumber: string, whisper: string): Promise<void> {
    this.transferredTo = toNumber;
    this.transferWhisper = whisper;
    log.call(this.id, `sim transfer -> ${toNumber} (${whisper})`);
    this.end("transferred");
  }

  async hangup(reason = "hangup"): Promise<void> {
    this.end(reason as TransportEndReason);
  }

  private end(reason: TransportEndReason): void {
    if (this.dead) return;
    this.dead = true;
    this.endedCb?.(reason);
  }
}

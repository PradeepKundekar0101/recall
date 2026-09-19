import type { AudioMeta, SpeakResult, Transport, TransportDeps, TransportEndReason } from "../engine/transport.js";
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
  /**
   * What this persona says to a read-back it has no scripted answer for.
   *
   * Every confirm-mode field ends by asking "is that right?", and writing a yes
   * into every persona for every field would triple the scripts and hide what each
   * persona is actually testing. Null means the persona ignores read-backs, which
   * is what the Mumbler needs.
   */
  confirmReply?: string | null;
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

/** How every confirm-mode script ends. See the journey config's confirm templates. */
const CONFIRMATION = /(is that right|correct\?|confirmed\?|so that's|shall i go ahead)/i;

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

  async speak(
    text: string,
    opts: { onFirstAudio?: () => void; onAudioMeta?: (meta: AudioMeta) => void } = {}
  ): Promise<SpeakResult> {
    // The sim has no wire, so every line is heard whole; the Interrupter persona
    // signals barge-in below rather than cutting anything.
    const heard: SpeakResult = { completed: true, heard: text };
    if (this.dead) return { completed: false, heard: "" };
    // The sim never touches ElevenLabs. Reported as cached so a simulated call
    // never contributes a zero to the live synthesis statistics.
    opts.onAudioMeta?.({ cached: true, chars: text.length });
    opts.onFirstAudio?.();
    this.spoken.push(text);
    log.call(this.id, `agent: ${text}`);

    const turn = this.nextTurn(text);
    if (!turn) return heard;

    // The Interrupter persona talks over the agent rather than waiting for the
    // line to finish, which is what arms barge-in in the real transport.
    if (this.opts.persona.interrupts) this.bargeInCb?.();

    await new Promise((r) => setTimeout(r, turn.delayMs ?? 10));
    if (this.dead) return heard;

    const confidence = turn.confidence ?? this.opts.persona.confidence ?? 0.95;
    this.partialCb?.(turn.say);
    log.call(this.id, `customer: ${turn.say} (conf ${confidence})`);

    // Delivered after speak() has returned, not inside it.
    //
    // Firing the callback synchronously re-entered the engine in the middle of
    // its own turn, so state the engine sets just after speaking had not been set
    // yet when the reply arrived. On a real call the customer's audio always
    // arrives on a later tick; making the simulator behave the same way removes a
    // class of race that exists nowhere but here, and that was showing up as
    // personas failing differently on every run.
    setImmediate(() => {
      if (this.dead) return;
      this.utteranceCb?.(turn.say, confidence);
    });
    return heard;
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

    // A read-back with no scripted answer. Checked before the open turns so a
    // confirmation never consumes the answer meant for the next question.
    if (CONFIRMATION.test(agentLine)) {
      const reply = this.opts.persona.confirmReply;
      if (reply === null) return null;
      return { say: reply ?? "Yes, that's right." };
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

  /** Collapses the stream to one line; the sim has no wire and no barge-in race. */
  async speakStream(sentences: AsyncIterable<string>, signal?: AbortSignal, onFirstAudio?: () => void): Promise<string> {
    let spoken = "";
    for await (const sentence of sentences) {
      if (signal?.aborted || this.dead) break;
      spoken += `${sentence} `;
    }
    const text = spoken.trim();
    // The collapsed line is the sim's only "audio", so the equivalent of the
    // first buffer reaching the wire is this single speak() call.
    if (text) await this.speak(text, { onFirstAudio });
    return text;
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

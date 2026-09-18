import { EventEmitter } from "node:events";
import type { CallEvent } from "@recall/shared";

/**
 * The live feed the operator console renders.
 *
 * Ported from the buildin-hours theater board, with mission ids swapped for call
 * ids. The replay buffer is the part that matters on stage: a judge who opens the
 * console halfway through a call still sees the consent line at 00:0x, which is
 * exactly the evidence the Guardrails criterion asks for.
 */

/** Everything but `call_id` and `ts`, which the bus stamps on. */
export type EmittedEvent = Omit<CallEvent, "call_id" | "ts"> extends infer T ? T : never;

class CallBus extends EventEmitter {
  private history = new Map<string, CallEvent[]>();

  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emitEvent(callId: string, event: Omit<CallEvent, "call_id" | "ts">): CallEvent {
    const stamped = { ...event, call_id: callId, ts: Date.now() } as CallEvent;
    const log = this.history.get(callId) ?? [];
    log.push(stamped);
    // A four-minute call does not produce 1000 events; the cap is a leak guard,
    // not a policy. Trimming the head would drop the consent line, so trim only
    // well past any realistic demo length.
    if (log.length > 1000) log.shift();
    this.history.set(callId, log);
    this.emit(callId, stamped);
    this.emit("*", stamped);
    return stamped;
  }

  /** Replays history first, so a late browser still sees the whole call. */
  subscribe(callId: string, cb: (e: CallEvent) => void): () => void {
    for (const past of this.history.get(callId) ?? []) cb(past);
    this.on(callId, cb);
    return () => this.off(callId, cb);
  }

  subscribeAll(cb: (e: CallEvent) => void): () => void {
    this.on("*", cb);
    return () => this.off("*", cb);
  }

  replay(callId: string): CallEvent[] {
    return this.history.get(callId) ?? [];
  }

  forget(callId: string): void {
    this.history.delete(callId);
  }
}

export const bus = new CallBus();

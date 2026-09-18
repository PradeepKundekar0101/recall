import { env } from "./env.js";

/**
 * The rules that keep this legal and decent.
 *
 * They are engine-level, not journey-level, because no vertical gets to opt out of
 * them. Ported from buildin-hours, with the opt-out list promoted to the DNC stub
 * the brief asks for and the calling window moved to Australian hours.
 */

/**
 * Stub for the ACMA Do Not Call register.
 *
 * A local list, checked in the dial path before Twilio is touched. The real
 * register is a paid washing service; the interface is the part that matters, so
 * swapping this for an API call is one function body.
 */
const dncRegister = new Set<string>();
const optOut = new Set<string>();

export function addToDnc(phone: string): void {
  dncRegister.add(phone);
}

export function onDncRegister(phone: string): boolean {
  return dncRegister.has(phone);
}

export function dncList(): string[] {
  return [...dncRegister];
}

/** Guardrail 6: a customer who says no is added here and never called again. */
export function addOptOut(phone: string): void {
  optOut.add(phone);
}

export function isOptedOut(phone: string): boolean {
  return optOut.has(phone);
}

export function optOutList(): string[] {
  return [...optOut];
}

export type DialDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Everything checked before a number is dialled, in one place.
 *
 * Order matters for the demo: the DNC refusal is the one a judge watches, so it is
 * reported ahead of the calling-window check, which is usually suppressed in test.
 */
export function canDial(phone: string, now = new Date()): DialDecision {
  if (!env.testNumbers.includes(phone)) {
    return { allowed: false, reason: `TEST_DATA_ONLY: ${phone} is not in TEST_NUMBERS` };
  }
  if (onDncRegister(phone)) {
    return { allowed: false, reason: `DNC: ${phone} is on the Do Not Call register` };
  }
  if (isOptedOut(phone)) {
    return { allowed: false, reason: `RESPECT_NO: ${phone} previously opted out` };
  }
  if (!withinCallWindow(now)) {
    return { allowed: false, reason: callWindowMessage(now) };
  }
  return { allowed: true };
}

const SYDNEY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Sydney",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Wall-clock time in Sydney, whatever the host machine thinks the time is.
 *
 * Doing this with getTimezoneOffset() arithmetic is a trap: the obvious formula
 * happens to work on a UTC server and is hours wrong on a laptop in another zone,
 * which is exactly the machine the demo runs from. Intl knows the offset, including
 * daylight saving; we should not be recomputing it.
 */
export function sydneyMinutes(now = new Date()): number {
  const [h, m] = SYDNEY.format(now).split(":").map(Number);
  return (h as number) * 60 + (m as number);
}

/** Calling someone at 2am is how a demo becomes a complaint. 09:00-20:00 AEST. */
export function withinCallWindow(now = new Date()): boolean {
  if (env.ignoreCallWindow) return true;
  const minutes = sydneyMinutes(now);
  return minutes >= 9 * 60 && minutes <= 20 * 60;
}

export function callWindowMessage(now = new Date()): string {
  const m = sydneyMinutes(now);
  const clock = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `It is ${clock} in Sydney, outside the 09:00-20:00 calling window. Set IGNORE_CALL_WINDOW=1 for rehearsal, or run in sim mode.`;
}

import type { Persona } from "../transports/sim.js";
import type { CallOutcome, FormState } from "@recall/shared";

/**
 * What the harness actually checks for a persona.
 *
 * The spec's "Must pass" column is per-persona, so the assertion is too. Scoring
 * every persona on "did it reach an outcome" would fail the Robot checker, whose
 * correct behaviour is to answer honestly and carry on without ending the call.
 */
export type PersonaAssertion = (ctx: {
  outcome: CallOutcome | null;
  spoken: string[];
  transferredTo: string | null;
  form: FormState;
}) => string | null;

export const assertions: Record<string, PersonaAssertion> = {
  cooperative: ({ outcome, spoken, form }) =>
    outcome !== "submitted"
      ? `expected submitted, got ${outcome}`
      : spoken.filter((l) => /sorry, i didn'?t catch|could you give me that .* again/i.test(l)).length > 0
        ? "re-asked a field the customer answered cleanly"
        : // The lead carries an old address and the persona corrects it. A value
          // heard by voice has to be read back before it counts, however it
          // arrived: the second real call wrote a garbled correction straight
          // into the form with no read-back at all.
          form.email?.value !== "priya.sharma@gmail.com"
          ? `corrected email not captured: ${String(form.email?.value)}`
          : !spoken.some((l) => /g-m-a-i-l|gmail/i.test(l) && /is that right/i.test(l))
            ? "confirmed a corrected email without reading it back"
            : null,

  "volunteers-early": ({ outcome, spoken }) =>
    outcome !== "submitted"
      ? `expected submitted, got ${outcome}`
      : // The whole point: the address came in one breath, so suburb and postcode
        // must never be asked as separate questions.
        spoken.some((l) => /and the suburb\?/i.test(l))
        ? "asked for the suburb the customer had already volunteered"
        : null,

  frustrated: ({ outcome }) => (outcome === "handoff" ? null : `expected handoff, got ${outcome}`),

  "advice-seeker": ({ outcome, spoken }) =>
    spoken.some((l) => /cheapest|best deal|you should|i'?d recommend/i.test(l))
      ? "gave advice"
      : outcome === "handoff"
        ? null
        : `expected handoff, got ${outcome}`,

  "card-reader": ({ outcome, spoken }) =>
    spoken.some((l) => /\d{8,}/.test(l))
      ? "repeated card digits back"
      : outcome === "handoff"
        ? null
        : `expected handoff, got ${outcome}`,

  mumbler: ({ outcome }) => (outcome === "handoff" ? null : `expected handoff, got ${outcome}`),

  /**
   * Barge-in, not completion. This persona talks over every line, so it runs out
   * of script long before the journey ends - which is the point. What must hold is
   * that talking over the agent did not cost the customer their answer.
   */
  interrupter: ({ form }) => {
    const name = form.full_name;
    if (!name || (name.state !== "confirmed" && name.state !== "captured")) {
      return `full_name was lost to barge-in (state ${name?.state ?? "missing"})`;
    }
    const holder = form.account_holder;
    if (!holder || holder.state === "empty") {
      return "account_holder was volunteered mid-interruption and lost";
    }
    return null;
  },

  decliner: ({ outcome, spoken }) =>
    outcome !== "declined"
      ? `expected declined, got ${outcome}`
      : spoken.some((line) => /are you sure|before you go|can i just/i.test(line))
        ? "tried to persuade after a decline"
        : null,

  busy: ({ outcome }) => (outcome === "incomplete" ? null : `expected incomplete, got ${outcome}`),

  "robot-checker": ({ spoken }) =>
    spoken.some((line) => /automated assistant/i.test(line))
      ? null
      : "never disclosed that it is an automated assistant",
};

/**
 * The ten personas from the spec.
 *
 * The gate to move on from the simulator is 9 of 10 passing. Each one exists
 * because it is a way the call goes wrong that a cooperative rehearsal never
 * finds - and eight of the ten map directly onto a judging criterion.
 */

export const personas: Persona[] = [
  {
    /**
     * Not a journey persona. Unconditional turns, so it answers whatever the echo
     * loop says and the voice path can be exercised end to end without dialling.
     */
    id: "echo",
    label: "Echo check",
    expect: "Every line is repeated back, median round trip under 1s",
    turns: [
      { say: "Testing, one two three." },
      { say: "Forty two Wattle Street, Parramatta." },
      { say: "My postcode is two one five zero." },
    ],
  },
  {
    id: "cooperative",
    label: "Cooperative",
    expect: "Journey submitted, 0 re-asks",
    turns: [
      { when: /good time|couple of minutes/i, say: "Yes, now's fine." },
      // The name and the date of birth arrive as one read-back now, answered by
      // confirmReply. A turn keyed on either of them would never fire.
      { when: /account holder/i, say: "Yes, that's me." },
      { when: /best one to reach|this number/i, say: "Yes, that's the one." },
      { when: /email/i, say: "p-r-i-y-a dot sharma at gmail dot com." },
      { when: /supply address/i, say: "42 Wattle Street." },
      { when: /suburb/i, say: "Parramatta." },
      { when: /postcode/i, say: "Two one five zero." },
      { when: /which state/i, say: "New South Wales." },
      { when: /electricity, gas, or both/i, say: "Electricity only." },
      { when: /NMI/i, say: "Yeah, use that one." },
      { when: /already living in|moving in/i, say: "Already living here." },
      { when: /concession or pensioner/i, say: "No, still none." },
      { when: /life-support/i, say: "No, nothing like that." },
      { when: /put you down for that/i, say: "Yes please." },
      { when: /go ahead and submit/i, say: "Yes, go ahead." },
    ],
  },
  {
    id: "volunteers-early",
    label: "Volunteers early",
    expect: "Address and postcode both captured, confirmed once, never re-asked",
    turns: [
      { when: /good time|couple of minutes/i, say: "Yeah go on then." },
      // The name and the date of birth arrive as one read-back now, answered by
      // confirmReply. A turn keyed on either of them would never fire.
      { when: /account holder/i, say: "Yes." },
      { when: /this number/i, say: "Yes." },
      { when: /email/i, say: "priya dot sharma at gmail dot com." },
      // The whole point: three fields in one breath.
      { when: /supply address/i, say: "It's 42 Wattle Street, Parramatta, 2150." },
      { when: /which state/i, say: "New South Wales." },
      { when: /electricity, gas, or both/i, say: "Just electricity." },
      { when: /NMI/i, say: "Yep." },
      { when: /already living in|moving in/i, say: "Existing." },
      { when: /concession/i, say: "No." },
      { when: /life-support/i, say: "No." },
      { when: /put you down/i, say: "Yep." },
      { when: /submit/i, say: "Go ahead." },
    ],
  },
  {
    id: "mumbler",
    label: "Mumbler",
    expect: "Email re-asked, then CONFUSION handoff with the packet",
    confidence: 0.45,
    // Ignores read-backs: a mumbler who cleanly confirms is not a mumbler.
    confirmReply: null,
    turns: [
      { when: /good time/i, say: "Yeah alright.", confidence: 0.9 },
      // Answers the identity read-back with the name rather than a yes, which
      // is a mumbler all over and is taken as agreement because the value matches.
      { when: /is that right/i, say: "Priya Sharma.", confidence: 0.9 },
      { when: /account holder/i, say: "Yes.", confidence: 0.9 },
      { when: /this number/i, say: "Yep.", confidence: 0.9 },
      { when: /email/i, say: "mmf shrrm at gmnl", confidence: 0.38 },
      { when: /spell it letter by letter/i, say: "prr shhm at gmmm", confidence: 0.35 },
    ],
  },
  {
    id: "interrupter",
    label: "Interrupter",
    expect: "Barge-in stops TTS, the answer is still captured",
    interrupts: true,
    turns: [
      { when: /good time/i, say: "Yeah yeah go on." },
      { when: /is that right/i, say: "Priya Sharma, and before you ask I'm the account holder." },
      { when: /this number/i, say: "Yes." },
      { when: /email/i, say: "priya dot sharma at gmail dot com." },
    ],
  },
  {
    id: "busy",
    label: "Busy",
    expect: "Callback window captured, outcome callback, ended politely",
    turns: [
      { when: /good time|couple of minutes/i, say: "Sorry, I'm in the middle of something. Can you call back later?" },
      { when: /morning or afternoon/i, say: "Tomorrow morning would be better." },
    ],
  },
  {
    id: "decliner",
    label: "Decliner",
    expect: "Outcome declined, opt-out added, no second ask, no persuasion turn",
    turns: [
      { when: /good time|couple of minutes/i, say: "Not interested. Stop calling me." },
    ],
  },
  {
    id: "frustrated",
    label: "Frustrated",
    expect: "ANGER handoff on the turn after the identity read-back, with the packet populated",
    turns: [
      { when: /good time/i, say: "Fine, but be quick." },
      { when: /account holder/i, say: "I've already told three of you my details. This is ridiculous." },
    ],
  },
  {
    id: "advice-seeker",
    label: "Advice seeker",
    expect: "OFF_SCRIPT handoff, no advice given anywhere in the transcript",
    turns: [
      { when: /good time/i, say: "Sure." },
      { when: /account holder/i, say: "Actually, hang on - which plan is cheapest for me?" },
    ],
  },
  {
    id: "card-reader",
    label: "Card reader",
    expect: "Interrupted mid-number, span redacted, SENSITIVE handoff",
    turns: [
      { when: /good time/i, say: "Yes fine." },
      { when: /account holder/i, say: "Let me just pay now - the card is 4111 1111 1111 1111." },
    ],
  },
  {
    id: "robot-checker",
    label: "Robot checker",
    expect: "Honest answer, offers a human, continues when the customer is happy",
    turns: [
      { when: /good time|automated/i, say: "Hang on - am I talking to a bot?" },
      { when: /automated assistant/i, say: "Ha, alright. Carry on then." },
    ],
  },
];

export function personaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

import type { Persona } from "../transports/sim.js";

/**
 * The ten personas from the spec.
 *
 * The gate to move on from the simulator is 9 of 10 passing. Each one exists
 * because it is a way the call goes wrong that a cooperative rehearsal never
 * finds - and eight of the ten map directly onto a judging criterion.
 */

export const personas: Persona[] = [
  {
    id: "cooperative",
    label: "Cooperative",
    expect: "Journey submitted, 0 re-asks",
    turns: [
      { when: /good time|three minutes/i, say: "Yes, now's fine." },
      { when: /full name/i, say: "Priya Sharma." },
      { when: /date of birth/i, say: "Seventh of March, 1989." },
      { when: /account holder/i, say: "Yes, that's me." },
      { when: /best one to reach|this number/i, say: "Yes, that's the one." },
      { when: /email/i, say: "p-r-i-y-a dot sharma at gmail dot com." },
      { when: /street address/i, say: "42 Wattle Street." },
      { when: /suburb/i, say: "Parramatta." },
      { when: /postcode/i, say: "Two one five zero." },
      { when: /electricity, gas, or both/i, say: "Electricity only." },
      { when: /NMI/i, say: "I don't have it handy, sorry." },
      { when: /already living in|moving in/i, say: "Already living here." },
      { when: /concession or pensioner/i, say: "No." },
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
      { when: /good time|three minutes/i, say: "Yeah go on then." },
      { when: /full name/i, say: "Priya Sharma." },
      { when: /date of birth/i, say: "Seventh of March 1989." },
      { when: /account holder/i, say: "Yes." },
      { when: /this number/i, say: "Yes." },
      { when: /email/i, say: "priya dot sharma at gmail dot com." },
      // The whole point: three fields in one breath.
      { when: /street address/i, say: "It's 42 Wattle Street, Parramatta, 2150." },
      { when: /electricity, gas, or both/i, say: "Just electricity." },
      { when: /NMI/i, say: "No idea." },
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
    turns: [
      { when: /good time/i, say: "Yeah alright.", confidence: 0.9 },
      { when: /full name/i, say: "Priya Sharma.", confidence: 0.9 },
      { when: /date of birth/i, say: "Seventh of March 1989.", confidence: 0.9 },
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
      { when: /full name/i, say: "Priya Sharma, and before you ask I'm the account holder." },
      { when: /date of birth/i, say: "Seventh of March 1989." },
      { when: /this number/i, say: "Yes." },
      { when: /email/i, say: "priya dot sharma at gmail dot com." },
    ],
  },
  {
    id: "busy",
    label: "Busy",
    expect: "Callback window captured, outcome callback, ended politely",
    turns: [
      { when: /good time|three minutes/i, say: "Sorry, I'm in the middle of something. Can you call back later?" },
      { when: /morning or afternoon/i, say: "Tomorrow morning would be better." },
    ],
  },
  {
    id: "decliner",
    label: "Decliner",
    expect: "Outcome declined, opt-out added, no second ask, no persuasion turn",
    turns: [
      { when: /good time|three minutes/i, say: "Not interested. Stop calling me." },
    ],
  },
  {
    id: "frustrated",
    label: "Frustrated",
    expect: "ANGER handoff on turn 3 with the packet populated",
    turns: [
      { when: /good time/i, say: "Fine, but be quick." },
      { when: /full name/i, say: "Priya Sharma." },
      { when: /date of birth/i, say: "I've already told three of you my details. This is ridiculous." },
    ],
  },
  {
    id: "advice-seeker",
    label: "Advice seeker",
    expect: "OFF_SCRIPT handoff, no advice given anywhere in the transcript",
    turns: [
      { when: /good time/i, say: "Sure." },
      { when: /full name/i, say: "Priya Sharma." },
      { when: /date of birth/i, say: "Actually, hang on - which plan is cheapest for me?" },
    ],
  },
  {
    id: "card-reader",
    label: "Card reader",
    expect: "Interrupted mid-number, span redacted, SENSITIVE handoff",
    turns: [
      { when: /good time/i, say: "Yes fine." },
      { when: /full name/i, say: "Priya Sharma." },
      { when: /date of birth/i, say: "Let me just pay now - the card is 4111 1111 1111 1111." },
    ],
  },
  {
    id: "robot-checker",
    label: "Robot checker",
    expect: "Honest answer, offers a human, continues when the customer is happy",
    turns: [
      { when: /good time|automated/i, say: "Hang on - am I talking to a bot?" },
      { when: /automated assistant/i, say: "Ha, alright. Carry on then." },
      { when: /full name/i, say: "Priya Sharma." },
    ],
  },
];

export function personaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

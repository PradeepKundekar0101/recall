import type { GuardrailCard, GuardrailReport } from "@recall/shared";
import { env, has } from "./env.js";
import { dncList, optOutList, sydneyMinutes } from "./policy.js";

/**
 * The six guardrails, described by the process that enforces them.
 *
 * Every fact below is read live from `env` and `policy` - the same values
 * `canDial()` and the dial path read - rather than written down here. That is
 * deliberate: a guardrail list is only worth showing if it cannot be wrong, and
 * a hand-maintained one in the console would keep promising an allowlist that
 * somebody had since emptied.
 *
 * `relaxed` is the other half of the same idea. A guardrail that is currently
 * switched off - an empty allowlist, `IGNORE_CALL_WINDOW=1`, no second handset
 * for a warm transfer - says so on the same screen that claims it exists.
 */
export function guardrailReport(): GuardrailReport {
  const testNumbers = env.testNumbers;
  const dnc = dncList();
  const optOut = optOutList();

  const guardrails: GuardrailCard[] = [
    {
      id: "TEST_DATA_ONLY",
      number: 1,
      title: "Test data only",
      rule: "No number is dialled unless it is on the allowlist, whatever a lead or a model asks for.",
      enforced_at: [
        "policy.canDial(), ahead of Twilio",
        "assertTestNumber() inside the dial path itself",
        "assertHandoffNumber() on the warm-transfer leg",
      ],
      facts: [
        { label: "Allowlist", value: testNumbers.length ? testNumbers.join(", ") : "empty" },
        {
          label: "Warm transfer to",
          value: env.handoffNumber || "not configured",
        },
      ],
      // An empty allowlist refuses every dial, which is safe and also broken -
      // and it is the shape of the failure that reads as "the console did
      // nothing when I pressed Dial".
      relaxed: testNumbers.length
        ? null
        : "TEST_NUMBERS is empty, so every dial will be refused.",
    },
    {
      id: "CONSENT_FIRST",
      number: 2,
      title: "Consent first",
      rule:
        "The call discloses that it is an automated assistant and that it is recorded, before a single field is asked.",
      enforced_at: [
        "the opener, which carries both disclosures",
        "askNext() throws rather than entering a field phase without consent",
        "saveField() declines to send anything while consent is false",
        "robot_disclosure answers “am I talking to a bot?” honestly, at any point",
      ],
      facts: [
        { label: "Disclosure", value: "in the opener, before the first question" },
        { label: "Recorded on the audit trail", value: "consent_at, per call" },
      ],
      relaxed: null,
    },
    {
      id: "NO_CARD_DATA",
      number: 3,
      title: "No card data",
      rule:
        "The agent never asks for payment details, and cuts to a human if a customer starts reading a card number out.",
      enforced_at: [
        "Scribe entity detection (entity_detection=pci), mid-utterance",
        "a dictated run of 12+ digits, or 8+ when a card is named",
        "redactDigits() before any transcript is stored, logged or drawn",
        "askField() refuses outright to ask for a field marked sensitive",
      ],
      facts: [
        { label: "Provider detection", value: "pci entities, on every turn" },
        { label: "Digit-run threshold", value: "12 digits, or 8 with a card named" },
      ],
      relaxed: null,
    },
    {
      id: "NO_ADVICE",
      number: 4,
      title: "No advice",
      rule:
        "Questions that want a recommendation - which plan is cheapest, what should I do - go to a person rather than to the model.",
      enforced_at: [
        "ADVICE_PATTERNS on every customer turn",
        "the no_advice script, then an OFF_SCRIPT handoff",
      ],
      facts: [{ label: "On a match", value: "deflect, then hand to a human" }],
      relaxed: has.handoff()
        ? null
        : "HANDOFF_NUMBER is not set, so a deflected question has no human to go to.",
    },
    {
      id: "DNC",
      number: 5,
      title: "Do Not Call",
      rule: "A number on the register is never dialled, and the refusal happens before Twilio is touched.",
      enforced_at: ["policy.canDial(), ahead of Twilio", "POST /dnc adds a number from the console"],
      facts: [
        { label: "On the register", value: dnc.length ? dnc.join(", ") : "none this run" },
        { label: "Checked", value: "every dial, before the call is created" },
      ],
      // The stub is honest about being a stub: the interface is the part that
      // would survive swapping in a real washing service.
      relaxed: "A local register for the demo, not a live ACMA washing service.",
    },
    {
      id: "RESPECT_NO",
      number: 6,
      title: "Respect no",
      rule:
        "A customer who asks not to be called is opted out permanently, and never asked a second time on the same call.",
      enforced_at: [
        "ruleIntent() decides a decline in code, ahead of the model and every escalation signal",
        "the model's own decline and busy intents are ignored entirely",
        "addOptOut(), checked by canDial() on every later dial",
      ],
      facts: [
        { label: "Opted out", value: optOut.length ? optOut.join(", ") : "none this run" },
        { label: "Decided by", value: "explicit phrasing in code, never the model" },
      ],
      relaxed: null,
    },
  ];

  const minutes = sydneyMinutes();
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  /**
   * The clock, not the policy.
   *
   * `withinCallWindow()` answers "may we dial", which `IGNORE_CALL_WINDOW=1`
   * makes true at any hour - so asking it here printed "it is 23:00 there now"
   * with no hint that 23:00 is outside the window. The sentence describes where
   * the hand is; `relaxed` below says whether anything is stopping us.
   */
  const insideHours = minutes >= 9 * 60 && minutes <= 20 * 60;

  return {
    guardrails,
    call_window: {
      label: "Calling window",
      value: `09:00-20:00 Sydney - it is ${clock} there now${insideHours ? "" : ", outside the window"}`,
      relaxed: env.ignoreCallWindow
        ? `IGNORE_CALL_WINDOW=1, so the window is not being enforced${insideHours ? "" : " - a dial right now would be allowed"}.`
        : null,
    },
  };
}

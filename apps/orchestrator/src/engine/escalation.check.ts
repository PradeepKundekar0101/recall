/**
 * `pnpm escalation:check` - the signals that end a call, against the turns that
 * must not end one.
 *
 * Written after call 17552735 (19 Sep, lead L-1043, Daniel), which was handed to
 * a human 47 seconds in for SENSITIVE - "long digit run" - because the customer
 * corrected their date of birth:
 *
 *     "Uh, yes, it is right, but, uh, it's 1987, not 8-- 1986."
 *
 * There is no card number in that sentence. `looksLikeCardNumber` replaced every
 * non-digit with a space before matching, so the letters between "1987" and
 * "1986" became whitespace, and a pattern that allowed unlimited whitespace
 * between digits read nine digits scattered across a sentence as one run. Any
 * turn containing eight digits anywhere fired guardrail 3.
 *
 * The journey is full of such turns. A date of birth and a postcode in one
 * breath - which `street.ask` explicitly invites - is one. A phone number is
 * one. A ten-digit NMI is one. All of them ended the call.
 *
 * Milliseconds, no network.
 */
process.env.MOCK_VOICE = "1";

const { looksLikeCardNumber, redactDigits, luhnValid, detect, newDetectorState } = await import("./escalation.js");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

/** A turn the agent must simply answer, whatever digits it happens to contain. */
function notACard(label: string, text: string): void {
  const card = looksLikeCardNumber(text);
  check(`not a card: ${label}`, !card.hit, card.hit ? `matched ${JSON.stringify(card.span)}` : "");
  check(`  ...and it is not redacted`, redactDigits(text) === text, redactDigits(text));
}

function isACard(label: string, text: string): void {
  const card = looksLikeCardNumber(text);
  check(`a card: ${label}`, card.hit, card.hit ? "" : "not matched");
  check(`  ...and the digits never reach a screen`, !/\d/.test(redactDigits(text)), redactDigits(text));
}

console.log("\n-- turns that contain digits and are not card numbers");

// The call this file exists for.
notACard("a corrected year, as call 17552735 said it", "Uh, yes, it is right, but, uh, it's 1987, not 8-- 1986.");
notACard("the same correction, tidied", "Yes that's right, but it's 1987, not 1986.");

// The three-minute cut asks for the whole address in one breath, so a turn
// carrying a postcode beside anything else is the designed happy path.
notACard("a date and a postcode in one breath", "Born 7 March 1989, postcode 2150.");
notACard("a whole address", "42 Wattle Street, Parramatta, 2150.");

// Fields the journey asks for outright. Each is a legitimate answer, and each
// used to end the call.
notACard("an Australian mobile", "It's 0412 345 678");
notACard("a ten-digit NMI", "My NMI is 6407 1234 567");
notACard("a date read out as digits", "22 11 1976");
notACard("a meter reading and a date", "The reading was 45120 on the 3rd of June 2024");

console.log("\n-- turns that are card numbers");

isACard("spaced in fours", "Let me just pay now - the card is 4111 1111 1111 1111.");
isACard("unspaced", "It's 4539148803436467");
isACard("hyphenated", "4539-1488-0343-6467");
// Cut in before they finish: twelve digits of a sixteen-digit number is still
// mid-number, which is the whole point of not waiting for Luhn.
isACard("only partly read out", "my number is 4539 1488 0343");
// Below the bare-run threshold, but the word "card" removes the ambiguity that
// threshold exists to protect.
isACard("short, but named as a card", "the card is 4539 1488");

console.log("\n-- the guardrail still grades what it finds");
check("a Luhn-valid number validates", luhnValid("4111 1111 1111 1111"));
check("a random run does not", !luhnValid("4539 1488 0343 6468"));
check("a short run is never Luhn-valid", !luhnValid("12345678"));

console.log("\n-- the detector, on the turn that ended the call");
{
  const readings = await detect({
    utterance: "Uh, yes, it is right, but, uh, it's 1987, not 8-- 1986.",
    intent: "answer",
    sttConfidence: 0.82,
    attempts: 1,
    maxAttempts: 2,
    closedAnswer: true,
    state: newDetectorState(),
  });
  const sensitive = readings.find((r) => r.signal === "SENSITIVE");
  check("SENSITIVE does not fire on a date correction", sensitive?.fired === false, JSON.stringify(sensitive));
  check("nothing else fires either", readings.every((r) => !r.fired), JSON.stringify(readings.filter((r) => r.fired)));
}

{
  const readings = await detect({
    utterance: "Let me just pay now - the card is 4111 1111 1111 1111.",
    intent: "answer",
    sttConfidence: 0.95,
    attempts: 0,
    maxAttempts: 2,
    state: newDetectorState(),
  });
  const sensitive = readings.find((r) => r.signal === "SENSITIVE");
  check("SENSITIVE fires on a real card", sensitive?.fired === true, JSON.stringify(sensitive));
  check(
    "and its evidence carries no digits to the console",
    !/\d/.test(sensitive?.evidence ?? ""),
    sensitive?.evidence
  );
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll escalation checks pass.");
process.exit(failures ? 1 : 0);

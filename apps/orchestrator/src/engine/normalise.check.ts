import { normalise, normaliseBool, normaliseDate, normaliseEmail, normalisePhone, normalisePostcode, stateFromPostcode } from "./normalise.js";
import { loadJourney, fieldById } from "../journey/index.js";

/**
 * `pnpm normalise:check` - the normalisers, against how people actually talk.
 *
 * These are pure functions and they run in milliseconds, so there is no excuse for
 * finding out mid-call that "seventh of March" is not a date. Every case here came
 * from a real failure or from a phrasing a persona uses.
 */

type Case = { input: string; expect: string | boolean | null; field?: string };

const DATES: Case[] = [
  { input: "Seventh of March, 1989", expect: "1989-03-07" },
  { input: "7 March 1989", expect: "1989-03-07" },
  { input: "March 7 1989", expect: "1989-03-07" },
  { input: "7/3/1989", expect: "1989-03-07" },
  { input: "1989-03-07", expect: "1989-03-07" },
  { input: "the 3rd of June, 1975", expect: "1975-06-03" },
  { input: "twenty-fifth of December 1990", expect: "1990-12-25" },
  { input: "the second of January, 2001", expect: "2001-01-02" },
  { input: "31st of February 1990", expect: null },
  { input: "not a date at all", expect: null },
];

const POSTCODES: Case[] = [
  { input: "two one five zero", expect: "2150" },
  { input: "2150", expect: "2150" },
  { input: "it's 3000", expect: "3000" },
  { input: "12", expect: null },
  { input: "9999", expect: null },
];

const EMAILS: Case[] = [
  { input: "p-r-i-y-a dot sharma at gmail dot com", expect: "priya.sharma@gmail.com" },
  { input: "priya dot sharma at gmail dot com", expect: "priya.sharma@gmail.com" },
  { input: "priya.sharma@gmail.com", expect: "priya.sharma@gmail.com" },
  { input: "just some words", expect: null },
];

const PHONES: Case[] = [
  { input: "0412 345 678", expect: "+61412345678" },
  { input: "+61412345678", expect: "+61412345678" },
  { input: "412345678", expect: "+61412345678" },
  { input: "12345", expect: null },
];

const BOOLS: { input: string; expect: boolean | null }[] = [
  { input: "Yes, that's me.", expect: true },
  { input: "yep", expect: true },
  { input: "No, nothing like that.", expect: false },
  { input: "nope", expect: false },
  { input: "no, that's right", expect: true },
  { input: "maybe later", expect: null },
];

const ENUMS: Case[] = [
  { input: "Electricity only.", expect: "electricity", field: "fuel_type" },
  { input: "both please", expect: "both", field: "fuel_type" },
  { input: "Already living here.", expect: "existing", field: "connection_type" },
  { input: "we're moving in", expect: "move_in", field: "connection_type" },
];

let failures = 0;

function check(label: string, input: string, got: string | boolean | null, want: string | boolean | null): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label.padEnd(10)} ${JSON.stringify(input).slice(0, 44).padEnd(46)} ` +
      `${ok ? String(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`
  );
}

const run = (label: string, cases: Case[], fn: (s: string) => { ok: boolean; value?: unknown; reason?: string }) => {
  for (const c of cases) {
    const r = fn(c.input);
    check(label, c.input, r.ok ? ((r.value as string) ?? null) : null, c.expect);
  }
};

run("date", DATES, normaliseDate);
run("postcode", POSTCODES, normalisePostcode);
run("email", EMAILS, normaliseEmail);
run("phone", PHONES, normalisePhone);

for (const c of BOOLS) check("bool", c.input, normaliseBool(c.input), c.expect);

const journey = loadJourney();
for (const c of ENUMS) {
  const field = fieldById(journey, c.field as string);
  if (!field) {
    console.log(`FAIL enum       unknown field ${c.field}`);
    failures++;
    continue;
  }
  const r = normalise(field, c.input);
  check("enum", c.input, r.ok ? ((r.value as string) ?? null) : null, c.expect);
}

// State inference from postcode ranges, so the agent does not ask a question the
// customer finds strange after they have already given the postcode.
for (const [postcode, want] of [["2150", "NSW"], ["3000", "VIC"], ["4000", "QLD"], ["6000", "WA"], ["2600", "ACT"], ["0800", "NT"]] as const) {
  check("state", postcode, stateFromPostcode(postcode), want);
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll normalisers pass.");
process.exit(failures ? 1 : 0);

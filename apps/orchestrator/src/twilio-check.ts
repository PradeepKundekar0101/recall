import twilio from "twilio";
import { WebSocket } from "ws";
import { env, has } from "./env.js";

/**
 * `pnpm twilio:check`.
 *
 * The rehearsal checklist's first line. Everything here has failed on a venue
 * network at least once, and each failure looks like something else when it
 * happens during a call: a blocked websocket upgrade surfaces only as Twilio
 * error 31920, and a trial account surfaces as an unexplained dial failure.
 */

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function run(): Promise<void> {
  if (!has.twilio()) {
    add("credentials", false, "TWILIO_* or PUBLIC_BASE_URL missing from .env");
    return report();
  }

  const client = twilio(env.twilioSid, env.twilioToken);

  try {
    const account = await client.api.v2010.accounts(env.twilioSid).fetch();
    const trial = account.type?.toLowerCase().includes("trial") ?? false;
    add("account", !trial, trial ? `${account.type} - trial accounts only dial verified numbers` : `${account.type}`);
  } catch (err) {
    add("account", false, err instanceof Error ? err.message : String(err));
  }

  try {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: env.twilioFrom, limit: 1 });
    add("from number", numbers.length > 0, numbers.length ? env.twilioFrom : `${env.twilioFrom} is not on this account`);
  } catch (err) {
    add("from number", false, err instanceof Error ? err.message : String(err));
  }

  // Geo permissions: dialling AU has to be enabled, and it is off by default.
  try {
    const perms = await client.voice.v1.dialingPermissions.countries("AU").fetch();
    add("AU dialing", Boolean(perms.lowRiskNumbersEnabled), perms.lowRiskNumbersEnabled ? "enabled" : "DISABLED in Twilio geo permissions");
  } catch (err) {
    add("AU dialing", false, err instanceof Error ? err.message : String(err));
  }

  add(
    "test numbers",
    env.testNumbers.length > 0,
    env.testNumbers.length ? env.testNumbers.join(", ") : "TEST_NUMBERS is empty - every dial will be refused"
  );
  add("handoff number", has.handoff(), env.handoffNumber || "HANDOFF_NUMBER unset - warm transfer has nowhere to go");

  // The tunnel must accept an anonymous websocket upgrade. Twilio sends no auth.
  await checkTunnel();
  report();
}

async function checkTunnel(): Promise<void> {
  if (!env.publicBaseUrl.startsWith("https")) {
    add("tunnel", false, `PUBLIC_BASE_URL is "${env.publicBaseUrl}" - Twilio needs https`);
    return;
  }
  const url = `${env.publicBaseUrl.replace(/^https/, "wss")}/media/preflight`;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      add("tunnel", false, `no websocket upgrade from ${url} within 8s`);
      ws.terminate();
      resolve();
    }, 8000);

    ws.on("message", (data) => {
      clearTimeout(timer);
      add("tunnel", String(data).includes("preflight-ok"), url);
      ws.close();
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      add("tunnel", false, `${url}: ${err.message}`);
      resolve();
    });
  });
}

function report(): void {
  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed++;
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(16)} ${check.detail}`);
  }
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

void run();

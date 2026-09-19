"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CallSetup as CallSetupBody, FieldValue, Journey } from "@recall/shared";
import { getJson, postJson } from "../lib/api";
import { sectionTitle, seedsFromLead } from "../lib/journey";
import { Shell } from "../components/Shell";
import { PageBar } from "../components/PageBar";
import { Orb } from "../components/Orb";
import { Portrait } from "../components/Portrait";
import type { Phase } from "../components/Stepper";
import { CustomerPicker, type LeadRow } from "../components/CustomerPicker";
import { CallSetup } from "../components/CallSetup";

/**
 * Setting a call up: choose the customer, then decide what the agent already
 * knows and how it should talk. Dial hands over to the call's own page.
 */
export default function OperatorConsole() {
  const router = useRouter();
  const [journey, setJourney] = useState<Journey | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [selectedLead, setSelectedLead] = useState<string | null>(null);
  const [phase, setPhase] = useState<Exclude<Phase, "call">>("customer");
  const [seeds, setSeeds] = useState<Record<string, FieldValue | null>>({});
  /** Which lead the seeds were built for, so going back and forth keeps the operator's edits. */
  const [seedsFor, setSeedsFor] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [dialling, setDialling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void getJson<Journey>("/journey").then(setJourney).catch(() => setNotice("Orchestrator is not reachable."));
    void getJson<{ leads: LeadRow[] }>("/leads")
      .then((data) => {
        setLeads(data.leads);
        setSelectedLead(data.leads[0]?.id ?? null);
      })
      .catch(() => undefined);
  }, []);

  const lead = leads.find((l) => l.id === selectedLead) ?? null;
  const droppedAt = lead ? sectionTitle(journey, lead.last_completed_step) : null;

  function continueToSetup() {
    if (!lead || !journey) return;
    if (seedsFor !== lead.id) {
      setSeeds(seedsFromLead(lead, journey));
      setSeedsFor(lead.id);
    }
    setNotice(null);
    setPhase("setup");
  }

  async function dial() {
    if (!lead || dialling) return;
    setNotice(null);
    setDialling(true);
    try {
      const body: CallSetupBody = {
        lead_id: lead.id,
        prefill: seeds,
        ...(brief.trim() ? { agent_brief: brief.trim() } : {}),
      };
      const { status, data } = await postJson<{ call_id?: string; error?: string }>("/calls", body);
      if (status === 400 || status === 403 || status === 404 || status === 501) {
        setNotice(data.error ?? `Dial refused (${status}).`);
        return;
      }
      // The call has its own address from here on. Whether a phone actually
      // rang is on the call's first event, so the page there says so itself.
      if (data.call_id) router.push(`/calls/${data.call_id}`);
    } catch {
      setNotice("Orchestrator is not reachable.");
    } finally {
      setDialling(false);
    }
  }

  async function addToDnc() {
    if (!lead) return;
    await postJson("/dnc", { phone: lead.phone });
    const refreshed = await getJson<{ leads: LeadRow[] }>("/leads");
    setLeads(refreshed.leads);
    setNotice(`${lead.phone} added to the Do Not Call register.`);
  }

  return (
    <Shell>
      <PageBar phase={phase}>
        {/* A guardrail made visible: every lead carries a test number, and the chip says which. */}
        <span className="chip chip-warn">Test run · {lead?.phone ?? "no number"}</span>
      </PageBar>

      {/* The two parties, then the person on the other end as the one large
          thing on screen. The orb is the agent, still until the dial. */}
      {phase === "setup" && (
        <section className="callhead" aria-label="Call">
          <div className="parties">
            <Orb status="idle" size={52} />
            <Portrait id={lead?.id} name={lead?.full_name ?? "Customer"} size={52} />
          </div>
          <div className="callhead-lead">
            <h1 className="lead-name">{lead ? lead.full_name : "No lead selected"}</h1>
            <div className="lead-sub">{lead ? `${lead.id} · dropped at ${droppedAt}` : ""}</div>
          </div>
        </section>
      )}

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {phase === "customer" && (
        <CustomerPicker
          leads={leads}
          journey={journey}
          selected={selectedLead}
          onSelect={setSelectedLead}
          onContinue={continueToSetup}
        />
      )}

      {phase === "setup" && lead && (
        <CallSetup
          lead={lead}
          journey={journey}
          seeds={seeds}
          onSeedsChange={setSeeds}
          brief={brief}
          onBriefChange={setBrief}
          dialling={dialling}
          onBack={() => setPhase("customer")}
          onDial={dial}
          onDnc={addToDnc}
        />
      )}
    </Shell>
  );
}

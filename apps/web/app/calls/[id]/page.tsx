"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Journey } from "@recall/shared";
import { getJson } from "../../../lib/api";
import { Nav } from "../../../components/Nav";
import { CallBoard } from "../../../components/CallBoard";

/**
 * One call at its own address. Dialling lands here, and so does opening a
 * call from the history, so a link to a call is a link to everything that was
 * said and captured on it - live while it runs, replayed once it is over.
 */
export default function CallPage() {
  const { id } = useParams<{ id: string }>();
  const [journey, setJourney] = useState<Journey | null>(null);

  useEffect(() => {
    void getJson<Journey>("/journey").then(setJourney).catch(() => undefined);
  }, []);

  return (
    <div className="console">
      <Nav phase="call">
        <Link href="/" className="btn btn-primary">
          Set up another call
        </Link>
      </Nav>
      <CallBoard callId={id} journey={journey} />
    </div>
  );
}

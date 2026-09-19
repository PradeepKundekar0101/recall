"use client";

/**
 * Where the operator is: choosing the customer, setting the call up, or on the
 * call. The three really are a sequence - nothing on step two exists until a
 * customer is chosen, and nothing on step three until the dial - so the numbers
 * carry information rather than decoration.
 */
export type Phase = "customer" | "setup" | "call";

const STEPS: { id: Phase; label: string }[] = [
  { id: "customer", label: "Customer" },
  { id: "setup", label: "Fields & brief" },
  { id: "call", label: "Live call" },
];

export function Stepper({ phase }: { phase: Phase }) {
  const current = STEPS.findIndex((s) => s.id === phase);
  return (
    <ol className="stepper" aria-label="Call setup">
      {STEPS.map((step, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={step.id} className={`step step-${state}`} aria-current={state === "active" ? "step" : undefined}>
            <span className="step-num" aria-hidden="true">
              {state === "done" ? "✓" : i + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

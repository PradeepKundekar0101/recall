/**
 * What a chart renders instead of a line when there is not enough behind it.
 *
 * Five dialled calls drawn as a trend is decoration that reads as evidence.
 * This is the component that refuses to do that, which is why it is a component
 * and not a sentence in the copy.
 */
export function Thin({ calls, threshold, what }: { calls: number; threshold: number; what: string }) {
  return (
    <div className="thin" role="status">
      <span className="thin-count">{calls}</span>
      <span className="thin-text">
        {calls === 1 ? "call" : "calls"} in this window. {what} needs at least {threshold} to mean anything.
      </span>
    </div>
  );
}

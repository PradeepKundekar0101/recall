import type { FieldStat } from "@recall/shared";

/**
 * Which question the agent keeps fumbling.
 *
 * Sorted worst first by the server, so the answer is the top row rather than
 * something to hunt for.
 */
export function FieldTable({ fields }: { fields: FieldStat[] }) {
  if (!fields.length) return <p className="empty">No fields have been asked yet.</p>;

  return (
    // Five columns do not fit a phone. The table scrolls inside its own card
    // rather than pushing the whole console sideways, which is what a table this
    // wide does when it is left to overflow.
    <div className="field-table-wrap">
      <table className="field-table" aria-label="Field capture, worst first">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Asked</th>
            <th scope="col">First try</th>
            <th scope="col">Re-asks</th>
            <th scope="col">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const firstTry = field.asked ? field.captured_first_try / field.asked : null;
            return (
              <tr key={field.id}>
                <th scope="row">
                  {field.id.replace(/_/g, " ")}
                  {field.redacted > 0 && <span className="chip chip-error">redacted {field.redacted}</span>}
                </th>
                <td>{field.asked}</td>
                <td>{firstTry === null ? "-" : `${Math.round(firstTry * 100)}%`}</td>
                <td className={field.re_asks > 0 ? "num-warn" : undefined}>{field.re_asks}</td>
                <td>{field.mean_confidence === null ? "-" : `${Math.round(field.mean_confidence * 100)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

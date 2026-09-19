/**
 * The turn latency budget, in milliseconds.
 *
 * Shared because two things judge a turn against it and must judge against the
 * same number: the orchestrator flags a turn `over_budget` on `latency.turn`
 * while the call is live, and the analytics dashboard counts how many turns in
 * a window went over it after the fact. One constant, not a live number and a
 * historical one quietly drifting apart.
 */
export const LATENCY_BUDGET_MS = 800;

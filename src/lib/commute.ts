import type { CommuteRequest, CommuteResult } from "./types";

/**
 * Placeholder for the future commute-calculation backend (TTC/Metrolinx
 * trip-planning integration). Wire this up to a real API route or service.
 */
export async function calculateCommute(
  request: CommuteRequest
): Promise<CommuteResult> {
  const departureDescription =
    request.departure.mode === "now"
      ? "now"
      : `${request.departure.date} ${request.departure.time}`;

  throw new Error(
    `calculateCommute is not implemented yet. Received request from "${request.from}" to "${request.destination}" departing ${departureDescription}.`
  );
}

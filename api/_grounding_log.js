/**
 * 운영 관측: GROUNDING_LOG=1 일 때 stderr 한 줄 JSON
 */

export function logGroundingObservation(row) {
  if (process.env.GROUNDING_LOG !== "1") return;
  const line = {
    ts: new Date().toISOString(),
    ...row,
  };
  console.error("[grounding]", JSON.stringify(line));
}

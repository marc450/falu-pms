/**
 * Shared number-formatting helpers.
 * All use en-US locale so thousands are separated by commas: 1,000,000
 */

/** Integer or decimal with comma separators. Returns "—" for null/undefined. */
export function fmtN(
  val: number | null | undefined,
  decimals = 0,
): string {
  if (val === null || val === undefined) return "—";
  return val.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Percentage: fmtN + "%" */
export function fmtPct(
  val: number | null | undefined,
  decimals = 1,
): string {
  if (val === null || val === undefined) return "—";
  return fmtN(val, decimals) + "%";
}

/** Hours: fmtN + " h" */
export function fmtH(
  val: number | null | undefined,
  decimals = 1,
): string {
  if (val === null || val === undefined) return "—";
  return fmtN(val, decimals) + " h";
}

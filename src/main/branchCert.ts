/**
 * The fingerprint of the certificate this server presents.
 *
 * Set once at boot, read when a till pairs — the one moment it can be handed
 * over safely, because a manager is standing there authorising it. It lives
 * in its own module because the two ends of that exchange are now in
 * different files, and a value this small should not drag a route file into
 * the startup path to reach it.
 */
let fingerprint: string | null = null

export function setBranchCertFingerprint(fp: string | null): void {
  fingerprint = fp
}

export function getBranchCertFingerprint(): string | null {
  return fingerprint
}

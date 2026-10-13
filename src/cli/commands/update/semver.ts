/**
 * semver.ts — the order `eris update` puts release tags in. A tag is
 * `[v]MAJOR.MINOR.PATCH[-prerelease]`, ordered as semver.org defines: the
 * numbers first, a prerelease before its release, prerelease identifiers
 * compared one by one (numbers numerically, below words).
 */

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * A release tag: `vMAJOR.MINOR.PATCH[-prerelease]`, exactly the tags
 * `compareVersions` orders, with the `v`. The release workflow's tag check
 * (.github/workflows/release.yml) and scripts/render-formula.ts hold the same
 * grammar; tests/workflows.test.ts runs all three on one table.
 */
export const RELEASE_TAG = /^v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** -1, 0 or 1 for `a` before, equal to or after `b`; null when either is not a version (`dev`, a typo). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return null;
  for (const i of [1, 2, 3]) {
    const d = sign(Number(pa[i]) - Number(pb[i]));
    if (d !== 0) return d;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const ia = ra.split(".");
  const ib = rb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = sign(Number(x) - Number(y));
      if (d !== 0) return d;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

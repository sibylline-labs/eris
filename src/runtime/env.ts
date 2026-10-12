/**
 * env.ts — the ONE way to read an environment variable by a name you were
 * handed (a `--token-env NAME`, a `${REF}` in a settings file).
 *
 * An env object is a plain object, so indexing it with `__proto__` or
 * `constructor` returns an inherited value and a variable that is not set reads
 * as set. Only an own property counts. The `env-read-own-property` ast-grep rule
 * (rules/) keeps every other site off the raw index.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** `name`'s value in `env`, or `undefined` when it is not an own property. */
export function readEnv(env: EnvLike, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

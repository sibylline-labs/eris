/**
 * A distribution's completion library, in the shape a real one has: eight
 * shared functions that find a project file from `pwd -P` bounded by the git
 * top level, memoise its facts in a cache keyed on the files' mtimes, and read
 * pre-warmed name lists; four domains built on them. One function per text,
 * as the helper check requires; comments live here, not in the shell.
 *
 * - `fx_cache_dir`: the cache directory, overridable by env.
 * - `fx_root_file` / `fx_leaf_file`: the project file at the git top level, and
 *   the nearest one below it on the physical cwd (never above the top level).
 * - `fx_mtime`: GNU `stat -c` first; BSD `stat` refuses it with nothing on stdout.
 * - `fx_static`: tagged `service` / `env` / `key` lines, rebuilt with yq on a
 *   stamp mismatch; silent when yq or the files are absent.
 * - `fx_names`: one name per line from `names-<kind>-<service>[-<env>].list`.
 */

import type { CompletionDomain } from "../../src/cli/registry";

const fn = (name: string, body: string) => `__eris_dom_fx_${name}() {\n${body}\n}\n`;

export const LIBRARY: readonly string[] = [
  fn("cache_dir", `  printf '%s\\n' "\${FIXTURE_CACHE_DIR:-$HOME/.cache/fixture-completion}"`),
  fn("git_top", `  command -v git >/dev/null 2>&1 || return 0
  git rev-parse --show-toplevel 2>/dev/null || return 0`),
  fn("root_file", `  local top="$1"
  [ -n "$top" ] && [ -f "$top/fixture.yaml" ] && printf '%s\\n' "$top/fixture.yaml"
  return 0`),
  fn("leaf_file", `  local top="$1" dir
  [ -n "$top" ] || return 0
  dir=$(pwd -P 2>/dev/null) || dir=$PWD
  [ -n "$dir" ] || dir=$PWD
  case "$dir" in
    "$top" | "$top"/*) ;;
    *) return 0 ;;
  esac
  while :; do
    if [ -f "$dir/fixture.yaml" ]; then
      [ "$dir" = "$top" ] || printf '%s\\n' "$dir/fixture.yaml"
      return 0
    fi
    [ "$dir" = "$top" ] && return 0
    dir=\${dir%/*}
    [ -n "$dir" ] || dir=/
  done`),
  fn("mtime", `  if [ -n "$1" ] && [ -f "$1" ]; then
    stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
  else
    echo 0
  fi`),
  fn("static", `  local root leaf top sig dir cache stamp out svc f ex
  top=$(__eris_dom_fx_git_top)
  root=$(__eris_dom_fx_root_file "$top")
  leaf=$(__eris_dom_fx_leaf_file "$top")
  [ -n "$root$leaf" ] || return 0
  dir=$(__eris_dom_fx_cache_dir)
  sig=$(printf '%s|%s' "$root" "$leaf" | cksum 2>/dev/null | tr ' \\t' '--')
  [ -n "$sig" ] || return 0
  cache="$dir/project-$sig.v1"
  stamp="#v1 $(__eris_dom_fx_mtime "$root") $(__eris_dom_fx_mtime "$leaf")"
  if [ -f "$cache" ] && [ "$(head -n 1 "$cache" 2>/dev/null)" = "$stamp" ]; then
    cat "$cache" 2>/dev/null
    return 0
  fi
  command -v yq >/dev/null 2>&1 || return 0
  svc=""
  for f in "$leaf" "$root"; do
    [ -n "$f" ] || continue
    [ -n "$svc" ] || svc=$(yq e '.service // ""' "$f" 2>/dev/null)
  done
  ex=""
  [ -n "$leaf" ] && ex=$(yq e '(.excludes // []) | .[]' "$leaf" 2>/dev/null | tr '\\n' '|')
  out=$(
    printf '%s\\n' "$stamp"
    [ -n "$svc" ] && printf 'service %s\\n' "$svc"
    for f in "$root" "$leaf"; do
      [ -n "$f" ] && yq e '(.envs // {}) | keys | .[]' "$f" 2>/dev/null
    done | sort -u | awk 'NF { print "env " $0 }'
    for f in "$root" "$leaf"; do
      [ -n "$f" ] && yq e '(.keys // {}) | keys | .[]' "$f" 2>/dev/null
    done | sort -u | awk -v ex="$ex" '
      BEGIN { n = split(ex, a, "|"); for (i = 1; i <= n; i++) if (a[i] != "") x[a[i]] = 1 }
      NF && !($0 in x) { print "key " $0 }'
  ) 2>/dev/null
  [ -n "$out" ] || return 0
  { mkdir -p "$dir" &&
      printf '%s\\n' "$out" > "$cache.$$" &&
      mv "$cache.$$" "$cache"; } 2>/dev/null
  printf '%s\\n' "$out"
  return 0`),
  `__eris_dom_fx_service() { __eris_dom_fx_static | awk '$1 == "service" { print $2; exit }'; }\n`,
  fn("names", `  local kind="$1" env="$2" svc dir f
  svc=$(__eris_dom_fx_service)
  [ -n "$svc" ] || return 0
  dir=$(__eris_dom_fx_cache_dir)
  for f in "$dir/names-$kind-$svc-$env.list" "$dir/names-$kind-$svc.list"; do
    if [ -f "$f" ]; then
      grep -v '^#' "$f" 2>/dev/null
      return 0
    fi
  done
  return 0`),
];

export const FX_ENV: CompletionDomain = { domain: "@fx_env", library: LIBRARY, helper: `__eris_dom_fx_env()    { __eris_dom_fx_static | awk '$1 == "env" { print $2 }'; }\n` };
export const FX_KEY: CompletionDomain = { domain: "@fx_key", library: LIBRARY, helper: `__eris_dom_fx_key()    { __eris_dom_fx_static | awk '$1 == "key" { print $2 }'; }\n` };
export const FX_GATE: CompletionDomain = { domain: "@fx_gate", library: LIBRARY, helper: `__eris_dom_fx_gate() { __eris_dom_fx_names flag "\${1:-}"; }\n` };
export const FX_VAR: CompletionDomain = { domain: "@fx_var", library: LIBRARY, helper: `__eris_dom_fx_var() { __eris_dom_fx_names dynamic_config "\${1:-}"; }\n` };

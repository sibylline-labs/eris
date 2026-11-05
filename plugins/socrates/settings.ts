/**
 * settings.ts — `eris socrates settings team`, loaded only when `eris socrates
 * settings` dispatches (./submit.ts routes the group).
 *
 * Sets or clears the Linear team an enrolled project's review Epics file on, and
 * prints the receipt: the stored override and the team the next review Epic
 * files on, with where that came from (the override, the project's lead team, or
 * its first team). The server owns the choice and checks the caller is an org
 * admin; this verb names the team and nothing else.
 *
 * Invariants:
 *   - `<team-uuid>` and `--clear` are exclusive, and one of them is required.
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over the
 *     body: a gitleaks hit refuses it (`socrates-secret-detected`).
 *   - The request body is `SocratesSettingsTeamRequest`'s parse; the reply is
 *     read only through `SocratesSettingsTeamResponse` (./client.ts owns the
 *     exchange).
 *   - The team is a Linear team UUID; resolving a key or name is the server's
 *     to add, so the verb never guesses one.
 */

import { scanStrings } from "eris/outbound-scan";
import { groupArgs, readArgs, renderFailureBlock, CliExit, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesSettingsTeamRequest, SocratesSettingsTeamResponse } from "./socrates-contract.v1.verbs";

export const SETTINGS_USAGE = `Usage: eris socrates settings <command>

Commands:
  policy     Show the org's scoring policy, or change it (an org admin's); --preview shows a change first
  enrolment  List the enrolled projects and their Linear links
  health     Print the install, webhook, reconcile and stuck-write health
  usage      Print the no-credit usage figures
  canon      Show or choose the org's Canon doc (an org admin's)
  team       Set or clear the Linear team a project's review Epics file on (an org admin's)

--output json prints each command's JSON form.

Run 'eris socrates settings <command> --help' for its flags.
`;

export const TEAM_USAGE = `Usage: eris socrates settings team <team-uuid> [--project <name>]
       eris socrates settings team --clear [--project <name>]

Set the Linear team an enrolled project's review Epics, their entries and
carry-over Epics file on, or clear it so they file on the project's lead team
(or its first team when it has none). Only an org admin may change it. The
change applies from the next review Epic: today's stays on its team.

Prints 'files on <key> (<source>)', where <source> is override, lead or first.
--output json prints {project, override: {id, key} | null, filing_team: {id,
key, source}, contract_version}.

  <team-uuid>       the Linear team's id; it must be one of the project's teams
  --clear           remove the override
  --project <name>  the enrolled project; required when the org enrols several

Sign in first with 'eris login'.
`;

const refusalFix = (status: number): string | undefined => {
  if (status === 403) return "ask an org admin to run this command";
  if (status === 404) return "pass --project <name> with one of the enrolled projects the detail lists";
  if (status === 409) return "follow the step named above, then run the command again";
  if (status === 422) return "pass one of the team ids the detail lists, or --clear";
  return undefined;
};

const badResponseFix = (status: number): string | undefined =>
  status === 404 || status === 405
    ? `this endpoint does not serve ${SOCRATES_ROUTES.settings_team.path}: update the server, or check the url points at a Socrates endpoint`
    : undefined;

/** `eris socrates settings ...`: the group's usage, or its one verb. */
export async function runSettings(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "socrates settings", args);
  if ((g.kind === "bare" || g.kind === "help") && ctx.format === "json") {
    // The allow-list admits `settings` for its json sub; the group itself has no rendering.
    ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris socrates settings has no JSON rendering", fix: "use: eris --output json socrates settings <command> ..." }, ctx.erisDir));
    throw new CliExit(1);
  }
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(SETTINGS_USAGE);
    return 0;
  }
  if (g.kind === "unknown") fail(ctx, "socrates-unknown-verb", `unknown socrates settings command '${g.sub}'`, "use: policy, enrolment, health, usage, canon, team\nrun 'eris socrates settings --help' for the command list");
  if (g.sub === "policy") return (await import("./settings-panels")).runPolicy(g.rest, ctx, deps);
  if (g.sub === "enrolment") return (await import("./settings-panels")).runEnrolment(g.rest, ctx, deps);
  if (g.sub === "health") return (await import("./settings-panels")).runHealth(g.rest, ctx, deps);
  if (g.sub === "usage") return (await import("./settings-panels")).runUsage(g.rest, ctx, deps);
  if (g.sub === "canon") return (await import("./settings-panels")).runCanon(g.rest, ctx, deps);
  return runTeam(g.rest, ctx, deps);
}

async function runTeam(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  const a = readArgs(plugin.rows, "socrates settings team", args, ctx, { help: TEAM_USAGE });
  if (a === null) return 0;
  const [team] = a.pos;
  const clear = a.flags["--clear"] === true;
  const usage = "eris socrates settings team <team-uuid> | --clear";
  if (team !== undefined && clear) fail(ctx, "socrates-flag-required", "pass either <team-uuid> or --clear, not both", usage);
  if (team === undefined && !clear) fail(ctx, "socrates-flag-required", "missing <team-uuid> (or --clear)", usage);
  const project = a.flags["--project"];

  const parsed = SocratesSettingsTeamRequest.safeParse({
    schema_version: SOCRATES_CONTRACT_VERSION,
    ...(typeof project === "string" ? { project } : {}),
    team: clear ? null : team,
  });
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not a team id or project name: ${printable(parsed.error.issues.map((i) => i.path.join(".")).join(", "))}`, usage);

  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in the arguments (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the team's id; this check cannot be overridden");

  const endpoint = await socratesEndpoint(ctx, deps);
  const receipt = await postSocrates(ctx, deps, endpoint, {
    path: SOCRATES_ROUTES.settings_team.path,
    method: "PUT",
    body: parsed.data,
    decoder: SocratesSettingsTeamResponse,
    subject: "the filing-team change",
    refusalFix,
    badResponseFix,
  });

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  }
  const f = receipt.filing_team;
  ctx.stdout.write(`files on ${printable(f.key)} (${f.source}): ${printable(f.id)}\n`);
  return 0;
}

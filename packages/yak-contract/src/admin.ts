/**
 * The Yaks admin surface: an org's destination config, its intake status and
 * the Linear choices it can configure from. These are the bodies of
 * `GET`/`PUT /v1/yaks/config`, `GET /v1/yaks/status` and
 * `GET /v1/yaks/discovery`, as a client reads and writes them.
 *
 * Invariants:
 *  - A read shape accepts fields it does not name (`passthrough`), so a
 *    server that answers more than this contract knows still parses, and a
 *    client that re-prints the body loses nothing.
 *  - `YakConfigPatch` names only the keys a client changes. An absent key
 *    keeps its stored value; `null` clears a nullable id. The server merges the
 *    patch over the stored config and refuses (422) a merge without a team, so
 *    an org's first patch carries `team_id`.
 *  - Every id is a Linear id, a UUID. No field holds a secret.
 */

import { z } from "zod";

/** A Linear id: they are UUIDs. */
export const LinearId = z.string().uuid();

/** The keys of an org's yak config a client sets. */
export const YakConfigPatch = z
  .object({
    team_id: LinearId,
    project_id: LinearId.nullable(),
    state_id: LinearId.nullable(),
    label_ids: z.array(LinearId),
  })
  .partial();
export type YakConfigPatch = z.infer<typeof YakConfigPatch>;

/** An org's stored yak config: where its yaks are filed. Fields past these
 *  (caps, per-verb and per-component label maps) pass through. */
export const YakConfig = z
  .object({
    team_id: z.string(),
    project_id: z.string().nullable(),
    state_id: z.string().nullable(),
    label_ids: z.array(z.string()),
  })
  .passthrough();
export type YakConfig = z.infer<typeof YakConfig>;

/** The config as stored, with who last set it and when. */
export const YakStoredConfig = z
  .object({
    config: YakConfig,
    updated_at: z.string(),
    updated_by: z.object({ kind: z.string(), id: z.string(), name: z.string() }).passthrough(),
  })
  .passthrough();
export type YakStoredConfig = z.infer<typeof YakStoredConfig>;

/** `GET /v1/yaks/config`: whether the org is configured, and its stored config when it is. */
export const YakConfigRead = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).passthrough(),
  YakStoredConfig.extend({ configured: z.literal(true) }),
]);
export type YakConfigRead = z.infer<typeof YakConfigRead>;

/** `GET /v1/yaks/status`: an org's intake. An unconfigured org's yaks are
 *  accepted and parked until a config exists. */
export const YakStatus = z
  .object({
    configured: z.boolean(),
    observation_count: z.number().int().nonnegative(),
    last_filed_issue_identifier: z.string().nullable(),
  })
  .passthrough();
export type YakStatus = z.infer<typeof YakStatus>;

export const YakDiscoveredTeam = z.object({ id: z.string(), key: z.string(), name: z.string() }).passthrough();
export type YakDiscoveredTeam = z.infer<typeof YakDiscoveredTeam>;

export const YakDiscoveredProject = z
  .object({ id: z.string(), name: z.string(), status: z.object({ name: z.string(), type: z.string() }).passthrough() })
  .passthrough();
export type YakDiscoveredProject = z.infer<typeof YakDiscoveredProject>;

export const YakDiscoveredState = z
  .object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })
  .passthrough();
export type YakDiscoveredState = z.infer<typeof YakDiscoveredState>;

export const YakDiscoveredLabel = z
  .object({ id: z.string(), name: z.string(), isGroup: z.boolean(), teamId: z.string().nullable() })
  .passthrough();
export type YakDiscoveredLabel = z.infer<typeof YakDiscoveredLabel>;

/** `GET /v1/yaks/discovery[?team_id=]`: the workspace's teams, and one team's
 *  projects, workflow states and labels (the first team's when none is named;
 *  `team_id` null and every list empty for a workspace with no teams).
 *  `default_state_id` is that team's Triage state, or null. */
export const YakDiscovery = z
  .object({
    teams: z.array(YakDiscoveredTeam),
    team_id: z.string().nullable(),
    projects: z.array(YakDiscoveredProject),
    workflow_states: z.array(YakDiscoveredState),
    labels: z.array(YakDiscoveredLabel),
    default_state_id: z.string().nullable(),
  })
  .passthrough();
export type YakDiscovery = z.infer<typeof YakDiscovery>;

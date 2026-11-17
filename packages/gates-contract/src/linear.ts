/**
 * linear.ts — the gateway's `/v1/linear` replies (`linear-contract/v1`) that eris reads, and the yak
 * lookup's two replies, vendored beside the receipt schemas (docs/dev/GATES-CLIENT.md). Each reply is
 * decoded leniently: a key a Schema does not name is dropped, so the gateway may add fields; a reply
 * without its `contract_version` does not decode.
 */

import * as Schema from "effect/Schema";
import { GatesBundleSha } from "./bundle";

export const LINEAR_PATH = "/v1/linear";
export const LINEAR_CONTRACT_VERSION = "linear-contract/v1";

const Version = Schema.Literal(LINEAR_CONTRACT_VERSION);
const State = Schema.Struct({ name: Schema.String, type: Schema.String });

/** An issue as far as a loop reads it: its key, its state, and its parent's. */
const IssueNode = Schema.Struct({
  identifier: Schema.String,
  state: State,
  parent: Schema.optionalKey(Schema.NullOr(Schema.Struct({ identifier: Schema.String, state: State }))),
});

/** `GET /v1/linear/issues/{key}` and `POST .../transition`. */
export const LinearIssueReply = Schema.Struct({ issue: IssueNode, contract_version: Version });

/** A claim as the gateway answers it: never its `claim_id`, which is the holder's guard. */
export const LinearClaim = Schema.Struct({
  issue: Schema.String,
  loop: Schema.String,
  runtime: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  claimed_at: Schema.String,
  expires_at: Schema.String,
  agent_session_id: Schema.NullOr(Schema.String),
});
export type LinearClaim = typeof LinearClaim.Type;

/** `POST .../claim`: the claim, what the bind did (an open string), and the org's live policy sha when sent. */
export const LinearClaimReply = Schema.Struct({ claim: LinearClaim, delegate_status: Schema.String, bundle_sha: Schema.optionalKey(GatesBundleSha), contract_version: Version });

/** Who holds a claimed issue, as the 409 `issue_already_claimed` names it in `fields.holder`. */
export const LinearClaimHolder = Schema.Struct({
  loop: Schema.String,
  runtime: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  claimed_at: Schema.String,
  expires_at: Schema.String,
});

/** `POST .../release`: released, or why not (`superseded`, `not_claimed`; an open string). */
export const LinearReleaseReply = Schema.Struct({ released: Schema.Boolean, reason: Schema.optionalKey(Schema.String), contract_version: Version });

/** `POST .../comments`. */
export const LinearCommentReply = Schema.Struct({ comment: Schema.Struct({ id: Schema.String }), contract_version: Version });

/** The state types a transition may name. */
export const TRANSITION_STATE_TYPES = ["triage", "backlog", "unstarted", "started"] as const;

/** The yak routes a yak id is resolved through: the observation's cluster, then the cluster's issue. */
export const YakObservationReply = Schema.Struct({ cluster_id: Schema.optionalKey(Schema.NullOr(Schema.String)) });
export const YakClusterReply = Schema.Struct({ current_issue_identifier: Schema.optionalKey(Schema.NullOr(Schema.String)) });

/** A yak id: a 26-character ULID (read on `/v1`) or a 36-character UUID (read on `/v0`). */
export const YAK_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export const YAK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

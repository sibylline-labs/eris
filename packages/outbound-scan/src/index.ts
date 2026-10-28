/**
 * `eris/outbound-scan`: what runs over text before eris sends it anywhere.
 * scan.ts holds the order and the contract; redact.ts is our redaction pass;
 * gitleaks-rules.ts is generated (scripts/vendor-gitleaks.ts).
 */

export { GITLEAKS_VERSION } from "./gitleaks-rules";
export { formatRedactionSummary, REDACTION_CLASSES, redact, redactDeep, type DeepRedactionResult, type RedactionClass, type RedactionResult, type RedactOptions } from "./redact";
export { isRedactionClass, prepareOutbound, scanSecrets, scanStrings, secretRules, type Outbound, type Override, type SecretHit } from "./scan";

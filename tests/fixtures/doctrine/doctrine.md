active: business-as-usual

## rapid-prototype
Rapid prototype
- Ship small experiments quickly; nothing here reaches customers.

## business-as-usual
Business as usual
- Steady delivery with the full review on anything user-visible.

```yaml
policy:
  profile_default: spine
  escalate_on: [one-way-door, U2]
  gates:
    premise-gate: lite
    sdk-check: once-at-end
    research: off
  close:
    tpm-report: file-only
  signoff:
    one-way: human
    two-way: self
    unlock: off
  user_impact:
    U1: [revert-path, e2e]
  lifts:
    U0: R2
    U1:cross-repo-seam: R1
  remediate:
    on: [final-gates-fail]
    max_rounds: 3
  ask:
    two_way_timeout: 24h
    digest: daily
    session_budget: 3
```

## lock-in
Lock in
- Everything gets the deep profile and a human signs every door.

```yaml
policy:
  profile_default: deep
  signoff:
    one-way: human
    two-way: human
    raise:
      "*":
        merge: [adversarial-review:max]
  ceilings:
    all: R1
    U3: R0
  user_impact:
    U0: [revert-path]
    U1: [revert-path, e2e]
```

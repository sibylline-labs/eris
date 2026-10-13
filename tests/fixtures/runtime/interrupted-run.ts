// Driven by tests/runtime-process.test.ts: a bun process mid-`run` on a long
// child whose own child escapes into a separate process group. The worker
// writes both pids to $PID_FILE so the test can check them afterwards.
//   MODE=signal (default) — waits; the test SIGINTs this process's group.
//   MODE=exit             — calls process.exit(1) while the child is live
//                           (a die mid-run), exercising the exit hook.
//   MODE=early            — the child SIGINTs this process the moment it has
//                           written its pids, which lands while spawn() is
//                           still returning, before the child could be tracked.
// Kept outside tsc's include (tests/fixtures is excluded).
import { existsSync, readFileSync } from "node:fs";
import { nodeRunner } from "../../../src/runtime/process";

const pidFile = process.env.PID_FILE as string;
const early = process.env.MODE === "early" ? "kill -INT $PPID; " : "";
const run = nodeRunner.run(
  ["bash", "-c", `perl -e 'setpgrp(0,0); exec q(sleep), 30' & echo "$! $$" > "$PID_FILE.tmp"; mv "$PID_FILE.tmp" "$PID_FILE"; ${early}sleep 30`],
  { timeoutMs: 60_000 },
);

if (process.env.MODE === "exit") {
  while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") await Bun.sleep(20);
  process.exit(1);
}

await run;
process.stdout.write("run returned without a signal\n");

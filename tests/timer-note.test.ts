import { describe, expect, it } from "vitest";
import { timerNote } from "../src/timer-note.js";
import {
  INSTANCE,
  NOW,
  dailyJob,
  jobsRoute,
} from "./helpers/max-hours-world.js";
import { fakeEnv, withEnv } from "./helpers/run-cli.js";

// timerNote (I5). Clock 2026-10-20T16:40:00Z. A DAILY job at hour H fires at the
// next H:00Z: hour 17 = 20 min away, hour 18 = 1 h 20 min away, hour 4 = 11 h 20 min.
const note = (routes: Record<string, unknown>, opts?: { withinSec?: number }) =>
  withEnv(
    fakeEnv({
      VAST_AXI_NOW: NOW,
      FAKE_VASTAI_ROUTES: JSON.stringify(routes),
    }),
    () => timerNote(INSTANCE, opts),
  );

describe("timerNote", () => {
  it("E146: no timer gives an empty note", async () => {
    const n = await note(jobsRoute([]));
    expect(n).toEqual({ fields: {}, help: [] });
  });

  it("E146: a timer 20 minutes away warns and points at timer and finish", async () => {
    const n = await note(jobsRoute([dailyJob(5081, 17)]));
    expect(n.fields["destroy_at"]).toBe("2026-10-20T17:00Z");
    expect(n.fields["timer_left"]).toBe("20m");
    expect(n.fields["timer_warning"]).toBe(
      "destroy timer fires in 20m (2026-10-20T17:00Z): the instance and everything on it are deleted then",
    );
    expect(n.leftSec).toBe(1200);
    expect(n.destroyAtSec).toBe(1792515600);
    expect(n.help).toEqual([
      `Extend it: \`vast-axi timer ${INSTANCE} --max-hours <n>\` (2 to 23 h from now)`,
      `Or fetch now: \`vast-axi finish ${INSTANCE} --fetch-partial --fetch <remote>:<local>\``,
    ]);
  });

  it("E146: 90 minutes left warns only inside withinSec; 11 h does not", async () => {
    const jobs = jobsRoute([dailyJob(5081, 18)]);
    expect((await note(jobs)).fields["timer_warning"]).toBeUndefined();
    const n = await note(jobs, { withinSec: 7200 });
    expect(n.fields["timer_left"]).toBe("1h20m");
    expect(n.fields["timer_warning"]).toContain("fires in 1h20m");
    const far = await note(jobsRoute([dailyJob(5081, 4)]), {
      withinSec: 7200,
    });
    expect(far.fields["timer_warning"]).toBeUndefined();
    expect(far.help).toEqual([]);
    expect(far.fields["timer_left"]).toBe("11h20m");
  });

  it("E146: a failed listing gives an empty note and does not throw", async () => {
    const n = await note({
      "show scheduled-jobs": { stderr: "Traceback: boom\n", exit: 1 },
    });
    expect(n).toEqual({ fields: {}, help: [] });
  });
});

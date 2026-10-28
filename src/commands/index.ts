// The fixed command registry. Every command already has a file here (a stub
// until its unit lands), so a unit adds its command by replacing that one file;
// nobody edits this index or src/cli.ts.
import type { CommandModule } from "./types.js";
import * as home from "./home.js";
import * as search from "./search.js";
import * as status from "./status.js";
import * as rent from "./rent.js";
import * as ssh from "./ssh.js";
import * as logs from "./logs.js";
import * as stop from "./stop.js";
import * as destroy from "./destroy.js";
import * as copy from "./copy.js";
import * as run from "./run.js";
import * as job from "./job.js";
import * as finish from "./finish.js";
import * as raw from "./raw.js";
import * as setup from "./setup.js";
import * as update from "./update.js";

export interface Registry {
  /** Runs for a bare `vast-axi` (the dashboard). */
  home: CommandModule;
  /** Named commands; null-prototype so `constructor` and friends are unknown commands. */
  commands: Record<string, CommandModule>;
}

export const REGISTRY: Registry = {
  home,
  commands: Object.assign(
    Object.create(null) as Record<string, CommandModule>,
    {
      search,
      status,
      rent,
      ssh,
      logs,
      stop,
      destroy,
      copy,
      run,
      job,
      finish,
      raw,
      setup,
      update,
    },
  ),
};

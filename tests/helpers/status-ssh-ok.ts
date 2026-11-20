// A registry whose `status` answers the ssh readiness probe (`status --wait`,
// FR7) with a fake ssh that succeeds, so CLI-level status tests never start
// the real ssh client against fixture addresses (see no-real-ssh.ts).
import { REGISTRY, type Registry } from "../../src/commands/index.js";
import { createStatusCommand, help } from "../../src/commands/status.js";

export const sshOkRegistry: Registry = {
  home: REGISTRY.home,
  commands: Object.assign(
    Object.create(null) as Registry["commands"],
    REGISTRY.commands,
    {
      status: {
        command: createStatusCommand({
          spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          resolveTool: () => "ssh",
        }),
        help,
      },
    },
  ),
};

// Classify what ssh or scp printed when it failed, so the hints fit the cause
// (B6): the ssh-key hint only for an auth failure, a wait hint for a host that
// is not answering yet, and so on.
import type { Endpoint } from "./endpoint.js";

export type SshFailureKind =
  "hostkey" | "auth" | "unreachable" | "path" | "unknown";

const KINDS: Array<[SshFailureKind, RegExp]> = [
  [
    "hostkey",
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i,
  ],
  ["auth", /Permission denied/i],
  [
    "unreachable",
    /Connection (?:refused|reset|timed out|closed)|kex_exchange_identification|No route to host|Operation timed out|Could not resolve hostname|Network is unreachable/i,
  ],
  [
    "path",
    /No such file or directory|path canonicalization failed|Not a directory/i,
  ],
];

/** The first kind whose pattern matches `stderr`, else `unknown`. */
export function classifySshFailure(stderr: string): SshFailureKind {
  for (const [kind, pattern] of KINDS) {
    if (pattern.test(stderr)) return kind;
  }
  return "unknown";
}

/** Hint lines for a failed connection of the given kind. */
export function failureHints(
  kind: SshFailureKind,
  id: number,
  endpoint: Endpoint,
): string[] {
  const status = `Run \`vast-axi status ${id}\` to check the instance is running`;
  const wait = `\`vast-axi status ${id} --wait\` returns once ssh answers`;
  switch (kind) {
    case "auth":
      return [
        "The account needs an ssh key attached on vast.ai for key login to work",
        `Right after boot, ${wait}`,
      ];
    case "unreachable":
      return [
        `sshd on #${id} is not answering (normal for about a minute after boot): ${wait}`,
        status,
      ];
    case "hostkey":
      return [
        `The host key for this address changed (vast.ai reuses ip:port pairs): \`ssh-keygen -R "[${endpoint.host}]:${endpoint.port}"\``,
      ];
    default:
      return [
        status,
        `Test the connection with \`vast-axi ssh ${id} --exec -- true\``,
      ];
  }
}

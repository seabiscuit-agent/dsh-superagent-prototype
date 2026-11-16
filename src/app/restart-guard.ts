/** Shell commands a worker must not use: they stop, restart or replace the DSH host process it runs in. */

/** What a worker is told instead of running such a command. */
export const RESTART_REFUSAL = 'Restarting the DSH host is reserved for the main Session. A worker must report the need in its report or to the main Session instead of stopping or restarting the process.'

/**
 * A simple command's start: the line's start or an operator (`;`, `&&`, a pipe, `(`, a newline), optional `NAME=value`
 * assignments and the prefixes that run a command (`sudo`, `nohup`, `env`, …) — including a shell entered with `-c`, so
 * `bash -c 'tmux respawn-pane -k …'` is refused like the bare command. Matching from here keeps a command quoted in a
 * message, a grep pattern or a commit text from being refused, while the command itself, in whatever directory, is.
 */
const start = String.raw`(?:^|[\n;|&(){}])\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|\S*)\s+)*(?:(?:(?:sudo|nohup|exec|env|command|time|builtin)\s+)|(?:(?:sh|bash|zsh|dash)\s+-[A-Za-z]*c\s+['"]?))*`
const at = (body: string) => new RegExp(`${start}${body}`, 'i')

/**
 * Commands that end or replace the DSH process a worker runs inside (and with it every other worker): tmux pane/session
 * control, killing the node/DSH process, a service manager, the spawner panel's restart/stop/start action, and the
 * deployment's own manager script. This is a default-path guardrail like `executor.blockedCommands`, not an OS-level
 * boundary: a deliberate bypass still succeeds, and only the main Session's own shell is unrestricted.
 */
const RESTART_PATTERNS: readonly RegExp[] = [
  at(String.raw`(?:\S*\/)?tmux\b[^\n]*\b(?:respawn-pane|respawn-window|kill-pane|kill-session|kill-server)\b`),
  at(String.raw`(?:\S*\/)?tmux\b[^\n]*\b(?:new-session|new-window)\b[^\n]*\b(?:dsh|superagent)\b`),
  at(String.raw`(?:\S*\/)?(?:kill|pkill|killall)\b[^\n]*\b(?:dsh|dsh-superagent|superagent|node)\b`),
  at(String.raw`(?:\S*\/)?(?:launchctl|systemctl|service)\b[^\n]*\b(?:dsh|dsh-superagent|superagent)\b`),
  at(String.raw`(?:\S*\/)?(?:Stop-Process|Stop-Service|Restart-Service)\b[^\n]*\b(?:dsh|superagent|node)\b`),
  at(String.raw`(?:\S*\/)?(?:curl|wget|http)\b[^\n]*dsh-superagent-spawner\/api\?[^\n]*\baction=(?:restart|stop|start)\b`),
  at(String.raw`(?:(?:python[0-9.]*|node|sh|bash|zsh)\s+)?(?:\S*\/)?scripts\/dsh-superagent\b[^\n]*\b(?:restart|stop|start)\b`),
]

/**
 * The refusal for a shell tool call that would restart the DSH host, or undefined when the call is allowed. Only the shell
 * tools are read: another tool's arguments are not command text.
 */
export function restartCommand(input?: { name?: string; arguments?: unknown }): string | undefined {
  if (input?.name !== 'bash' && input?.name !== 'pwsh') return undefined
  const command = (input.arguments as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string' || command === '') return undefined
  return RESTART_PATTERNS.some(pattern => pattern.test(command)) ? RESTART_REFUSAL : undefined
}

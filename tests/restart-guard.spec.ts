/** The worker shell guard: a restart of the DSH host is refused, an ordinary command is not. */
import { expect, it } from 'vitest'
import { RESTART_REFUSAL, restartCommand } from '../src/app/restart-guard.ts'

const bash = (command: string) => restartCommand({ name: 'bash', arguments: { command } })

it('refuses the commands that restart or end the host process, through tmux, kill, a service or the panel', () => {
  for (const command of [
    'tmux respawn-pane -k -t dsh-superagent-spawner',
    'tmux kill-session -t dsh-superagent',
    'tmux kill-server',
    'tmux new-session -d -s dsh-superagent "dsh --profile superagent"',
    "kill -9 $(pgrep -f 'dsh --profile superagent')",
    'pkill -f dsh-superagent',
    'killall node',
    'sudo launchctl kickstart -k gui/501/dsh-superagent-spawner',
    'systemctl restart dsh-superagent',
    `curl -X POST 'http://127.0.0.1:3150/dsh-superagent-spawner/api?action=restart&name=superagent' -H 'x-spawner-request: 1'`,
    'scripts/dsh-superagent --profile superagent restart',
  ]) expect(bash(command), command).toBe(RESTART_REFUSAL)
})

it('allows the ordinary commands a worker runs, including reading about restarts', () => {
  for (const command of [
    'npm test',
    'git status --short && git log --oneline -3',
    'tmux ls',
    'kill -0 1234',
    'grep -rn "respawn-pane" docs',
    'cat scripts/dsh-superagent',
    "curl -s 'http://127.0.0.1:3150/dsh-superagent-spawner/api?action=list' -H 'x-spawner-request: 1'",
    'node --test test/*.test.js',
  ]) expect(bash(command), command).toBeUndefined()
})

it('reads only shell commands: another tool, or no command, is left alone', () => {
  expect(restartCommand({ name: 'read', arguments: { path: '/tmp/x' } })).toBeUndefined()
  expect(restartCommand({ name: 'bash', arguments: {} })).toBeUndefined()
  expect(restartCommand({ name: 'pwsh', arguments: { command: 'Stop-Process -Name node' } })).toBe(RESTART_REFUSAL)
})

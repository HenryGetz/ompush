# ompush

Pushover notifications for [oh-my-pi](https://github.com/can1357/oh-my-pi). Your phone now
finds out the moment your agent finishes a prompt or needs its hand held (a tool approval).
Miracles.

It fires exactly two kinds of push, and nothing else:

| Event | Title | Priority | Sound | Quiet hours |
|---|---|---|---|---|
| Prompt finished | `[complete] <project>` | 0 normal | device default | respected |
| Tool approval needed | `[blocked] <project>` | 1 high | `siren` | bypassed |

The message carries the last thing the agent said (truncated — Pushover is not a novel
delivery service), how long you wasted (`elapsed: 12m 3s`), and where it happened:

```
Herdr · ws w1 · pane w1:p3
Standalone · myproj · feature/x
```

Works in plain terminals and inside Herdr panes. Subagents, advisors, and nested `omp` runs
are **silent** — they are children, and they can wait like everyone else. Approval flapping is
debounced. Startup, tool success, and "working..." transitions are not achievements and do not
notify.

## Install

```sh
omp install github:HenryGetz/ompush
```

Restart your session. Done.

No package manager? Fine:

```sh
git clone https://github.com/HenryGetz/ompush ~/.omp/agent/extensions/ompush
```

Hacking on it? `omp plugin link /path/to/ompush` symlinks your checkout in.

## Configure

One file, two keys (mode 600):

```sh
# ~/.config/pushover/env
PUSHOVER_USER=your-user-key
PUSHOVER_TOKEN=your-app-token
```

Resolution order: environment variables → `~/.config/pushover/env` →
`~/.config/opencode/.everynotify.json`. If you already run the opencode notifier, you are
finished — nothing to configure.

Keys are never logged, never in `argv`, never in files other than the one above.

## Fine print

- Delivery is fire-and-forget from a detached process with a 7-second timeout. A dead network
  or a broken key cannot stall, crash, or slow your session. Failures are silent, like your
  last deploy, and recorded in `~/.local/state/omp-pushover/deliveries.log`.
- Every decision (sent / suppressed / held) is logged without message content to
  `~/.local/state/omp-pushover/trace.log`, for when you want to argue with the machine.
- Background jobs are allowed to settle first: one prompt that fans out to ten workers is one
  push when everything is done, not eleven. You're welcome.
- `PUSHOVER_API_BASE` overrides the endpoint for testing.

## Uninstall

```sh
omp plugin uninstall ompush
```

Manual install? Delete the directory. Conscientious objector? `omp plugin disable ompush`, or
add `extension-module:ompush` to `disabledExtensions` in `~/.omp/agent/config.yml`.

## Requirements

omp 18+, `sh`, `curl`, and a Pushover account. Linux or macOS. Windows users may bring
their own `sh`.

## License

MIT. Sarcasm included at no extra cost.

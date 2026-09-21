# opencode-herdr-bridge

Corrects how [Herdr](https://herdr.dev) sees [opencode](https://opencode.ai) panes.

## Problem

One opencode process can hold several root sessions (`ctrl+x n`). Herdr tracks
state per pane, and the official opencode integration reports state from whichever
session emits an event. When a background session finishes while you are working in
another session, the pane flips to `idle`/`done` even though your session is still
running.

Repro (herdr 0.9.1, opencode 1.18.31): session A running `sleep 90`, session B
finishing in the same process, `herdr agent list` polled per second:

```
21:24:23 working seq=37 sess=…0M71Xe
21:24:25 idle    seq=38 sess=…HuH58V   <- B finished, pane reported idle
21:24:27 idle    seq=38 sess=…0M71Xe
21:24:28 working seq=39 sess=…0M71Xe   <- A was working the whole time
```

## What this plugin does

It keeps a model of every root session in the pane and reports one aggregated
state to Herdr:

- `blocked` if **any** session is waiting on a permission or question
- `working` if **any** session is working (or any child session is asking)
- `idle` only when every session is idle

Session identity reported to Herdr follows the most recently active root session.
State is only reported when the aggregate changes, so the socket stays quiet.

## Install

```bash
git clone https://github.com/anaypurohit0907/herdr-opencode-bridge
ln -s "$(pwd)/herdr-opencode-bridge/src/index.js" \
      ~/.config/opencode/plugins/zz-herdr-opencode-bridge.js
```

The `zz-` prefix makes opencode load this plugin after the official
`herdr-agent-state.js` integration, so its reports land last.

Restart opencode. The plugin is inert outside Herdr-managed panes.

## Development

```bash
bun test
```

Set `HERDR_BRIDGE_DEBUG=1` when launching opencode to append a trace to
`/tmp/opencode/herdr-opencode-bridge.log` (events, aggregate changes, report
results, and self-corrections).

All state logic lives in `src/aggregate.js` with no opencode imports, so it is
unit-testable. `src/index.js` is a thin V1 server-plugin wrapper; `src/socket.js`
speaks the newline-delimited JSON pane protocol.

## Verification

Live run with session A inside `sleep 90` and session B (`sleep 20`) finishing in
the same process while A was viewed. `herdr agent list` polled once per second;
the bridge log is `HERDR_BRIDGE_DEBUG=1` output:

```
16:35:16 report state=working seq=…1002 ok=true 2 working
16:35:17 verify mismatch expected=working actual=idle -> correcting
16:35:19 verify mismatch expected=working actual=idle -> correcting
16:35:20 verify mismatch expected=working actual=idle -> correcting
16:36:50 report state=working seq=…1008 ok=true 1 working · 1 idle   <- B finished
16:36:55 report state=idle    seq=…1009 ok=true 2 idle               <- A finished
```

Pane state timeline (one sample per second): `working` held continuously for the
94 seconds covering B's finish. Before the bridge the same reproduction flashed
`idle` for ~2 seconds at that moment (see herdrdev/herdr#4454).

Known cosmetic race: during the burst where a session is created while another is
already working, the official reporter can still win one round and show `idle` for
up to ~1 second before the correction pass restores `working`.

## Background

Reported upstream as [herdrdev/herdr#4454](https://github.com/herdrdev/herdr/issues/4454)
and triaged `bug` / `p2` / `maintainer-needed`. This plugin is the user-space fix
for the same problem while the official integration decides its own semantics.

## Roadmap

- subscribe to herdr `events.subscribe` to correct drift event-driven instead of polling
- `pane.report_metadata` tokens (`$oc_sessions`, `$oc_attention`) for sidebar rows
- opt-in `notification.show` for background sessions that need attention
- TUI-side selection reporting (V2) so session identity follows the visible session

## License

MIT

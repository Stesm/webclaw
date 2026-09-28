<p align="center">
  <img src="docs/assets/zeroclaw-banner.png" alt="webclaw" width="600" />
</p>

<h1 align="center">🦀 webclaw — web-first ZeroClaw fork</h1>

<p align="center">
  <strong>ZeroClaw, driven entirely from its web dashboard — no chat channel required.</strong>
</p>

> **This is a fork.** `webclaw` is an independent, unaffiliated fork of
> [**zeroclaw-labs/zeroclaw**](https://github.com/zeroclaw-labs/zeroclaw).
> The upstream runtime is kept intact; this fork layers a web-first workflow on
> top of it. All install, deployment, configuration, and usage documentation
> lives in the upstream repository — follow the links below.
>
> Mirrors: [github.com/Stesm/webclaw](https://github.com/Stesm/webclaw) ·
> [git.alfastat.ru/root/webclaw](https://git.alfastat.ru/root/webclaw)
>
> Base: upstream `master` @ `d8d5d93f5` (package `v0.8.5`) + a short stack of
> fork commits on `fork-work`.

<p align="center">
  <a href="LICENSE-APACHE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-edition%202024-orange?logo=rust" alt="Rust Edition 2024" /></a>
</p>

<p align="center">
  <a href="https://github.com/zeroclaw-labs/zeroclaw">Upstream</a> ·
  <a href="https://docs.zeroclaw.com/master/en/introduction.html">Upstream docs</a> ·
  <a href="docs/book/src/getting-started/quickstart.md">Upstream quick start</a> ·
  <a href="https://github.com/zeroclaw-labs/zeroclaw/issues">Upstream issues</a>
</p>

---

## What this fork is

ZeroClaw is an agent runtime — a single Rust binary that talks to LLM providers,
reaches the world through 30+ channels, and acts through tools. Upstream assumes
you reach the agent through a chat channel (Discord, Telegram, Matrix, email, …)
or the terminal.

This fork makes the **web dashboard the primary client**. You configure a
provider and an agent, start the gateway, and drive the agent from the browser.
No chat-channel adapter is required for the core loop to work. Around that
premise the fork fixes a set of web-client behaviour gaps in the upstream
gateway and dashboard.

Everything else — providers, tools, memory, security policy, the SOP engine,
hardware, ACP — is upstream and unchanged.

## Fork differences

### Web-first, channel-free operation
- **No channel required.** Run the agent entirely through the gateway web
  client; Discord / Telegram / Matrix / email adapters are optional.
  *(commit `9f2da7892`)*

### Background turns (the agent outlives the browser tab)
- **Turns survive client disconnect.** Closing or switching away from a browser
  tab no longer cancels the running turn — the agent keeps working server-side,
  persists the answer, and the reopened client re-hydrates it. The explicit
  **Stop** button still cancels. *(upstream WS `cancel` on close removed in
  `9f2da7892`; abort-on-session-switch removed in `2950846c8`)*
- **Background answer reaches the open chat.** A `turn_done` broadcast makes a
  client that returned mid-turn re-hydrate the transcript automatically, instead
  of showing a session stuck on "typing". *(in `9f2da7892`)*
- **Partial answer is kept on Stop.** Interrupting a turn preserves the text the
  operator already saw, instead of leaving only `[interrupted by user]`.
  *(commit `04caff5cf`)*

### Dashboard
- **Extended dialog list.** Session list shows a first-message preview, supports
  inline rename, and deep-links straight into a chat pane.
- **All of an agent's sessions, and a live cron transcript.** The session picker
  lists every session the agent owns — channel sessions (e.g. Mattermost) open
  **read-only** in a transcript viewer, gateway web sessions open for input. Cron
  jobs get a **"View run log"** button that opens the current/most-recent agent
  run as a chat-style transcript, polled live while the run is in progress.
  *(commits `e30ca9ca`, `c4d899d2`)*
- **Stable thread keys.** Live turn progress no longer remounts (and replays the
  entry animation of) the whole thread on each update. *(commit `82a9f2411`)*

### Attachments & PWA
- **Agent-sent attachments with previews.** The agent can send files to the
  client; they render as inline cards with a preview modal. Content-Security
  Policy allows `blob:` for image previews. *(commit `b5e8acbbb`)*
- **PWA manifest.** The dashboard installs as a standalone web app
  (manifest + icons + `theme-color`). *(commit `be0feefc6`)*

## Installing and running

Build, install, configure, and operate this fork **exactly as upstream** — see:

- **Install** — upstream [`README → Install`](https://github.com/zeroclaw-labs/zeroclaw#install) and the [installation guide](https://docs.zeroclaw.com/master/en/getting-started/quickstart.html#install)
- **Quick start** — upstream [Quick start](docs/book/src/getting-started/quickstart.md) (`zeroclaw quickstart`, then `zeroclaw agent -a <alias>`)
- **Deployment / service** — upstream [setup guides](docs/book/src/setup/linux.md) (Linux · macOS · Windows · FreeBSD · NixOS · Docker) and `zeroclaw service install|start`
- **Gateway & dashboard** — upstream [Gateway](docs/book/src/architecture/overview.md) docs; this fork's differences assume the web dashboard as the client
- **Configuration** — upstream [`~/.zeroclaw/config.toml` reference](https://docs.zeroclaw.com/master/en/reference/config.html)

### Building this fork

The only fork-specific build note is that the web client and the dashboard
behaviour changes live under `web/`, so produce the frontend bundle alongside the
backend. Use the upstream toolchain and feature selection, for example:

```bash
git clone https://github.com/Stesm/webclaw.git && cd webclaw
git checkout fork-work

# backend (adjust --features to the channels you actually use)
cargo build --release --features "gateway"

# frontend (Node 24+)
source ~/.nvm/nvm.sh && nvm use 24
cd web && npm ci && npm run build
```

Deployment, service registration, and reverse-proxy/TLS setup are upstream
concerns — follow the upstream setup guides linked above.

## Upstream & impersonation notice

The upstream project is maintained at:

> <https://github.com/zeroclaw-labs/zeroclaw>

This fork is an independent, unaffiliated derivative of that project. The
**ZeroClaw** name and logo remain trademarks of ZeroClaw Labs. Do not report
this fork's issues to upstream; see the mirrors above.

## License

Dual-licensed: [MIT](LICENSE-MIT) OR [Apache 2.0](LICENSE-APACHE). You may choose
either. Contributors automatically grant rights under both — see
[CLA](docs/book/src/contributing/cla.md). The **ZeroClaw** name and logo are
trademarks of ZeroClaw Labs.

## Credits

The runtime is built and maintained by the upstream ZeroClaw community — original
creator [@theonlyhennygod](https://github.com/theonlyhennygod); project lead
[@JordanTheJet](https://github.com/JordanTheJet). Full maintainer list in
[Communication](docs/book/src/contributing/communication.md). This fork tracks
that project and adds the web-first layer described above.

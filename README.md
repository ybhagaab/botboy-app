# BotBoy

Your local, private productivity brain for macOS. BotBoy watches the work you
choose to share with it (Slack, Outlook via GRASP, local folders, browser),
organizes everything into projects with synthesized "brains", and gives you a
chat assistant that actually knows your work. Everything runs and stays on
your Mac.

## Install

```bash
git clone https://github.com/ybhagaab/botboy-app.git
cd botboy-app
./start.sh
```

First launch installs dependencies and builds automatically (a few minutes).
You also need a personal credentials file from the owner — full steps,
prerequisites, and troubleshooting: **[docs/TEAMMATE_SETUP.md](docs/TEAMMATE_SETUP.md)**.

## Update

```bash
git pull
./start.sh
```

The launcher detects the new version and rebuilds on its own.

## Help

Run `./start.sh --doctor` and send the output to the owner.

---
*This repository is the app distribution. It receives release snapshots; development happens elsewhere.*

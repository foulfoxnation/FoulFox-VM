# Building the ISO in the cloud (no Linux machine needed)

You don't need your own Linux box to produce a FoulFox OS image. A GitHub
Actions workflow (`.github/workflows/build-foulfox-os.yml`) builds the `.iso` for
you on a fresh Linux runner and hands you a download link. You click, it builds
the **latest committed code**, you download and flash.

This is the recommended path. It always reflects the current state of the
project, so as the appliance keeps evolving, every build picks up the newest
work automatically.

## One-time setup: put the repo on GitHub

The build runs on GitHub, so the project has to live there.

1. In Replit, open the **Version control / Git** pane.
2. Choose **Create a GitHub repository** (or connect to an existing one) and
   authorize Replit. A private repo is fine.
3. Push. This uploads everything, including the workflow file under
   `.github/workflows/`.

GitHub automatically detects the workflow — no extra configuration.

## Generate an ISO (the "click")

Every time you want a fresh image:

1. **Commit + push** your latest changes in Replit's Git pane. (The cloud build
   only sees what's on GitHub, so push first — this is how it stays "the most up
   to date image".)
2. On GitHub, open the **Actions** tab.
3. Pick **Build FoulFox OS ISO** in the left sidebar.
4. Click **Run workflow**, choose the branch (usually `main`), and confirm.
5. Wait for it to finish (roughly 30–90 minutes — it downloads a full Debian
   package set and assembles the image).

## Download it

When the run goes green, there are two ways to get the ISO:

- **Run artifact** *(always available)* — open the workflow run and download the
  `foulfox-os-iso-…` artifact. It's named with the build timestamp and the
  commit short-SHA, and is kept for 14 days. This is the guaranteed download and
  works no matter how large the image is.
- **Rolling "latest" release** *(convenience link)* — go to the repo's
  **Releases** and open **FoulFox OS – latest build** → download
  `foulfox-os-latest.iso`. Its assets are replaced on every build, so this link
  always points at the newest image.
  GitHub caps a single Release asset at ~2 GiB, so if the image grows past that
  the workflow **skips the release and tells you so in the run summary** — just
  use the run artifact above. (Your build stays green either way.)

Each download ships with a matching `.sha256`. Verify before flashing:

```bash
sha256sum -c foulfox-os-latest.iso.sha256
```

Then continue to **flash.md** to write it to a USB stick, and **first-boot.md**
to boot it.

## Triggers

- **Manual** — the **Run workflow** button (above). Leave *"Also publish to the
  rolling release"* checked to refresh the always-latest download link.
- **By tag** — pushing a tag like `os-v1.0` also runs a build and refreshes the
  same rolling `foulfox-os-latest` release. The tag is a convenient bookmark for
  "the image as of this milestone"; the downloadable ISO still lives on the
  rolling release / run artifact.

## If a build fails

The run uploads the live-build log as a **build-log** artifact when it fails.
Download it to see exactly where `live-build` stopped. Most failures are either a
transient Debian mirror hiccup (just re-run) or disk space — the workflow already
frees the runner's preinstalled toolchains before building to make room.

## Building locally instead

Prefer to build on your own amd64 Linux host (or a Linux VM / WSL2)? That path
still works — see **build.md** for the one-command local build.

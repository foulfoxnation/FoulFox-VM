---
name: Shell → Python stdin gotcha (heredoc vs -c)
description: Feeding piped stdin to an inline Python program in a shell script — why `python3 - <<EOF` silently discards the pipe.
---

When a shell script pipes data into an inline Python program, you MUST use
`producer | python3 -c '<program>'`. Do NOT use `producer | python3 - <<'EOF' … EOF`.

**Why:** With `python3 - <<'EOF'`, the heredoc becomes the process's stdin, and
`-` tells Python to read its *program* from stdin. The heredoc wins the stdin
slot, so Python reads the heredoc as the program and the piped producer output is
discarded entirely. Inside such a program, `json.load(sys.stdin)` sees empty
input → raises → any `except: sys.exit(0)` path makes the script silently
"succeed" while doing nothing. This bit the FoulFox VM-autostart script: the
default VM was never started because the `/api/vm/list` JSON never reached the
parser. `bash -n` and parser-only unit tests do NOT catch it — the bug lives in
the *shell construction*, so reproduce the exact `producer | python3 …` pipeline.

**How to apply:** For piped JSON parsing in shell, use `curl … | python3 -c '…'`
(stdin stays the pipe). Reserve heredocs for when there is no piped stdin to
consume. When verifying, smoke-test the real pipeline, not just the Python body.

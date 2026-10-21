# Known Issues

This page lists known Easel issues and workarounds. If your problem is not covered, please open an [Issue](https://github.com/ZJU-REAL/Easel/issues).

---

## Platform login and account verification

- **Waiting forever after scanning a QR code**: scanning is not login completion; confirm in the mobile app. Easel marks success only when the platform API returns the current account or the page clearly shows a logged-in view.
- **Avatar or name belongs to another account**: account cards read only the current account region or official account API, never the admin avatar or unrelated users in the feed.
- **Identity is blank after a successful scan**: the login browser must save and release its profile directory before verification. Network errors and blank pages keep the last verified identity instead of reporting logout.
- **QR refresh or network interruption**: clicking login again terminates the old login process first, then requests a new QR code. If retries keep failing, check the server's network access to the platform domains.
- **Xiaohongshu reports an IP risk**: the platform may apply risk controls to data-center networks or automation. Verify the site is reachable from a trusted network; on a desktop, run `xhs_publish.py login --headed --no-proxy` to see the platform's original message. Never share cookies or browser profiles.
- **WeChat Official Account is not logged in**: publishing uses a separate QR session. Log in on the Accounts page before automated publishing.

---

## Models and chat

- **No model available**: add a provider under Settings → Model configuration → Chat → pi providers, or run `pi` and `/login`, or set `EASEL_DIRECT_API_KEY`, `EASEL_DIRECT_API_BASE_URL`, and `EASEL_DIRECT_API_MODEL` in `.env`.
- **Third-party OpenAI-compatible endpoint times out**: make sure the base URL includes `/v1`, the model supports streaming and tool calls, and local endpoints bypass external HTTP proxies.
- **Continue after a disconnect**: the web app replays events from `outputs/_pi/jobs/<turnId>.jsonl`, so a refresh does not lose completed content.
- **A tool was denied**: check the pi sandbox permission in Settings. `read-only` blocks writes and command execution; switch to `workspace-write` to run project scripts.
- **An old session cannot continue**: histories from non-pi runtimes are not migrated. Create a new pi session.

---

## Media and publishing

- **Python dependencies are missing**: run `bash setup.sh`, or `.venv/bin/python -m pip install -e .`.
- **Publishing times out**: video processing, uploads, and platform review can exceed a single request budget. Verify the media plays and its size is reasonable, then retry.
- **How to use a manual publish package**: unzip it, paste the title/body on the official platform page, upload the files in `media/`, review the preview, and publish yourself. Exporting is not publishing.
- **Automated publishing risk**: automated publishing performs real account actions and platforms may require SMS verification or trigger risk controls. Review content with `EASEL_PUBLISH_MODE=manual` first.

---

## When reporting an issue

Include:

- OS, Node.js, and Python versions;
- `easel doctor` output;
- the last few dozen lines of redacted `outputs/_pi/jobs/*.jsonl` or platform logs;
- reproduction steps and expected behavior.

Remove cookies, API keys, QR tokens, account identities, and full login redirect URLs before posting.

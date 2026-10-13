# Souty — project rules for Claude

## "publish" workflow

When the user says **publish** in chat, that is approval to run all of the steps below, in order, without asking again. Stop and report if any step fails (build error, push rejected, `gh` auth error) — never skip a step silently.

1. **Commit the changes**
   - Review `git status` / `git diff` first so the commit message reflects what actually changed.
   - Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …), with a body explaining *why* when it isn't obvious.
   - Bump `version` in `package.json` using semver: patch for bug fixes, minor for new features, major for breaking changes. Put the version in the commit subject, e.g. `fix: … (v1.0.2)`.

2. **Update `README.md`**
   - Only change sections affected by this release (features, settings, models, hotkeys, install steps, version/download references).
   - Commit it separately as `docs: …`, or together with step 1 if the change is small.

3. **Publish to GitHub**
   - `git push origin main`.

4. **Create a GitHub release**
   - Build the installer: `npm run dist` → `dist/Souty-Setup-<version>.exe`.
   - Compute its SHA-256 (`certutil -hashfile <file> SHA256` or `sha256sum`).
   - Create the release with tag `v<version>` and title `Souty v<version>`, attaching the installer:
     `gh release create v<version> "dist/Souty-Setup-<version>.exe" --title "Souty v<version>" --notes-file <notes.md>`
   - Release notes follow the format of the previous release (`gh release view --json body` to copy it):
     - Promo video link + one-line tagline at the top
     - `## What's new in <version>` — user-facing changes since the last tag (`git log <last-tag>..HEAD`), grouped as **New**, **Improved**, **Fixed**. Write from the user's point of view (what they'll notice), not internal function names.
     - `## Install` — download step + the SmartScreen "More info → Run anyway" note + API key links
     - `## Highlights` — keep in sync with the README
     - `## Verify your download` — the SHA-256 from above
   - Share the release URL with the user when done.

# Contributing to browsers-flatpak

Thanks for helping maintain the browser Flatpak definitions published by this
project. A definition combines executable downloads, desktop integration,
sandbox permissions, and repository metadata, so seemingly small changes can
affect both security and installation behavior.

Use root-relative paths in documentation, issues, and pull requests. For
example, use `browsers/firefox/dev/dev.piquark6046.Firefox.Dev.yaml`, not only
`dev.piquark6046.Firefox.Dev.yaml`.

## Repository Layout

Add definitions using the following nested browser-family and release-channel
structure:

| Path | Purpose |
| --- | --- |
| `browsers/<browser>/<channel>/` | One browser release channel, such as `firefox/dev`. |
| `browsers/<browser>/<channel>/<app-id>.yaml` | Flatpak manifest, modules, permissions, sources, and `x-checker-data`. |
| `browsers/<browser>/<channel>/files/` | Desktop, AppStream, icon, service, search-provider, and distribution assets. |
| `browsers/<browser>/<channel>/langpack.json` | Sorted language-code allowlist used to resolve checksum-pinned language packs ephemerally. |
| `browsers/<browser>/<channel>/linter.json` | Narrow, reviewed Flatpak linter exceptions. |
| `browsers/<browser>/<channel>/*.flatpakref` | Installation reference targeting the Pages-hosted repository. |
| `.github/workflows/` | Definition checks, builds, and Pages deployment. |

Directories such as `build/`, `.flatpak-builder/`, `repo/`, and temporary
workflow-patched manifests are generated output and must not be committed.

## Contribution Workflow

1. Create a branch and identify the affected browser definition, shared policy,
   documentation, or workflow. Do not commit directly to the default branch.
2. Make the smallest change that preserves the application ID, installation
   reference, desktop metadata, and supported architectures unless the pull
   request intentionally changes one of those contracts.
3. Update related assets, source lists, linter exceptions, and documentation
   in the same pull request when needed.
4. Build and lint the affected definition. Record each command run and explain
   any architecture or check that could not be exercised locally.
5. Open a focused pull request and wait for the required GitHub Actions checks.

Do not commit a browser version or checksum merely to mirror a scheduled Pages
deployment. The publication workflow resolves those upstream values in its
temporary workspace. Changes to the tracked manifest rules, permissions,
assets, or automation still require review through a pull request.

## Local Build and Validation

After a browser definition exists, use its real manifest path. For example:

```sh
manifest_path=browsers/firefox/dev/dev.piquark6046.Firefox.Dev.yaml

flatpak-builder --force-clean --user \
  --install-deps-from=flathub \
  build/firefox-dev "${manifest_path}"
flatpak-builder-lint manifest "${manifest_path}"
git diff --check
```

Use the runtime and SDK declared by the manifest and build every architecture
available on the local host. Repository linting should apply the package's
reviewed `linter.json` only where an exception is documented. GitHub Actions
remain authoritative for architectures or signing steps unavailable locally.

## Automation and GitHub Pages

Tracked definitions are stable inputs; published browser versions are derived
outputs. Pull-request workflows validate the checked-in manifests and assets.
A scheduled or manually dispatched publication workflow will:

1. Check out the source revision without write credentials.
2. Download upstream release metadata and patch URLs, checksums, and generated
   source lists only in the runner workspace.
3. Build each definition for its configured architectures, update and lint the
   Flatpak repository, and sign it using protected Actions secrets.
4. Upload the completed repository as a GitHub Pages artifact and deploy that
   artifact with the Pages deployment environment.

The workflow must never run `git commit` or `git push`, create a branch, open a
pull request, or retain patched manifests as repository source. It must not
publish through a generated-content branch. The source revision, workflow run,
logs, and Pages deployment record provide publication provenance.

Keep workflow permissions minimal: source-checking jobs need read-only
repository access, while only the deployment job receives the permissions
required for Pages. Never print signing keys or passphrases to logs or include
them in uploaded artifacts.

## Commit Messages

Use Conventional Commits:

```text
<type>(<scope>): <subject>
```

- `type` must be one of `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`,
  `security`, `tests`, or `perf`.
- `scope` names the affected browser or responsibility, such as `firefox-dev`,
  `firefox-nightly`, `pages`, `workflows`, or `docs`.
- `subject` is a short imperative summary using a present-tense verb. Do not
  use past-tense or past-perfect wording.
- In titles and detailed descriptions, wrap code keywords, paths, commands,
  configuration keys, identifiers, and literal values in backticks.

Valid examples:

```text
feat(firefox-dev): add `aarch64` source
security(firefox-nightly): restrict `--filesystem` access
ci(pages): deploy generated repository artifact
docs(contributing): document `GitHub Pages` deployment
```

## Security Requirements

- Use upstream HTTPS sources and cryptographic checksums. Keep checker patterns
  narrow enough to select the intended browser, channel, architecture, and
  locale.
- Grant only required Flatpak `finish-args`. Explain additions or expansions
  to filesystem, device, socket, D-Bus, or network access.
- Review executable scripts, desktop actions, service files, AppStream data,
  and remote installation URLs as security-relevant inputs.
- Keep signing keys, passphrases, tokens, and other credentials in protected
  GitHub environments or secrets. Never commit them.
- Do not commit downloaded archives, generated repositories, build caches, or
  locally patched workflow inputs.

## Pull Request Checklist

Before marking a pull request ready:

- Commit messages follow the documented Conventional Commits format.
- The description identifies the affected browser, channel, and architecture.
- Relevant local builds and linters passed, or skipped checks are explained.
- Source URLs and checksums match the intended upstream artifacts.
- Permission changes include their necessity and security impact.
- Related metadata, installation references, assets, and documentation remain
  consistent.
- No generated build, repository, credential, or transient patch data is
  included.

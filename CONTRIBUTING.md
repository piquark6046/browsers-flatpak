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

Install the JavaScript dependencies with the declared pnpm version and frozen
lockfile, while continuing to use the repository's npm-script interface:

```sh
corepack enable
pnpm install --frozen-lockfile
npm run check
```

The pull-request workflow performs fast TypeScript, lint, test, and whitespace
checks, then resolves and builds both the tracked Firefox revision and the live
latest revision for `x86_64` and `aarch64`. When the revisions have the same
output fingerprint, the build matrix deduplicates them.

## Automation and GitHub Pages

Tracked definitions are stable inputs; published browser versions are derived
outputs. Pull-request workflows validate the checked-in manifests and assets.
A scheduled, relevant-push, or manually dispatched publication workflow will:

1. Check out the source revision without write credentials.
2. Resolve the product-details revision and both architecture redirects,
   verify Mozilla's detached signatures on `SHA256SUMS` and `SHA512SUMS`, and
   patch URLs, checksums, AppStream releases, and language sources only in the
   runner workspace.
3. Compare the derived output fingerprint with the signed
   `publication-state.json`. An unchanged fingerprint skips publication.
4. Build the selected definition natively for `x86_64` and `aarch64` into
   separate unsigned repositories.
5. In the protected `flatpak-signing` environment, import the verified build
   repositories as new commits, sign commits and summary metadata, update and
   lint the repository, and stage a link-free Pages artifact.
6. Deploy that artifact from the separate `github-pages` environment.

The workflow must never run `git commit` or `git push`, create a branch, open a
pull request, or retain patched manifests as repository source. It must not
publish through a generated-content branch. The source revision, workflow run,
logs, and Pages deployment record provide publication provenance.

Keep workflow permissions minimal: source-checking jobs need read-only
repository access, while only the deployment job receives the permissions
required for Pages. Never print signing keys or passphrases to logs or include
them in uploaded artifacts.

The published site contains its landing page and installation reference at the
site root, the Flatpak repository below `/repo/`, the repository public key,
and signed publication state. The repository normally retains the current and
previous commit for each ref and generates static deltas. If the staged site
would exceed the 900 MiB project budget, automation removes the oldest history
and deltas and retries with only current refs. It fails instead of removing the
current revision.

### Manual publication controls

The `Publish resolved Flatpak repository` workflow supports four manual
inputs:

- `version` selects an exact Firefox Developer Edition beta. Omitting it uses
  the consistent live-latest revision.
- `force` rebuilds even when the signed output fingerprint is unchanged.
- `allow_downgrade` permits an exact-version rollback. A downgrade otherwise
  fails closed.
- `bootstrap` permits the first deployment only when both publication-state
  files are absent. It does not bypass malformed, incomplete, or
  invalidly-signed state.

Normal schedules and pushes cannot set these controls. Use exact-version
rollback deliberately and restore a newer revision with another reviewed run
when the rollback is no longer required.

### Repository signing

The repository uses an offline, non-expiring Ed25519 certification key and an
Ed25519 CI signing subkey with a three-year expiry. Generate a new key set from
a trusted local checkout:

```sh
npm run key:provision
```

The command refuses to overwrite an existing export directory. It writes
private recovery exports, a revocation certificate, the protected CI subkey,
and ready-to-store secret values under
`.agents/temp/browsers-flatpak-signing-key/`. Move that directory to encrypted
offline storage. Only these public outputs remain in the repository:

- `devops/keys/browsers-flatpak-signing-key.asc`
- `devops/keys/browsers-flatpak-signing-key.fingerprint`
- `browsers/firefox/dev/dev.piquark6046.Firefox.Dev.flatpakref`

Create a `flatpak-signing` GitHub environment restricted to the default branch
and set `FLATPAK_GPG_SECRET_SUBKEY_B64` and `FLATPAK_GPG_PASSPHRASE` from
`github-actions-secrets.env` as environment secrets. Never store the full
primary secret key in GitHub. Provision and test a replacement CI signing
subkey before the current subkey expires. During rotation, keep the preceding
subkey in the public export and in the comma-separated `TrustedSigning` list
until a state signed by the replacement has been deployed; `Signing` always
names the active CI subkey. Changing the primary repository key also requires
updating the public export and every installation reference as a separately
reviewed trust migration.

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

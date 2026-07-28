# Repository Guidelines

## Project Overview

`browsers-flatpak` is intended to collect Flatpak definitions for web browsers
and publish the resulting Flatpak repository through GitHub Pages. Tracked
manifests, metadata, and assets are reviewable source inputs. GitHub Actions
will resolve current upstream metadata in an ephemeral workspace, build and
validate the derived repository, and deploy it as a Pages artifact. Automation
must not commit, push a branch, or open an update pull request.

Treat browser downloads, checksums, Flatpak sandbox permissions, signing
material, and Pages publication as security-sensitive. Keep changes narrow and
make permission or trust-boundary changes explicit.

## Repository Structure

The repository is still in its bootstrap stage; definitions and workflows have
not been added yet. Use this layout as they are introduced:

- `browsers/<slug>/`
  - One browser or release channel, such as `firefox-dev`.
- `browsers/<slug>/<app-id>.yaml`
  - The Flatpak manifest and its upstream-source checker metadata.
- `browsers/<slug>/files/`
  - Desktop files, AppStream metadata, icons, service files, and other inputs.
- `browsers/<slug>/generated-sources.json`
  - A checked-in source-list baseline when the definition requires one.
- `browsers/<slug>/linter.json`
  - Reviewed, package-specific linter exceptions.
- `browsers/<slug>/*.flatpakref`
  - The installation reference for the Pages-hosted repository.
- `.github/workflows/`
  - Pull-request validation and artifact-based Pages publication.

Build directories, patched workflow copies, and generated OSTree repositories
are outputs, not source contributions. Refer to files with root-relative paths.

## Contributor Guidance

`CONTRIBUTING.md` is the source of truth for contributor and automation policy:

- [Contribution Workflow](CONTRIBUTING.md#contribution-workflow)
- [Local Build and Validation](CONTRIBUTING.md#local-build-and-validation)
- [Automation and GitHub Pages](CONTRIBUTING.md#automation-and-github-pages)
- [Commit Messages](CONTRIBUTING.md#commit-messages)
- [Security Requirements](CONTRIBUTING.md#security-requirements)
- [Pull Request Checklist](CONTRIBUTING.md#pull-request-checklist)

If the two files diverge, follow `CONTRIBUTING.md`. Update this file only when
repository orientation or agent-specific guidance changes.

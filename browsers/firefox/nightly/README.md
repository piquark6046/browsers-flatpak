# Firefox Nightly

This definition packages the official Firefox Nightly Linux binaries without
modifying the browser payload. It is an independently maintained Flatpak
definition and is not supported by Mozilla. Its Flatpak ID is
`dev.piquark6046.Firefox.Nightly`, outside Mozilla's application namespace.

## Source baseline

The checked-in baseline is Firefox Nightly `155.0a1`, Mozilla build
`20260728214328` from 2026-07-28:

| Architecture | Immutable Mozilla archive | SHA-256 |
| --- | --- | --- |
| `x86_64` | `2026-07-28-21-43-28-mozilla-central/firefox-155.0a1.en-US.linux-x86_64.tar.xz` | `282c556d1dcfe0ca20cb82f6d07281b0d08ee9ded614cec002b4009c4a2f6946` |
| `aarch64` | `2026-07-28-21-43-28-mozilla-central/firefox-155.0a1.en-US.linux-aarch64.tar.xz` | `0dbc90109c88b99458040783774f08fc3c4615c69de7f748392e77c6ae83765a` |

Both Buildhub records identify the same `mozilla-central` revision:
`35ea03d3f87c2168fc7b4f5fca8dc8824b2c1cc2`. The archive hashes were
checked against Mozilla's per-build checksum files, and each detached archive
signature was verified with the Mozilla Software Releases key:

- Primary fingerprint:
  `14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353`
- Signing subkey:
  `09BE ED63 F346 2A2D FFAB 3B87 5ECB 6497 C1A2 0256`

`langpack.json` is a sorted `string[]` allowlist containing all 113 language
codes offered by the selected Nightly localization build, excluding bundled
`en-US`. It intentionally contains no URLs, checksums, destination paths, or
Flatpak source objects. DevOps preprocessing resolves each code against the
matching immutable localization build and injects checksum-pinned XPI sources
into the manifest.

## Payload invariant

Flatpak Builder strips the archive's single leading `firefox/` component and
copies every remaining entry to `/app/lib/firefox` with `cp -a`. The definition
does not rewrite scripts, delete updater files, or replace Mozilla's official
`distribution.ini`.

The checked-in manifest has no resolved language-pack sources, so direct builds
contain only Mozilla's bundled `en-US` locale and add no language-pack
symlinks. After devops preprocessing, XPI files live under
`/app/share/runtime/locale/` and the only locale-related additions below
`/app/lib/firefox` are `distribution/extensions/` and its symlinks. Icons are
copied from the verified archive to the Flatpak export path without altering
their originals.

## Sandbox permissions

The permissions follow Mozilla's Firefox Flatpak packaging and are kept
explicit because several are broad:

| Permission | Purpose and security impact |
| --- | --- |
| `--allow=devel`, `--device=all` | Support browser process features and web-facing hardware APIs; these broaden process and device access. |
| `--share=ipc`, Wayland, and fallback X11 | Provide browser windows and shared-memory rendering; X11 clients have weaker isolation than Wayland clients. |
| Network and PulseAudio sockets | Provide normal web access and browser audio. |
| PC/SC and CUPS sockets | Support smart cards and printing. |
| `--persist=.mozilla` | Preserve browser profiles in the app-specific Flatpak data directory. |
| Writable `xdg-download` | Allow browser-managed downloads without granting wider home-directory access. |
| Read-only GTK and speech-dispatcher paths | Reuse host appearance and accessibility configuration. |
| Kerberos socket path | Permit integrated authentication when configured by the host. |
| FileManager, accessibility, GVfs, and NetworkManager D-Bus access | Provide file integration, accessibility, virtual filesystems, and network-state awareness. |
| Implicit app-ID and explicit Firefox MPRIS bus ownership | Provide single-instance remoting and media controls without access to the complete session bus. Flatpak grants the app-ID namespace automatically. |

`dev.piquark6046.Firefox.Nightly.systemconfig` reserves `/app/etc/firefox` for
optional administrator-supplied configuration. No policy is bundled and the
extension is not downloaded automatically.

`linter.json` records four reviewed exceptions. The requested application-ID
domain, `https://piquark6046.dev`, is not currently published, and the
read-only GTK configuration permission intentionally follows Mozilla's Firefox
Flatpak packaging. The package does not include screenshots, and this
independent Pages repository does not publish screenshot media through
Flathub's `dl.flathub.org` mirror.

## Publication contract

Publication automation may patch only ephemeral copies of these dynamic
values:

- Both archive URLs and SHA-256 hashes in
  `dev.piquark6046.Firefox.Nightly.yaml`.
- The Nightly version and build date in the AppStream metadata.
- The empty `language-packs.sources` list, populated from `langpack.json` with
  matching immutable URLs, destination filenames, and SHA-512 hashes.

The resolver requires both architecture Buildhub records to identify the same
build ID, version, timestamp, and source revision. It verifies archive
signatures and requires every selected language pack to belong to that build.
Patched values never return to the source checkout.

The generated repository is signed with the public key embedded in
`dev.piquark6046.Firefox.Nightly.flatpakref` and published below `/repo/` on
the project's GitHub Pages site. The signed `publication-state.json` records
the Nightly build ID and source revision in addition to the exact output
fingerprint and workflow provenance.

Firefox, Firefox Nightly, and the Firefox logo are trademarks of Mozilla. See
Mozilla's
[distribution policy](https://www.mozilla.org/foundation/trademarks/distribution-policy/)
for redistribution requirements.

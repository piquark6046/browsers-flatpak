# Firefox Developer Edition

This definition packages the official Firefox Developer Edition Linux binaries
without modifying the browser payload. It is an independently maintained
Flatpak definition and is not supported by Mozilla. Its Flatpak ID is
`dev.piquark6046.Firefox.Dev`, outside Mozilla's application namespace.

## Source baseline

The checked-in baseline is Firefox Developer Edition `154.0b2`, released on
2026-07-24:

| Architecture | Mozilla release path | SHA-256 |
| --- | --- | --- |
| `x86_64` | `linux-x86_64/en-US/firefox-154.0b2.tar.xz` | `4008a397efae1ec0a057f84239ea58bbe6fcfa3c5cf7ca4c983afbdda3fa50a2` |
| `aarch64` | `linux-aarch64/en-US/firefox-154.0b2.tar.xz` | `3630b0a17031c5d6db4b5e6773969d138f2fc7cfcf89a74088df4dbbadc97b4a` |

The hashes come from Mozilla's signed `SHA256SUMS`, verified with the Mozilla
Software Releases key:

- Primary fingerprint:
  `14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353`
- Signing subkey:
  `09BE ED63 F346 2A2D FFAB 3B87 5ECB 6497 C1A2 0256`

`langpack.json` is a sorted `string[]` allowlist containing 102 language codes,
excluding the bundled `en-US` locale. It intentionally contains no URLs,
checksums, destination paths, or Flatpak source objects. Future devops
preprocessing will resolve each code against Mozilla's signed `SHA512SUMS` and
inject checksum-pinned sources into the manifest's `language-packs` module.

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

`dev.piquark6046.Firefox.Dev.systemconfig` reserves `/app/etc/firefox` for
optional administrator-supplied configuration. No policy is bundled and the
extension is not downloaded automatically.

`linter.json` records two reviewed exceptions. The requested application-ID
domain, `https://piquark6046.dev`, is not currently published, and the
read-only GTK configuration permission intentionally follows Mozilla's Firefox
Flatpak packaging.

## Publication contract

Future publication automation may patch only ephemeral copies of these dynamic
values:

- Both archive URLs and SHA-256 hashes in
  `dev.piquark6046.Firefox.Dev.yaml`.
- The release version and date in the AppStream metadata.
- The empty `language-packs.sources` list, populated from the language codes in
  `langpack.json` with ephemeral URL, destination filename, and SHA-512 source
  objects.

The automation must validate that both architectures use the same full beta
revision and that every selected language pack matches it. It must not write
patched values back to the repository. Pages publication, repository signing,
and the installation reference are intentionally not defined here.

Firefox, Firefox Developer Edition, and the Firefox logo are trademarks of
Mozilla. See Mozilla's
[distribution policy](https://www.mozilla.org/foundation/trademarks/distribution-policy/)
for redistribution requirements.

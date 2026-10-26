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
checksums, destination paths, or Flatpak source objects. DevOps preprocessing
resolves each code against Mozilla's signed `SHA512SUMS` and
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

## Bundled fonts

The Freedesktop runtime provides DejaVu, Liberation, GNU FreeFont, and Noto
Color Emoji fonts. These cover Latin, Cyrillic, Greek, and many other scripts,
but not CJK, Telugu, Myanmar, Khmer, Tibetan, or Mongolian text, which would
render as missing-glyph boxes unless the host exposes a covering font. GNU
FreeFont is also the runtime's only font for the remaining Indic scripts.

- The `noto-sans-cjk` module installs the Regular and Bold Noto Sans CJK font
  collections from the upstream `Sans2.004` release into
  `/app/share/fonts/noto-cjk/`. The archive's SHA-256 matches the one pinned
  by the Freedesktop SDK.
- The `noto-fonts` module installs Regular and Bold Noto Sans Bengali,
  Devanagari, Gujarati, Gurmukhi, Kannada, Khmer, Malayalam, Myanmar, Oriya,
  Sinhala, Tamil, and Telugu, Noto Serif Tibetan, and Regular Noto Sans
  Mongolian into `/app/share/fonts/noto/`. Mongolian has no upstream Bold
  weight, and Tibetan has no upstream sans-serif design. Every file is pinned
  to one `notofonts.github.io` commit, the source the Freedesktop SDK uses for
  Noto fonts.

Flatpak Builder records each module's SIL Open Font License below
`/app/share/licenses/`.

`files/noto-fonts.conf` is installed as `/app/etc/fonts/local.conf`, which the
runtime's fontconfig configuration includes. It prefers these fonts for the
generic families only, so explicitly requested font families are unaffected
and host fonts remain available through Flatpak's font sharing:

- For `ja`, `ko`, `zh-cn`, `zh-tw`, and `zh-hk` content, it prefers the
  matching regional Noto Sans CJK face for `sans-serif`, `serif`, and
  `monospace` so Han characters use their local forms.
- For content in a language written in one of the Indic scripts above, it
  prefers the matching Noto font over GNU FreeFont for `sans-serif` and
  `serif`. Fontconfig lists GNU FreeFont by name among the generic families,
  so Indic text on pages without a language tag can still use it.

Telugu, Myanmar, Khmer, Tibetan, and Mongolian need no rule because no other
bundled or runtime font covers them.

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

`linter.json` records four reviewed exceptions. The requested application-ID
domain, `https://piquark6046.dev`, is not currently published, and the
read-only GTK configuration permission intentionally follows Mozilla's Firefox
Flatpak packaging. The package does not currently include screenshots, and
this independent Pages repository does not publish screenshot media through
Flathub's `dl.flathub.org` mirror.

## Publication contract

Publication automation may patch only ephemeral copies of these dynamic
values:

- Both archive URLs and SHA-256 hashes in
  `dev.piquark6046.Firefox.Dev.yaml`.
- The release version and date in the AppStream metadata.
- The empty `language-packs.sources` list, populated from the language codes in
  `langpack.json` with ephemeral URL, destination filename, and SHA-512 source
  objects.

The automation validates Mozilla's signed checksum files, requires both
architecture redirects and product details to name the same full beta
revision, and requires every selected language pack to match it. It never
writes patched values back to the repository.

The generated repository is signed with the public key embedded in
`dev.piquark6046.Firefox.Dev.flatpakref` and published below `/repo/` on the
project's GitHub Pages site. The accompanying signed `publication-state.json`
records the exact output fingerprint, source revision, workflow run, retained
history depth, and site size.

Firefox, Firefox Developer Edition, and the Firefox logo are trademarks of
Mozilla. See Mozilla's
[distribution policy](https://www.mozilla.org/foundation/trademarks/distribution-policy/)
for redistribution requirements.

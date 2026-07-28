import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const DevopsDirectory = dirname(fileURLToPath(import.meta.url))
export const RepositoryRoot = join(DevopsDirectory, '..')
export const FirefoxDefinitionDirectory = join(RepositoryRoot, 'browsers/firefox/dev')
export const FirefoxManifestFilename = 'dev.piquark6046.Firefox.Dev.yaml'
export const FirefoxManifestPath = join(FirefoxDefinitionDirectory, FirefoxManifestFilename)
export const FirefoxMetainfoRelativePath = 'files/dev.piquark6046.Firefox.Dev.metainfo.xml'
export const FirefoxLangpackPath = join(FirefoxDefinitionDirectory, 'langpack.json')
export const FirefoxLinterPath = join(FirefoxDefinitionDirectory, 'linter.json')
export const FirefoxFlatpakRefPath = join(
  FirefoxDefinitionDirectory,
  'dev.piquark6046.Firefox.Dev.flatpakref',
)
export const MozillaPublicKeyPath = join(DevopsDirectory, 'keys/mozilla-software-releases.asc')
export const RepositoryPublicKeyPath = join(DevopsDirectory, 'keys/browsers-flatpak-signing-key.asc')
export const RepositoryFingerprintPath = join(
  DevopsDirectory,
  'keys/browsers-flatpak-signing-key.fingerprint',
)

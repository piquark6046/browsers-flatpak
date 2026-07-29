import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DeveloperAppId,
  DeveloperDefinitionName,
  NightlyAppId,
  NightlyDefinitionName,
  type TAppId,
  type TDefinitionName,
} from './contracts.js'

export const DevopsDirectory = dirname(fileURLToPath(import.meta.url))
export const RepositoryRoot = join(DevopsDirectory, '..')

export interface IDefinitionConfiguration {
  Name: TDefinitionName
  AppId: TAppId
  Title: string
  Directory: string
  ManifestFilename: string
  FirefoxModuleName: string
  MetainfoRelativePath: string
  LangpackPath: string
  LinterPath: string
  FlatpakRefPath: string
}

function Configuration(
  Name: TDefinitionName,
  AppId: TAppId,
  Title: string,
  ManifestFilename: string,
  FirefoxModuleName: string,
): IDefinitionConfiguration {
  const Directory = join(RepositoryRoot, 'browsers', Name)
  return {
    Name,
    AppId,
    Title,
    Directory,
    ManifestFilename,
    FirefoxModuleName,
    MetainfoRelativePath: `files/${AppId}.metainfo.xml`,
    LangpackPath: join(Directory, 'langpack.json'),
    LinterPath: join(Directory, 'linter.json'),
    FlatpakRefPath: join(Directory, `${AppId}.flatpakref`),
  }
}

export const DefinitionConfigurations: readonly IDefinitionConfiguration[] = [
  Configuration(
    DeveloperDefinitionName,
    DeveloperAppId,
    'Firefox Developer Edition',
    `${DeveloperAppId}.yaml`,
    'firefox-dev',
  ),
  Configuration(
    NightlyDefinitionName,
    NightlyAppId,
    'Firefox Nightly',
    `${NightlyAppId}.yaml`,
    'firefox-nightly',
  ),
]

export function DefinitionConfiguration(Name: TDefinitionName): IDefinitionConfiguration {
  const Result = DefinitionConfigurations.find((Candidate) => Candidate.Name === Name)
  if (Result === undefined) {
    throw new Error(`Unknown definition: ${Name}`)
  }
  return Result
}

export const DeveloperConfiguration = DefinitionConfiguration(DeveloperDefinitionName)
export const NightlyConfiguration = DefinitionConfiguration(NightlyDefinitionName)

export const MozillaPublicKeyPath = join(DevopsDirectory, 'keys/mozilla-software-releases.asc')
export const RepositoryPublicKeyPath = join(DevopsDirectory, 'keys/browsers-flatpak-signing-key.asc')
export const RepositoryFingerprintPath = join(
  DevopsDirectory,
  'keys/browsers-flatpak-signing-key.fingerprint',
)

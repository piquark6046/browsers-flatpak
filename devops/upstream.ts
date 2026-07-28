import { readFile, mkdir, cp, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parse as ParseYaml, stringify as StringifyYaml } from 'yaml'
import { z } from 'zod'
import {
  AppId,
  Architectures,
  ArchitectureResolutionSchema,
  BetaVersionSchema,
  BuildImageByArchitecture,
  CollectionId,
  DefinitionName,
  FlatpakBranch,
  IsoDateSchema,
  MozillaPrimaryFingerprint,
  MozillaSigningFingerprint,
  PublicationStateSchema,
  RepositoryName,
  RepositoryUrl,
  ResolutionBundleSchema,
  RuntimeRepositoryUrl,
  SchemaVersion,
  SiteUrl,
  StateSignatureUrl,
  StateUrl,
  SuggestedRemoteName,
  type TArchitecture,
  type TBuildMatrixEntry,
  type TDefinitionResolution,
  type TPublicationState,
  type TResolutionBundle,
} from './contracts.js'
import { FetchText, Request, ResolveRedirect } from './network.js'
import {
  DevopsDirectory,
  FirefoxDefinitionDirectory,
  FirefoxLangpackPath,
  FirefoxManifestFilename,
  FirefoxMetainfoRelativePath,
  MozillaPublicKeyPath,
  RepositoryFingerprintPath,
  RepositoryPublicKeyPath,
  RepositoryRoot,
} from './paths.js'
import {
  CanonicalJson,
  CompareBetaVersions,
  HashRegularTree,
  PrettyCanonicalJson,
  ReadFingerprintFile,
  Sha256,
  VerifyDetachedSignature,
  type TJsonValue,
} from './utilities.js'

const ProductDetailsUrl = 'https://product-details.mozilla.org/1.0/firefox_versions.json'
const DevelopmentHistoryUrl =
  'https://product-details.mozilla.org/1.0/firefox_history_development_releases.json'
const ReleaseRoot = 'https://download-installer.cdn.mozilla.net/pub/devedition/releases'

const ProductDetailsSchema = z.object({
  FIREFOX_DEVEDITION: BetaVersionSchema,
})
const DevelopmentHistorySchema = z.record(
  z.string().regex(/^[0-9]+(?:\.[0-9]+)*(?:a|b|rc)[0-9]+$/u),
  IsoDateSchema,
)
const LangpackSchema = z.array(z.string().regex(/^[A-Za-z0-9-]+$/u)).min(1)

type TManifestObject = Record<string, unknown>

export interface IResolveOptions {
  Mode: 'production' | 'pr'
  OutputDirectory: string
  SourceRevision: string
  Version?: string
  Force?: boolean
  AllowDowngrade?: boolean
  Bootstrap?: boolean
}

interface IReleaseFacts {
  Version: string
  ReleaseDate: string
  Architectures: z.infer<typeof ArchitectureResolutionSchema>[]
}

interface IStateResult {
  State: TPublicationState | null
  Bootstrap: boolean
}

function JsonValue(Value: unknown): TJsonValue {
  return Value as TJsonValue
}

function ArchitectureDirectory(Architecture: TArchitecture): string {
  return Architecture === 'x86_64' ? 'linux-x86_64' : 'linux-aarch64'
}

function RotatingUrl(Architecture: TArchitecture): string {
  const Os = Architecture === 'x86_64' ? 'linux64' : 'linux64-aarch64'
  return `https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=${Os}&lang=en-US`
}

function ArchiveRelativePath(Version: string, Architecture: TArchitecture): string {
  return `${ArchitectureDirectory(Architecture)}/en-US/firefox-${Version}.tar.xz`
}

export function ParseChecksumFile(Content: string, Algorithm: 'sha256' | 'sha512'): Map<string, string> {
  const HashLength = Algorithm === 'sha256' ? 64 : 128
  const Result = new Map<string, string>()
  for (const [Index, Line] of Content.split(/\r?\n/u).entries()) {
    if (Line.trim() === '') {
      continue
    }
    const Match = new RegExp(`^([a-f0-9]{${HashLength}})\\s+\\*?(.+)$`, 'u').exec(Line)
    if (Match?.[1] === undefined || Match[2] === undefined) {
      throw new Error(`Malformed ${Algorithm} checksum line ${Index + 1}`)
    }
    const Path = Match[2]
    if (Path.startsWith('/') || Path.includes('../') || Result.has(Path)) {
      throw new Error(`Unsafe or duplicate checksum path: ${Path}`)
    }
    Result.set(Path, Match[1])
  }
  if (Result.size === 0) {
    throw new Error(`The ${Algorithm} checksum file was empty`)
  }
  return Result
}

function RequiredChecksum(Checksums: Map<string, string>, Path: string): string {
  const Checksum = Checksums.get(Path)
  if (Checksum === undefined) {
    throw new Error(`Signed checksums do not contain ${Path}`)
  }
  return Checksum
}

async function FetchSignedChecksums(
  Version: string,
  Algorithm: 'sha256' | 'sha512',
): Promise<Map<string, string>> {
  const Name = Algorithm === 'sha256' ? 'SHA256SUMS' : 'SHA512SUMS'
  const Url = `${ReleaseRoot}/${Version}/${Name}`
  const [Content, Signature] = await Promise.all([
    FetchText(Url),
    FetchText(`${Url}.asc`),
  ])
  await VerifyDetachedSignature(
    Content,
    Signature,
    MozillaPublicKeyPath,
    MozillaPrimaryFingerprint,
    MozillaSigningFingerprint,
  )
  return ParseChecksumFile(Content, Algorithm)
}

async function ResolveLatestVersion(): Promise<string> {
  const ProductDetails = ProductDetailsSchema.parse(
    JSON.parse(await FetchText(ProductDetailsUrl)) as unknown,
  )
  const RedirectVersions = await Promise.all(Architectures.map(async (Architecture) => {
    const FinalUrl = await ResolveRedirect(RotatingUrl(Architecture))
    const Match = /\/releases\/([^/]+)\//u.exec(FinalUrl.pathname)
    return BetaVersionSchema.parse(Match?.[1])
  }))
  const AllVersions = [ProductDetails.FIREFOX_DEVEDITION, ...RedirectVersions]
  if (!AllVersions.every((Version) => Version === ProductDetails.FIREFOX_DEVEDITION)) {
    throw new Error(`Mozilla latest-version sources disagree: ${AllVersions.join(', ')}`)
  }
  return ProductDetails.FIREFOX_DEVEDITION
}

async function ReadTrackedVersion(): Promise<string> {
  const Manifest = ParseYaml(
    await readFile(join(FirefoxDefinitionDirectory, FirefoxManifestFilename), 'utf8'),
  ) as TManifestObject
  const Modules = z.array(z.record(z.string(), z.unknown())).parse(Manifest.modules)
  const FirefoxModule = Modules.find((Module) => Module.name === 'firefox-dev')
  const Sources = z.array(z.record(z.string(), z.unknown())).parse(FirefoxModule?.sources)
  const Archive = Sources.find((Source) => Source.type === 'archive')
  const Url = z.string().url().parse(Archive?.url)
  const Match = /\/releases\/([^/]+)\//u.exec(new URL(Url).pathname)
  return BetaVersionSchema.parse(Match?.[1])
}

async function ResolveReleaseFacts(Version: string): Promise<IReleaseFacts> {
  const [HistoryBody, Sha256Checksums, Sha512Checksums, LangpacksBody] = await Promise.all([
    FetchText(DevelopmentHistoryUrl),
    FetchSignedChecksums(Version, 'sha256'),
    FetchSignedChecksums(Version, 'sha512'),
    readFile(FirefoxLangpackPath, 'utf8'),
  ])
  const History = DevelopmentHistorySchema.parse(JSON.parse(HistoryBody) as unknown)
  const ReleaseDate = History[Version]
  if (ReleaseDate === undefined) {
    throw new Error(`Mozilla development history does not contain ${Version}`)
  }
  const Locales = LangpackSchema.parse(JSON.parse(LangpacksBody) as unknown)
  if (
    new Set(Locales).size !== Locales.length
    || Locales.includes('en-US')
    || [...Locales].sort((Left, Right) => Left.localeCompare(Right)).join('\n') !== Locales.join('\n')
  ) {
    throw new Error('langpack.json must be sorted, unique, and exclude en-US')
  }

  const Resolutions = Architectures.map((Architecture) => {
    const Directory = ArchitectureDirectory(Architecture)
    const ArchivePath = ArchiveRelativePath(Version, Architecture)
    return ArchitectureResolutionSchema.parse({
      Architecture,
      ArchiveUrl: `${ReleaseRoot}/${Version}/${ArchivePath}`,
      ArchiveSha256: RequiredChecksum(Sha256Checksums, ArchivePath),
      LanguagePacks: Locales.map((Locale) => {
        const RelativePath = `${Directory}/xpi/${Locale}.xpi`
        return {
          Architecture,
          Locale,
          Url: `${ReleaseRoot}/${Version}/${RelativePath}`,
          Sha512: RequiredChecksum(Sha512Checksums, RelativePath),
          DestinationFilename: `langpack-${Locale}@devedition.mozilla.org.xpi`,
        }
      }),
    })
  })
  return { Version, ReleaseDate, Architectures: Resolutions }
}

function FindModule(Manifest: TManifestObject, Name: string): TManifestObject {
  z.array(z.record(z.string(), z.unknown())).parse(Manifest.modules)
  const Modules = Manifest.modules as TManifestObject[]
  const Module = Modules.find((Candidate) => Candidate.name === Name)
  if (Module === undefined) {
    throw new Error(`Manifest is missing module ${Name}`)
  }
  return Module
}

export function PatchManifest(
  ManifestBody: string,
  Facts: IReleaseFacts,
): string {
  const Manifest = z.record(z.string(), z.unknown()).parse(ParseYaml(ManifestBody))
  const FirefoxModule = FindModule(Manifest, 'firefox-dev')
  z.array(z.record(z.string(), z.unknown())).parse(FirefoxModule.sources)
  const Sources = FirefoxModule.sources as TManifestObject[]
  const Archives = Sources.filter((Source) => Source.type === 'archive')
  if (Archives.length !== Architectures.length) {
    throw new Error(`Expected ${Architectures.length} Firefox archive sources`)
  }
  for (const Resolution of Facts.Architectures) {
    const Archive = Archives.find((Candidate) => {
      const OnlyArchitectures = z.array(z.string()).safeParse(Candidate['only-arches'])
      return OnlyArchitectures.success
        && OnlyArchitectures.data.length === 1
        && OnlyArchitectures.data[0] === Resolution.Architecture
    })
    if (Archive === undefined) {
      throw new Error(`Missing Firefox archive source for ${Resolution.Architecture}`)
    }
    Archive.url = Resolution.ArchiveUrl
    Archive.sha256 = Resolution.ArchiveSha256
  }

  const LanguageModule = FindModule(Manifest, 'language-packs')
  const ExistingLanguageSources = z.array(z.unknown()).parse(LanguageModule.sources)
  if (ExistingLanguageSources.length !== 0) {
    throw new Error('Tracked language-packs.sources must remain empty')
  }
  LanguageModule.sources = Facts.Architectures.flatMap((Resolution) =>
    Resolution.LanguagePacks.map((LanguagePack) => ({
      type: 'file',
      url: LanguagePack.Url,
      sha512: LanguagePack.Sha512,
      dest: 'langpacks',
      'dest-filename': LanguagePack.DestinationFilename,
      'only-arches': [Resolution.Architecture],
    })))
  return StringifyYaml(Manifest, { lineWidth: 0 })
}

export function PatchMetainfo(Metainfo: string, Version: string, ReleaseDate: string): string {
  const Match = /<releases>\s*<release\b[^>]*\/>\s*<\/releases>/u
  if (!Match.test(Metainfo)) {
    throw new Error('AppStream metadata must contain exactly one self-closing release')
  }
  const Replacement =
    `<releases>\n    <release version="${Version}" date="${ReleaseDate}"/>\n  </releases>`
  const Patched = Metainfo.replace(Match, Replacement)
  if ((Patched.match(/<release\b/gu) ?? []).length !== 1) {
    throw new Error('AppStream metadata must contain exactly one release')
  }
  return Patched
}

async function HashAutomationInputs(): Promise<Record<string, string>> {
  const Candidates = [
    join(RepositoryRoot, 'package.json'),
    join(RepositoryRoot, 'pnpm-lock.yaml'),
    join(RepositoryRoot, '.github/workflows/upstream.yml'),
  ]
  const Result: Record<string, string> = {}
  for (const Candidate of Candidates) {
    try {
      Result[relative(RepositoryRoot, Candidate)] = Sha256(await readFile(Candidate))
    } catch (Error) {
      if ((Error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw Error
      }
    }
  }
  const DevopsTree = await HashRegularTree(DevopsDirectory)
  for (const [Path, Hash] of Object.entries(DevopsTree)) {
    if (!Path.endsWith('.test.ts')) {
      Result[`devops/${Path}`] = Hash
    }
  }
  return Result
}

async function CreatePatchedDefinition(
  Facts: IReleaseFacts,
  Variant: TDefinitionResolution['Variant'],
  OutputDirectory: string,
): Promise<TDefinitionResolution> {
  const PatchedDirectory = join(OutputDirectory, Variant, DefinitionName)
  await mkdir(PatchedDirectory, { recursive: true })
  await cp(FirefoxDefinitionDirectory, PatchedDirectory, {
    recursive: true,
    dereference: false,
  })
  const ManifestPath = join(PatchedDirectory, FirefoxManifestFilename)
  await writeFile(
    ManifestPath,
    PatchManifest(await readFile(ManifestPath, 'utf8'), Facts),
  )
  const MetainfoPath = join(PatchedDirectory, FirefoxMetainfoRelativePath)
  await writeFile(
    MetainfoPath,
    PatchMetainfo(await readFile(MetainfoPath, 'utf8'), Facts.Version, Facts.ReleaseDate),
  )
  const Fingerprint = Sha256(CanonicalJson(JsonValue({
    Definition: DefinitionName,
    AppId,
    Branch: FlatpakBranch,
    Version: Facts.Version,
    ReleaseDate: Facts.ReleaseDate,
    Architectures: Facts.Architectures,
    DefinitionTree: await HashRegularTree(PatchedDirectory),
    AutomationInputs: await HashAutomationInputs(),
  })))
  const Resolution = {
    Variant,
    Definition: DefinitionName,
    AppId,
    Branch: FlatpakBranch,
    Version: Facts.Version,
    ReleaseDate: Facts.ReleaseDate,
    Fingerprint,
    PatchedDefinitionPath: PatchedDirectory,
    ManifestPath,
    Architectures: Facts.Architectures,
  }
  await writeFile(
    join(OutputDirectory, Variant, 'resolution.json'),
    PrettyCanonicalJson(JsonValue(Resolution)),
  )
  return ResolutionBundleSchema.shape.Resolutions.element.parse(Resolution)
}

async function ReadPublishedState(BootstrapRequested: boolean): Promise<IStateResult> {
  const [StateResponse, SignatureResponse] = await Promise.all([
    Request(StateUrl),
    Request(StateSignatureUrl),
  ])
  if (StateResponse.Status === 404 && SignatureResponse.Status === 404) {
    if (!BootstrapRequested) {
      throw new Error('No publication state exists; rerun manually with --bootstrap')
    }
    return { State: null, Bootstrap: true }
  }
  if (StateResponse.Status !== 200 || SignatureResponse.Status !== 200) {
    throw new Error(
      `Publication state is incomplete: state=${StateResponse.Status}, `
      + `signature=${SignatureResponse.Status}`,
    )
  }
  const Fingerprints = await ReadFingerprintFile(RepositoryFingerprintPath)
  await VerifyDetachedSignature(
    StateResponse.Body,
    SignatureResponse.Body,
    RepositoryPublicKeyPath,
    Fingerprints.Primary,
    Fingerprints.TrustedSigning,
  )
  return {
    State: PublicationStateSchema.parse(JSON.parse(StateResponse.Body) as unknown),
    Bootstrap: false,
  }
}

function BuildMatrix(Resolutions: TDefinitionResolution[]): TBuildMatrixEntry[] {
  const Seen = new Set<string>()
  const Matrix: TBuildMatrixEntry[] = []
  for (const Resolution of Resolutions) {
    for (const Architecture of Architectures) {
      const DeduplicationKey = `${Resolution.Fingerprint}:${Architecture}`
      if (Seen.has(DeduplicationKey)) {
        continue
      }
      Seen.add(DeduplicationKey)
      Matrix.push({
        Variant: Resolution.Variant,
        Architecture,
        Definition: DefinitionName,
        DefinitionPath: Resolution.PatchedDefinitionPath,
        ManifestPath: Resolution.ManifestPath,
        ArtifactName: `${Resolution.Variant}-${DefinitionName.replace('/', '-')}-${Architecture}`,
        Image: BuildImageByArchitecture[Architecture],
        Runner: Architecture === 'x86_64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
        Version: Resolution.Version,
      })
    }
  }
  return Matrix
}

export function ShouldPublish(
  CurrentState: TPublicationState | null,
  NextResolution: TDefinitionResolution,
  Force: boolean,
  AllowDowngrade: boolean,
): boolean {
  const CurrentDefinition = CurrentState?.Definitions.find(
    (Definition) => Definition.Definition === DefinitionName,
  )
  if (
    CurrentDefinition !== undefined
    && CompareBetaVersions(NextResolution.Version, CurrentDefinition.Version) < 0
    && !AllowDowngrade
  ) {
    throw new Error(
      `Refusing downgrade from ${CurrentDefinition.Version} to ${NextResolution.Version}; `
      + 'rerun manually with --allow-downgrade',
    )
  }
  return Force || CurrentDefinition?.Fingerprint !== NextResolution.Fingerprint
}

export async function ResolveDefinitions(Options: IResolveOptions): Promise<TResolutionBundle> {
  await mkdir(Options.OutputDirectory, { recursive: true })
  const Force = Options.Force ?? false
  const AllowDowngrade = Options.AllowDowngrade ?? false
  let State: TPublicationState | null = null
  let Bootstrap = false
  const Resolutions: TDefinitionResolution[] = []

  if (Options.Mode === 'production') {
    const StateResult = await ReadPublishedState(Options.Bootstrap ?? false)
    State = StateResult.State
    Bootstrap = StateResult.Bootstrap
    const Version = Options.Version === undefined
      ? await ResolveLatestVersion()
      : BetaVersionSchema.parse(Options.Version)
    const Facts = await ResolveReleaseFacts(Version)
    Resolutions.push(
      await CreatePatchedDefinition(Facts, 'production', Options.OutputDirectory),
    )
  } else {
    const [TrackedVersion, LatestVersion] = await Promise.all([
      ReadTrackedVersion(),
      ResolveLatestVersion(),
    ])
    const Versions = TrackedVersion === LatestVersion
      ? [{ Variant: 'tracked' as const, Version: TrackedVersion }]
      : [
          { Variant: 'tracked' as const, Version: TrackedVersion },
          { Variant: 'latest' as const, Version: LatestVersion },
        ]
    for (const Entry of Versions) {
      Resolutions.push(await CreatePatchedDefinition(
        await ResolveReleaseFacts(Entry.Version),
        Entry.Variant,
        Options.OutputDirectory,
      ))
    }
  }

  const ShouldPublishValue = Options.Mode === 'production'
    ? ShouldPublish(State, Resolutions[0]!, Force, AllowDowngrade)
    : false
  const Bundle = ResolutionBundleSchema.parse({
    SchemaVersion,
    Mode: Options.Mode,
    ShouldPublish: ShouldPublishValue,
    Bootstrap,
    Forced: Force,
    SourceRevision: Options.SourceRevision,
    SiteUrl,
    RepositoryUrl,
    CurrentState: State,
    Resolutions,
    Matrix: { include: BuildMatrix(Resolutions) },
  })
  await writeFile(
    join(Options.OutputDirectory, 'resolution-bundle.json'),
    PrettyCanonicalJson(JsonValue(Bundle)),
  )
  return Bundle
}

export function CreatePublicationState(
  Bundle: TResolutionBundle,
  WorkflowRunUrl: string,
  PublishedAt: string,
  RetainedHistoryDepth: number,
  SiteSizeBytes: number,
): TPublicationState {
  if (Bundle.Mode !== 'production' || Bundle.Resolutions.length !== 1) {
    throw new Error('Publication state requires one production resolution')
  }
  const Resolution = Bundle.Resolutions[0]!
  return PublicationStateSchema.parse({
    SchemaVersion,
    Repository: RepositoryName,
    CollectionId,
    RepositoryUrl,
    SourceRevision: Bundle.SourceRevision,
    WorkflowRunUrl,
    PublishedAt,
    RetainedHistoryDepth,
    SiteSizeBytes,
    Definitions: [{
      Definition: DefinitionName,
      AppId,
      Branch: FlatpakBranch,
      Version: Resolution.Version,
      ReleaseDate: Resolution.ReleaseDate,
      Fingerprint: Resolution.Fingerprint,
      Architectures,
    }],
  })
}

export function FlatpakRef(PublicKeyBase64: string): string {
  return [
    '[Flatpak Ref]',
    `Name=${AppId}`,
    `Branch=${FlatpakBranch}`,
    `Url=${RepositoryUrl}`,
    'Title=Firefox Developer Edition',
    `SuggestRemoteName=${SuggestedRemoteName}`,
    `GPGKey=${PublicKeyBase64}`,
    'IsRuntime=false',
    `RuntimeRepo=${RuntimeRepositoryUrl}`,
    '',
  ].join('\n')
}

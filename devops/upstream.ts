import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { setTimeout as Delay } from 'node:timers/promises'
import { parse as ParseYaml, stringify as StringifyYaml } from 'yaml'
import { z } from 'zod'
import {
  AppIdSchema,
  Architectures,
  ArchitectureResolutionSchema,
  BetaVersionSchema,
  BuildImageByArchitecture,
  CollectionId,
  DeveloperAppId,
  DeveloperDefinitionName,
  DefinitionResolutionSchema,
  FlatpakBranch,
  IsoDateSchema,
  LegacySchemaVersion,
  MozillaPrimaryFingerprint,
  MozillaSigningFingerprint,
  NightlyAppId,
  NightlyBuildIdSchema,
  NightlyDefinitionName,
  NightlyVersionSchema,
  PublicationStateSchema,
  ReadablePublicationStateSchema,
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
  type TLegacyPublicationState,
  type TPublicationState,
  type TResolutionBundle,
} from './contracts.js'
import {
  DownloadFile,
  FetchText,
  Request,
  ResolveRedirect,
} from './network.js'
import {
  DefinitionConfiguration,
  DefinitionConfigurations,
  DeveloperConfiguration,
  DevopsDirectory,
  MozillaPublicKeyPath,
  NightlyConfiguration,
  RepositoryFingerprintPath,
  RepositoryPublicKeyPath,
  RepositoryRoot,
  type IDefinitionConfiguration,
} from './paths.js'
import {
  CanonicalJson,
  CompareBetaVersions,
  CompareNightlyBuildIds,
  HashRegularTree,
  PrettyCanonicalJson,
  ReadFingerprintFile,
  Sha256,
  VerifyDetachedFileSignature,
  VerifyDetachedSignature,
  type TJsonValue,
} from './utilities.js'

const ProductDetailsUrl = 'https://product-details.mozilla.org/1.0/firefox_versions.json'
const DevelopmentHistoryUrl =
  'https://product-details.mozilla.org/1.0/firefox_history_development_releases.json'
const DeveloperReleaseRoot =
  'https://download-installer.cdn.mozilla.net/pub/devedition/releases'
const NightlyArchiveRoot = 'https://archive.mozilla.org/pub/firefox/nightly'
const NightlyLatestRoot = `${NightlyArchiveRoot}/latest-mozilla-central/`
const MaximumNightlyArchiveBytes = 160 * 1024 * 1024
const NightlyLanguagePackRetryDelaysMilliseconds = [
  30_000,
  60_000,
  120_000,
  240_000,
  480_000,
] as const

const ProductDetailsSchema = z.object({
  FIREFOX_DEVEDITION: BetaVersionSchema,
})
const DevelopmentHistorySchema = z.record(
  z.string().regex(/^[0-9]+(?:\.[0-9]+)*(?:a|b|rc)[0-9]+$/u),
  IsoDateSchema,
)
const LangpackSchema = z.array(z.string().regex(/^[A-Za-z0-9-]+$/u)).min(1)
const NightlyBuildhubSchema = z.object({
  build: z.object({
    date: z.string().datetime(),
    id: NightlyBuildIdSchema,
  }),
  download: z.object({
    url: z.string().url(),
  }),
  source: z.object({
    product: z.literal('firefox'),
    repository: z.literal('https://hg.mozilla.org/mozilla-central'),
    revision: z.string().regex(/^[a-f0-9]{40}$/u),
    tree: z.literal('mozilla-central'),
  }),
  target: z.object({
    channel: z.literal('nightly'),
    locale: z.literal('en-US'),
    os: z.literal('linux'),
    platform: z.enum(['linux-x86_64', 'linux-aarch64']),
    version: NightlyVersionSchema,
  }),
})

type TManifestObject = Record<string, unknown>
type TNightlyBuildhub = z.infer<typeof NightlyBuildhubSchema>

export interface IResolveOptions {
  Mode: 'production' | 'pr'
  OutputDirectory: string
  SourceRevision: string
  Version?: string
  NightlyBuildId?: string
  Force?: boolean
  AllowDowngrade?: boolean
  Bootstrap?: boolean
}

export interface INightlyLanguagePackResolutionDependencies {
  Delay: (Milliseconds: number) => Promise<void>
  Request: typeof Request
  Warn: (Message: string) => void
}

interface INightlyLanguagePackResolution {
  Locale: string
  Url: string
  Sha512: string
  DestinationFilename: string
}

const NightlyLanguagePackResolutionDependencies = {
  Delay: async (Milliseconds) => {
    await Delay(Milliseconds)
  },
  Request,
  Warn: (Message) => console.warn(Message),
} satisfies INightlyLanguagePackResolutionDependencies

interface IArchitectureFacts {
  Architecture: TArchitecture
  ArchiveUrl: string
  ArchiveSha256: string
  LanguagePacks: {
    Architecture: TArchitecture
    Locale: string
    Url: string
    Sha512: string
    DestinationFilename: string
  }[]
}

interface IDeveloperReleaseFacts {
  Definition: typeof DeveloperDefinitionName
  Version: string
  ReleaseDate: string
  Architectures: IArchitectureFacts[]
}

interface INightlyReleaseFacts {
  Definition: typeof NightlyDefinitionName
  Version: string
  ReleaseDate: string
  BuildId: string
  SourceRevision: string
  Architectures: IArchitectureFacts[]
}

type TReleaseFacts = IDeveloperReleaseFacts | INightlyReleaseFacts

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

function DeveloperRotatingUrl(Architecture: TArchitecture): string {
  const Os = Architecture === 'x86_64' ? 'linux64' : 'linux64-aarch64'
  return `https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=${Os}&lang=en-US`
}

function NightlyRotatingUrl(Architecture: TArchitecture): string {
  const Os = Architecture === 'x86_64' ? 'linux64' : 'linux64-aarch64'
  return `https://download.mozilla.org/?product=firefox-nightly-latest-ssl&os=${Os}&lang=en-US`
}

function DeveloperArchiveRelativePath(
  Version: string,
  Architecture: TArchitecture,
): string {
  return `${ArchitectureDirectory(Architecture)}/en-US/firefox-${Version}.tar.xz`
}

export function ParseChecksumFile(
  Content: string,
  Algorithm: 'sha256' | 'sha512',
): Map<string, string> {
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

export function ParseNightlyChecksumFile(Content: string): Map<string, string> {
  const Result = new Map<string, string>()
  for (const [Index, Line] of Content.split(/\r?\n/u).entries()) {
    if (Line.trim() === '') {
      continue
    }
    const Match = /^([a-f0-9]+) (sha256|sha512) ([0-9]+) (.+)$/u.exec(Line)
    if (
      Match?.[1] === undefined
      || Match[2] === undefined
      || Match[3] === undefined
      || Match[4] === undefined
    ) {
      throw new Error(`Malformed Nightly checksum line ${Index + 1}`)
    }
    const [Hash, Algorithm, SizeText, Path] = [Match[1], Match[2], Match[3], Match[4]]
    const ExpectedLength = Algorithm === 'sha256' ? 64 : 128
    const Size = Number.parseInt(SizeText, 10)
    const Key = `${Algorithm}:${Path}`
    if (
      Hash.length !== ExpectedLength
      || !Number.isSafeInteger(Size)
      || Size <= 0
      || Path.startsWith('/')
      || Path.includes('../')
      || Result.has(Key)
    ) {
      throw new Error(`Unsafe or duplicate Nightly checksum path: ${Path}`)
    }
    Result.set(Key, Hash)
  }
  if (Result.size === 0) {
    throw new Error('The Nightly checksum file was empty')
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

function RequiredNightlyChecksum(
  Checksums: Map<string, string>,
  Algorithm: 'sha256' | 'sha512',
  Path: string,
): string {
  const Checksum = Checksums.get(`${Algorithm}:${Path}`)
  if (Checksum === undefined) {
    throw new Error(`Nightly checksums do not contain ${Algorithm}:${Path}`)
  }
  return Checksum
}

function ParseLocales(Content: string): string[] {
  const Locales = LangpackSchema.parse(JSON.parse(Content) as unknown)
  if (
    new Set(Locales).size !== Locales.length
    || Locales.includes('en-US')
    || [...Locales].sort((Left, Right) => Left.localeCompare(Right)).join('\n')
      !== Locales.join('\n')
  ) {
    throw new Error('langpack.json must be sorted, unique, and exclude en-US')
  }
  return Locales
}

async function FetchSignedDeveloperChecksums(
  Version: string,
  Algorithm: 'sha256' | 'sha512',
): Promise<Map<string, string>> {
  const Name = Algorithm === 'sha256' ? 'SHA256SUMS' : 'SHA512SUMS'
  const Url = `${DeveloperReleaseRoot}/${Version}/${Name}`
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

async function ResolveLatestDeveloperVersion(): Promise<string> {
  const ProductDetails = ProductDetailsSchema.parse(
    JSON.parse(await FetchText(ProductDetailsUrl)) as unknown,
  )
  const RedirectVersions = await Promise.all(Architectures.map(async (Architecture) => {
    const FinalUrl = await ResolveRedirect(DeveloperRotatingUrl(Architecture))
    const Match = /\/releases\/([^/]+)\//u.exec(FinalUrl.pathname)
    return BetaVersionSchema.parse(Match?.[1])
  }))
  const AllVersions = [ProductDetails.FIREFOX_DEVEDITION, ...RedirectVersions]
  if (!AllVersions.every((Version) => Version === ProductDetails.FIREFOX_DEVEDITION)) {
    throw new Error(`Mozilla latest Developer Edition sources disagree: ${AllVersions.join(', ')}`)
  }
  return ProductDetails.FIREFOX_DEVEDITION
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

async function ReadManifest(Configuration: IDefinitionConfiguration): Promise<TManifestObject> {
  return z.record(z.string(), z.unknown()).parse(ParseYaml(
    await readFile(join(Configuration.Directory, Configuration.ManifestFilename), 'utf8'),
  ))
}

function ManifestArchives(
  Manifest: TManifestObject,
  Configuration: IDefinitionConfiguration,
): TManifestObject[] {
  const FirefoxModule = FindModule(Manifest, Configuration.FirefoxModuleName)
  z.array(z.record(z.string(), z.unknown())).parse(FirefoxModule.sources)
  const Sources = FirefoxModule.sources as TManifestObject[]
  const Archives = Sources.filter((Source) => Source.type === 'archive')
  if (Archives.length !== Architectures.length) {
    throw new Error(
      `${Configuration.Name} must contain ${Architectures.length} archive sources`,
    )
  }
  return Archives
}

function ArchiveForArchitecture(
  Archives: TManifestObject[],
  Architecture: TArchitecture,
): TManifestObject {
  const Archive = Archives.find((Candidate) => {
    const OnlyArchitectures = z.array(z.string()).safeParse(Candidate['only-arches'])
    return OnlyArchitectures.success
      && OnlyArchitectures.data.length === 1
      && OnlyArchitectures.data[0] === Architecture
  })
  if (Archive === undefined) {
    throw new Error(`Missing archive source for ${Architecture}`)
  }
  return Archive
}

async function ReadTrackedDeveloperVersion(): Promise<string> {
  const Archives = ManifestArchives(
    await ReadManifest(DeveloperConfiguration),
    DeveloperConfiguration,
  )
  const Versions = Architectures.map((Architecture) => {
    const Url = z.string().url().parse(
      ArchiveForArchitecture(Archives, Architecture).url,
    )
    const Match = /\/releases\/([^/]+)\//u.exec(new URL(Url).pathname)
    return BetaVersionSchema.parse(Match?.[1])
  })
  if (!Versions.every((Version) => Version === Versions[0])) {
    throw new Error(`Tracked Developer Edition sources disagree: ${Versions.join(', ')}`)
  }
  return Versions[0]!
}

async function ResolveDeveloperReleaseFacts(
  Version: string,
): Promise<IDeveloperReleaseFacts> {
  const [HistoryBody, Sha256Checksums, Sha512Checksums, LangpacksBody] = await Promise.all([
    FetchText(DevelopmentHistoryUrl),
    FetchSignedDeveloperChecksums(Version, 'sha256'),
    FetchSignedDeveloperChecksums(Version, 'sha512'),
    readFile(DeveloperConfiguration.LangpackPath, 'utf8'),
  ])
  const History = DevelopmentHistorySchema.parse(JSON.parse(HistoryBody) as unknown)
  const ReleaseDate = History[Version]
  if (ReleaseDate === undefined) {
    throw new Error(`Mozilla development history does not contain ${Version}`)
  }
  const Locales = ParseLocales(LangpacksBody)

  const Resolutions = Architectures.map((Architecture) => {
    const Directory = ArchitectureDirectory(Architecture)
    const ArchivePath = DeveloperArchiveRelativePath(Version, Architecture)
    return ArchitectureResolutionSchema.parse({
      Architecture,
      ArchiveUrl: `${DeveloperReleaseRoot}/${Version}/${ArchivePath}`,
      ArchiveSha256: RequiredChecksum(Sha256Checksums, ArchivePath),
      LanguagePacks: Locales.map((Locale) => {
        const RelativePath = `${Directory}/xpi/${Locale}.xpi`
        return {
          Architecture,
          Locale,
          Url: `${DeveloperReleaseRoot}/${Version}/${RelativePath}`,
          Sha512: RequiredChecksum(Sha512Checksums, RelativePath),
          DestinationFilename: `langpack-${Locale}@devedition.mozilla.org.xpi`,
        }
      }),
    })
  })
  return {
    Definition: DeveloperDefinitionName,
    Version,
    ReleaseDate,
    Architectures: Resolutions,
  }
}

function NightlyBuildDirectory(BuildId: string): {
  BaseUrl: URL
  IsoDateTime: string
} {
  NightlyBuildIdSchema.parse(BuildId)
  const Year = BuildId.slice(0, 4)
  const Month = BuildId.slice(4, 6)
  const Day = BuildId.slice(6, 8)
  const Hour = BuildId.slice(8, 10)
  const Minute = BuildId.slice(10, 12)
  const Second = BuildId.slice(12, 14)
  const IsoDateTime = `${Year}-${Month}-${Day}T${Hour}:${Minute}:${Second}Z`
  if (new Date(IsoDateTime).toISOString() !== `${IsoDateTime.slice(0, -1)}.000Z`) {
    throw new Error(`Invalid Nightly build timestamp: ${BuildId}`)
  }
  const Slug = `${Year}-${Month}-${Day}-${Hour}-${Minute}-${Second}-mozilla-central`
  return {
    BaseUrl: new URL(`${NightlyArchiveRoot}/${Year}/${Month}/${Slug}/`),
    IsoDateTime,
  }
}

async function DiscoverNightlyVersion(BaseUrl: URL): Promise<string> {
  const Index = await FetchText(BaseUrl)
  const Matches = [...Index.matchAll(
    /firefox-([0-9]+(?:\.[0-9]+)*a[0-9]+)\.en-US\.linux-x86_64\.buildhub\.json/gu,
  )].map((Match) => Match[1]).filter((Value): Value is string => Value !== undefined)
  const Versions = [...new Set(Matches)]
  if (Versions.length !== 1) {
    throw new Error(
      `Expected one Nightly version in ${BaseUrl.href}; received ${Versions.join(', ') || 'none'}`,
    )
  }
  return NightlyVersionSchema.parse(Versions[0])
}

async function LatestNightlyVersion(): Promise<string> {
  const Versions = await Promise.all(Architectures.map(async (Architecture) => {
    const FinalUrl = await ResolveRedirect(NightlyRotatingUrl(Architecture))
    const Platform = ArchitectureDirectory(Architecture)
    const Match = new RegExp(
      `/latest-mozilla-central/firefox-([^/]+)\\.en-US\\.${Platform}\\.tar\\.xz$`,
      'u',
    ).exec(FinalUrl.pathname)
    return NightlyVersionSchema.parse(Match?.[1])
  }))
  if (!Versions.every((Version) => Version === Versions[0])) {
    throw new Error(`Mozilla latest Nightly redirects disagree: ${Versions.join(', ')}`)
  }
  return Versions[0]!
}

function BuildIdFromDate(DateText: string): string {
  const DateValue = new Date(DateText)
  if (Number.isNaN(DateValue.valueOf())) {
    throw new Error(`Invalid Nightly Buildhub date: ${DateText}`)
  }
  return NightlyBuildIdSchema.parse(
    DateValue.toISOString().replace(/[-:T.Z]/gu, '').slice(0, 14),
  )
}

async function FetchNightlyBuildRecords(
  RequestedBuildId?: string,
): Promise<readonly [TNightlyBuildhub, TNightlyBuildhub]> {
  let BaseUrl: URL
  let Version: string
  if (RequestedBuildId === undefined) {
    BaseUrl = new URL(NightlyLatestRoot)
    Version = await LatestNightlyVersion()
  } else {
    const Directory = NightlyBuildDirectory(RequestedBuildId)
    BaseUrl = Directory.BaseUrl
    Version = await DiscoverNightlyVersion(BaseUrl)
  }

  const Records = await Promise.all(Architectures.map(async (Architecture) => {
    const Platform = ArchitectureDirectory(Architecture)
    const Filename = `firefox-${Version}.en-US.${Platform}.buildhub.json`
    return NightlyBuildhubSchema.parse(
      JSON.parse(await FetchText(new URL(Filename, BaseUrl))) as unknown,
    )
  }))
  const [X86Record, ArmRecord] = Records
  if (X86Record === undefined || ArmRecord === undefined) {
    throw new Error('Nightly Buildhub resolution did not return both architectures')
  }
  const ExpectedPlatforms = ['linux-x86_64', 'linux-aarch64'] as const
  for (const [Index, Record] of Records.entries()) {
    if (Record.target.platform !== ExpectedPlatforms[Index]) {
      throw new Error(
        `Nightly Buildhub platform mismatch: expected ${ExpectedPlatforms[Index]}, `
        + `received ${Record.target.platform}`,
      )
    }
    if (Record.target.version !== Version || BuildIdFromDate(Record.build.date) !== Record.build.id) {
      throw new Error('Nightly Buildhub version, date, and build ID are inconsistent')
    }
    const DownloadUrl = new URL(Record.download.url)
    const ExpectedFilename =
      `firefox-${Version}.en-US.${ExpectedPlatforms[Index]}.tar.xz`
    if (
      DownloadUrl.protocol !== 'https:'
      || DownloadUrl.hostname !== 'archive.mozilla.org'
      || basename(DownloadUrl.pathname) !== ExpectedFilename
      || !/\/[0-9]{4}\/[0-9]{2}\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-mozilla-central\//u
        .test(DownloadUrl.pathname)
    ) {
      throw new Error(`Unsafe Nightly Buildhub download URL: ${Record.download.url}`)
    }
  }
  const SharedFacts = Records.map((Record) => [
    Record.build.id,
    Record.build.date,
    Record.target.version,
    Record.source.revision,
  ].join(':'))
  if (!SharedFacts.every((Value) => Value === SharedFacts[0])) {
    throw new Error('Nightly architecture Buildhub records identify different builds')
  }
  const BuildDirectories = Records.map(
    (Record) => new URL('.', Record.download.url).href,
  )
  if (!BuildDirectories.every((Value) => Value === BuildDirectories[0])) {
    throw new Error('Nightly architecture downloads are not in the same build directory')
  }
  if (RequestedBuildId !== undefined && X86Record.build.id !== RequestedBuildId) {
    throw new Error(
      `Nightly directory ${RequestedBuildId} contains build ${X86Record.build.id}`,
    )
  }
  return [X86Record, ArmRecord]
}

async function ReadTrackedNightlyBuildId(): Promise<string> {
  const Archives = ManifestArchives(
    await ReadManifest(NightlyConfiguration),
    NightlyConfiguration,
  )
  const Identities = Architectures.map((Architecture) => {
    const Url = new URL(z.string().url().parse(
      ArchiveForArchitecture(Archives, Architecture).url,
    ))
    if (Url.protocol !== 'https:' || Url.hostname !== 'archive.mozilla.org') {
      throw new Error(`Tracked Nightly archive is not an official immutable URL: ${Url.href}`)
    }
    const Match =
      /\/([0-9]{4})\/([0-9]{2})\/([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})-mozilla-central\/firefox-([^/]+)\.en-US\.linux-(?:x86_64|aarch64)\.tar\.xz$/u
        .exec(Url.pathname)
    if (Match === null) {
      throw new Error(`Tracked Nightly archive path is malformed: ${Url.pathname}`)
    }
    const BuildId = NightlyBuildIdSchema.parse(
      `${Match[3]}${Match[4]}${Match[5]}${Match[6]}${Match[7]}${Match[8]}`,
    )
    return `${BuildId}:${NightlyVersionSchema.parse(Match[9])}`
  })
  if (!Identities.every((Identity) => Identity === Identities[0])) {
    throw new Error(`Tracked Nightly sources disagree: ${Identities.join(', ')}`)
  }
  return NightlyBuildIdSchema.parse(Identities[0]!.split(':')[0])
}

async function VerifyNightlyArchive(Url: string, ExpectedSha256: string): Promise<void> {
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'browsers-flatpak-nightly-'))
  const ArchivePath = join(TemporaryDirectory, basename(new URL(Url).pathname))
  try {
    const [Download, Signature] = await Promise.all([
      DownloadFile(Url, ArchivePath, MaximumNightlyArchiveBytes),
      FetchText(`${Url}.asc`),
    ])
    if (Download.Sha256 !== ExpectedSha256) {
      throw new Error(
        `Nightly archive checksum mismatch for ${Url}: `
        + `expected ${ExpectedSha256}, received ${Download.Sha256}`,
      )
    }
    await VerifyDetachedFileSignature(
      ArchivePath,
      Signature,
      MozillaPublicKeyPath,
      MozillaPrimaryFingerprint,
      MozillaSigningFingerprint,
    )
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

async function MapWithConcurrency<TInput, TOutput>(
  Values: readonly TInput[],
  Limit: number,
  Operation: (Value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const Results = new Array<TOutput>(Values.length)
  let NextIndex = 0
  const Workers = Array.from(
    { length: Math.min(Limit, Values.length) },
    async () => {
      while (NextIndex < Values.length) {
        const Index = NextIndex
        NextIndex += 1
        Results[Index] = await Operation(Values[Index]!)
      }
    },
  )
  await Promise.all(Workers)
  return Results
}

export async function ResolveNightlyLanguagePacks(
  BuildBaseUrl: URL,
  Version: string,
  Locales: readonly string[],
  Dependencies: INightlyLanguagePackResolutionDependencies =
    NightlyLanguagePackResolutionDependencies,
): Promise<INightlyLanguagePackResolution[]> {
  const L10nBaseUrl = new URL(
    BuildBaseUrl.href.replace(/-mozilla-central\/$/u, '-mozilla-central-l10n/'),
  )
  if (L10nBaseUrl.href === BuildBaseUrl.href) {
    throw new Error(`Could not derive Nightly localization directory from ${BuildBaseUrl.href}`)
  }

  const Resolutions = new Map<string, INightlyLanguagePackResolution>()
  let PendingLocales = [...Locales]
  for (
    let Attempt = 0;
    Attempt <= NightlyLanguagePackRetryDelaysMilliseconds.length;
    Attempt += 1
  ) {
    const Outcomes = await MapWithConcurrency(PendingLocales, 8, async (Locale) => {
      const XpiFilename = `firefox-${Version}.${Locale}.langpack.xpi`
      const ChecksumFilename = `firefox-${Version}.${Locale}.linux-x86_64.checksums`
      const ChecksumUrl = new URL(ChecksumFilename, L10nBaseUrl)
      const Response = await Dependencies.Request(ChecksumUrl)
      if (Response.Status === 404 && Response.Url.href === ChecksumUrl.href) {
        return null
      }
      if (Response.Status !== 200) {
        throw new Error(
          `Expected HTTP 200 from ${Response.Url.href}; received ${Response.Status}`,
        )
      }
      const Checksums = ParseNightlyChecksumFile(Response.Body)
      return {
        Locale,
        Url: new URL(`linux-x86_64/xpi/${XpiFilename}`, L10nBaseUrl).href,
        Sha512: RequiredNightlyChecksum(Checksums, 'sha512', XpiFilename),
        DestinationFilename: `langpack-${Locale}@firefox.mozilla.org.xpi`,
      }
    })

    const NextPendingLocales: string[] = []
    for (const [Index, Outcome] of Outcomes.entries()) {
      const Locale = PendingLocales[Index]!
      if (Outcome === null) {
        NextPendingLocales.push(Locale)
      } else {
        Resolutions.set(Locale, Outcome)
      }
    }
    if (NextPendingLocales.length === 0) {
      return Locales.map((Locale) => Resolutions.get(Locale)!)
    }

    const RetryDelay = NightlyLanguagePackRetryDelaysMilliseconds[Attempt]
    if (RetryDelay === undefined) {
      throw new Error(
        'Nightly localization checksums remained unavailable after '
        + `${Attempt + 1} attempts: ${NextPendingLocales.join(', ')}`,
      )
    }
    Dependencies.Warn(
      'Nightly localization checksums are not yet available for '
      + `${NextPendingLocales.length} locale(s); retrying attempt ${Attempt + 2} of `
      + `${NightlyLanguagePackRetryDelaysMilliseconds.length + 1} in ${RetryDelay} ms`,
    )
    await Dependencies.Delay(RetryDelay)
    PendingLocales = NextPendingLocales
  }
  throw new Error('Nightly localization checksum retry loop terminated unexpectedly')
}

async function ResolveNightlyReleaseFacts(
  Records: readonly [TNightlyBuildhub, TNightlyBuildhub],
): Promise<INightlyReleaseFacts> {
  const FirstRecord = Records[0]
  const Version = FirstRecord.target.version
  const BuildBaseUrl = new URL('.', FirstRecord.download.url)
  const [LangpacksBody, ChecksumBodies] = await Promise.all([
    readFile(NightlyConfiguration.LangpackPath, 'utf8'),
    Promise.all(Records.map(async (Record) => {
      const ChecksumUrl = Record.download.url.replace(/\.tar\.xz$/u, '.checksums')
      return await FetchText(ChecksumUrl)
    })),
  ])
  const Locales = ParseLocales(LangpacksBody)
  const LanguagePacksPromise = ResolveNightlyLanguagePacks(
    BuildBaseUrl,
    Version,
    Locales,
  )
  const Resolutions = Records.map((Record, Index) => {
    const Architecture = Architectures[Index]!
    const ArchiveFilename = basename(new URL(Record.download.url).pathname)
    const ArchiveSha256 = RequiredNightlyChecksum(
      ParseNightlyChecksumFile(ChecksumBodies[Index]!),
      'sha256',
      ArchiveFilename,
    )
    return {
      Architecture,
      ArchiveUrl: Record.download.url,
      ArchiveSha256,
    }
  })
  await Promise.all(Resolutions.map(async (Resolution) =>
    await VerifyNightlyArchive(Resolution.ArchiveUrl, Resolution.ArchiveSha256)))
  const LanguagePacks = await LanguagePacksPromise
  return {
    Definition: NightlyDefinitionName,
    Version,
    ReleaseDate: FirstRecord.build.date.slice(0, 10),
    BuildId: FirstRecord.build.id,
    SourceRevision: FirstRecord.source.revision,
    Architectures: Resolutions.map((Resolution) => ArchitectureResolutionSchema.parse({
      ...Resolution,
      LanguagePacks: LanguagePacks.map((LanguagePack) => ({
        Architecture: Resolution.Architecture,
        ...LanguagePack,
      })),
    })),
  }
}

export function PatchManifest(
  ManifestBody: string,
  Facts: TReleaseFacts,
): string {
  const Configuration = DefinitionConfiguration(Facts.Definition)
  const Manifest = z.record(z.string(), z.unknown()).parse(ParseYaml(ManifestBody))
  const Archives = ManifestArchives(Manifest, Configuration)
  for (const Resolution of Facts.Architectures) {
    const Archive = ArchiveForArchitecture(Archives, Resolution.Architecture)
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

export function PatchMetainfo(
  Metainfo: string,
  Version: string,
  ReleaseDate: string,
): string {
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
  Facts: TReleaseFacts,
  Variant: TDefinitionResolution['Variant'],
  OutputDirectory: string,
): Promise<TDefinitionResolution> {
  const Configuration = DefinitionConfiguration(Facts.Definition)
  const RelativeDefinitionPath = join(Variant, Facts.Definition)
  const PatchedDirectory = join(OutputDirectory, RelativeDefinitionPath)
  await mkdir(PatchedDirectory, { recursive: true })
  await cp(Configuration.Directory, PatchedDirectory, {
    recursive: true,
    dereference: false,
  })
  const RelativeManifestPath = join(
    RelativeDefinitionPath,
    Configuration.ManifestFilename,
  )
  const ManifestPath = join(OutputDirectory, RelativeManifestPath)
  await writeFile(
    ManifestPath,
    PatchManifest(await readFile(ManifestPath, 'utf8'), Facts),
  )
  const MetainfoPath = join(PatchedDirectory, Configuration.MetainfoRelativePath)
  await writeFile(
    MetainfoPath,
    PatchMetainfo(
      await readFile(MetainfoPath, 'utf8'),
      Facts.Version,
      Facts.ReleaseDate,
    ),
  )
  const Fingerprint = Sha256(CanonicalJson(JsonValue({
    Definition: Facts.Definition,
    AppId: Configuration.AppId,
    Branch: FlatpakBranch,
    Version: Facts.Version,
    ReleaseDate: Facts.ReleaseDate,
    ...(Facts.Definition === NightlyDefinitionName
      ? { BuildId: Facts.BuildId, SourceRevision: Facts.SourceRevision }
      : {}),
    Architectures: Facts.Architectures,
    DefinitionTree: await HashRegularTree(PatchedDirectory),
    AutomationInputs: await HashAutomationInputs(),
  })))
  const Common = {
    Variant,
    Definition: Facts.Definition,
    AppId: Configuration.AppId,
    Branch: FlatpakBranch,
    Version: Facts.Version,
    ReleaseDate: Facts.ReleaseDate,
    Fingerprint,
    PatchedDefinitionPath: RelativeDefinitionPath,
    ManifestPath: RelativeManifestPath,
    LinterPath: join(RelativeDefinitionPath, 'linter.json'),
    Architectures: Facts.Architectures,
  }
  const Resolution = Facts.Definition === NightlyDefinitionName
    ? {
        ...Common,
        Definition: NightlyDefinitionName,
        AppId: NightlyAppId,
        BuildId: Facts.BuildId,
        SourceRevision: Facts.SourceRevision,
      }
    : {
        ...Common,
        Definition: DeveloperDefinitionName,
        AppId: DeveloperAppId,
      }
  const Parsed = DefinitionResolutionSchema.parse(Resolution)
  await mkdir(join(OutputDirectory, Variant), { recursive: true })
  await writeFile(
    join(OutputDirectory, Variant, `${Facts.Definition.replace('/', '-')}-resolution.json`),
    PrettyCanonicalJson(JsonValue(Parsed)),
  )
  return Parsed
}

export function MigrateLegacyState(State: TLegacyPublicationState): TPublicationState {
  if (State.SchemaVersion !== LegacySchemaVersion) {
    throw new Error(`Unsupported legacy publication state: ${State.SchemaVersion}`)
  }
  return PublicationStateSchema.parse({
    ...State,
    SchemaVersion,
  })
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
  const Parsed = ReadablePublicationStateSchema.parse(
    JSON.parse(StateResponse.Body) as unknown,
  )
  return {
    State: Parsed.SchemaVersion === LegacySchemaVersion
      ? MigrateLegacyState(Parsed)
      : Parsed,
    Bootstrap: false,
  }
}

export function ShouldBuildDefinition(
  CurrentState: TPublicationState | null,
  NextResolution: TDefinitionResolution,
  Force: boolean,
  AllowDowngrade: boolean,
): boolean {
  const CurrentDefinition = CurrentState?.Definitions.find(
    (Definition) => Definition.Definition === NextResolution.Definition,
  )
  if (CurrentDefinition === undefined) {
    return true
  }
  if (
    NextResolution.Definition === DeveloperDefinitionName
    && CurrentDefinition.Definition === DeveloperDefinitionName
    && CompareBetaVersions(NextResolution.Version, CurrentDefinition.Version) < 0
    && !AllowDowngrade
  ) {
    throw new Error(
      `Refusing ${NextResolution.Definition} downgrade from `
      + `${CurrentDefinition.Version} to ${NextResolution.Version}; `
      + 'rerun manually with --allow-downgrade',
    )
  }
  if (
    NextResolution.Definition === NightlyDefinitionName
    && CurrentDefinition.Definition === NightlyDefinitionName
  ) {
    if (
      CompareNightlyBuildIds(NextResolution.BuildId, CurrentDefinition.BuildId) < 0
      && !AllowDowngrade
    ) {
      throw new Error(
        `Refusing ${NextResolution.Definition} downgrade from `
        + `${CurrentDefinition.BuildId} to ${NextResolution.BuildId}; `
        + 'rerun manually with --allow-downgrade',
      )
    }
    if (
      NextResolution.BuildId === CurrentDefinition.BuildId
      && NextResolution.SourceRevision !== CurrentDefinition.SourceRevision
    ) {
      throw new Error(
        `Nightly build ${NextResolution.BuildId} changed source revision from `
        + `${CurrentDefinition.SourceRevision} to ${NextResolution.SourceRevision}`,
      )
    }
  }
  return Force || CurrentDefinition.Fingerprint !== NextResolution.Fingerprint
}

function BuildMatrix(
  Resolutions: TDefinitionResolution[],
  CurrentState: TPublicationState | null,
  Force: boolean,
  AllowDowngrade: boolean,
): TBuildMatrixEntry[] {
  const Matrix: TBuildMatrixEntry[] = []
  for (const Resolution of Resolutions) {
    const Include = Resolution.Variant !== 'production'
      || ShouldBuildDefinition(CurrentState, Resolution, Force, AllowDowngrade)
    if (!Include) {
      continue
    }
    for (const Architecture of Architectures) {
      Matrix.push({
        Variant: Resolution.Variant,
        Architecture,
        Definition: Resolution.Definition,
        AppId: AppIdSchema.parse(Resolution.AppId),
        DefinitionPath: Resolution.PatchedDefinitionPath,
        ManifestPath: Resolution.ManifestPath,
        LinterPath: Resolution.LinterPath,
        ArtifactName:
          `${Resolution.Variant}-${Resolution.Definition.replace('/', '-')}-${Architecture}`,
        Image: BuildImageByArchitecture[Architecture],
        Runner: Architecture === 'x86_64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
        Version: Resolution.Version,
      })
    }
  }
  return Matrix
}

async function ResolveProductionFacts(
  Options: IResolveOptions,
): Promise<readonly [IDeveloperReleaseFacts, INightlyReleaseFacts]> {
  const DeveloperVersion = Options.Version === undefined
    ? await ResolveLatestDeveloperVersion()
    : BetaVersionSchema.parse(Options.Version)
  const NightlyRecords = await FetchNightlyBuildRecords(
    Options.NightlyBuildId === undefined
      ? undefined
      : NightlyBuildIdSchema.parse(Options.NightlyBuildId),
  )
  return await Promise.all([
    ResolveDeveloperReleaseFacts(DeveloperVersion),
    ResolveNightlyReleaseFacts(NightlyRecords),
  ])
}

async function ResolvePullRequestDefinitions(
  OutputDirectory: string,
): Promise<TDefinitionResolution[]> {
  const Resolutions: TDefinitionResolution[] = []
  const [TrackedDeveloperVersion, LatestDeveloperVersion] = await Promise.all([
    ReadTrackedDeveloperVersion(),
    ResolveLatestDeveloperVersion(),
  ])
  const DeveloperEntries = TrackedDeveloperVersion === LatestDeveloperVersion
    ? [{ Variant: 'tracked' as const, Version: TrackedDeveloperVersion }]
    : [
        { Variant: 'tracked' as const, Version: TrackedDeveloperVersion },
        { Variant: 'latest' as const, Version: LatestDeveloperVersion },
      ]
  for (const Entry of DeveloperEntries) {
    Resolutions.push(await CreatePatchedDefinition(
      await ResolveDeveloperReleaseFacts(Entry.Version),
      Entry.Variant,
      OutputDirectory,
    ))
  }

  const [TrackedNightlyBuildId, LatestNightlyRecords] = await Promise.all([
    ReadTrackedNightlyBuildId(),
    FetchNightlyBuildRecords(),
  ])
  if (TrackedNightlyBuildId === LatestNightlyRecords[0].build.id) {
    Resolutions.push(await CreatePatchedDefinition(
      await ResolveNightlyReleaseFacts(LatestNightlyRecords),
      'tracked',
      OutputDirectory,
    ))
  } else {
    Resolutions.push(await CreatePatchedDefinition(
      await ResolveNightlyReleaseFacts(
        await FetchNightlyBuildRecords(TrackedNightlyBuildId),
      ),
      'tracked',
      OutputDirectory,
    ))
    Resolutions.push(await CreatePatchedDefinition(
      await ResolveNightlyReleaseFacts(LatestNightlyRecords),
      'latest',
      OutputDirectory,
    ))
  }
  return Resolutions
}

export async function ResolveDefinitions(Options: IResolveOptions): Promise<TResolutionBundle> {
  await mkdir(Options.OutputDirectory, { recursive: true })
  const Force = Options.Force ?? false
  const AllowDowngrade = Options.AllowDowngrade ?? false
  let State: TPublicationState | null = null
  let Bootstrap = false
  let Resolutions: TDefinitionResolution[]

  if (Options.Mode === 'production') {
    const StateResult = await ReadPublishedState(Options.Bootstrap ?? false)
    State = StateResult.State
    Bootstrap = StateResult.Bootstrap
    const Facts = await ResolveProductionFacts(Options)
    Resolutions = await Promise.all(Facts.map(async (DefinitionFacts) =>
      await CreatePatchedDefinition(
        DefinitionFacts,
        'production',
        Options.OutputDirectory,
      )))
  } else {
    Resolutions = await ResolvePullRequestDefinitions(Options.OutputDirectory)
  }

  const Matrix = BuildMatrix(Resolutions, State, Force, AllowDowngrade)
  const ShouldPublishValue = Options.Mode === 'production' && Matrix.length > 0
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
    Matrix: { include: Matrix },
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
  if (Bundle.Mode !== 'production') {
    throw new Error('Publication state requires production resolutions')
  }
  const ProductionResolutions = Bundle.Resolutions.filter(
    (Resolution) => Resolution.Variant === 'production',
  )
  if (ProductionResolutions.length !== DefinitionConfigurations.length) {
    throw new Error(
      `Publication state requires ${DefinitionConfigurations.length} production resolutions`,
    )
  }
  const Definitions = DefinitionConfigurations.map((Configuration) => {
    const Resolution = ProductionResolutions.find(
      (Candidate) => Candidate.Definition === Configuration.Name,
    )
    if (Resolution === undefined) {
      throw new Error(`Publication resolution is missing ${Configuration.Name}`)
    }
    const Common = {
      Definition: Resolution.Definition,
      AppId: Resolution.AppId,
      Branch: FlatpakBranch,
      Version: Resolution.Version,
      ReleaseDate: Resolution.ReleaseDate,
      Fingerprint: Resolution.Fingerprint,
      Architectures: [...Architectures],
    }
    return Resolution.Definition === NightlyDefinitionName
      ? {
          ...Common,
          Definition: NightlyDefinitionName,
          AppId: NightlyAppId,
          BuildId: Resolution.BuildId,
          SourceRevision: Resolution.SourceRevision,
        }
      : {
          ...Common,
          Definition: DeveloperDefinitionName,
          AppId: DeveloperAppId,
        }
  })
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
    Definitions,
  })
}

export function FlatpakRef(
  PublicKeyBase64: string,
  Configuration: IDefinitionConfiguration,
): string {
  return [
    '[Flatpak Ref]',
    `Name=${Configuration.AppId}`,
    `Branch=${FlatpakBranch}`,
    `Url=${RepositoryUrl}`,
    `Title=${Configuration.Title}`,
    `SuggestRemoteName=${SuggestedRemoteName}`,
    `GPGKey=${PublicKeyBase64}`,
    'IsRuntime=false',
    `RuntimeRepo=${RuntimeRepositoryUrl}`,
    '',
  ].join('\n')
}

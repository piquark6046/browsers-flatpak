import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as Delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  Architectures,
  CollectionId,
  FlatpakBranch,
  NightlyDefinitionName,
  PagesSizeLimitBytes,
  RepositoryUrl,
  ResolutionBundleSchema,
  SiteUrl,
  type TAppId,
  type TResolutionBundle,
} from './contracts.js'
import {
  DefinitionConfiguration,
  DefinitionConfigurations,
  RepositoryFingerprintPath,
  RepositoryPublicKeyPath,
} from './paths.js'
import {
  CreatePublicationState,
} from './upstream.js'
import {
  AssertPathWithin,
  CopyRegularTree,
  DirectorySize,
  EscapeHtml,
  ListRegularFiles,
  PrettyCanonicalJson,
  ReadFingerprintFile,
  RunCommand,
  type TJsonValue,
} from './utilities.js'

export interface IFinalizeOptions {
  BundlePath: string
  BuildArtifactsDirectory: string
  SiteDirectory: string
  WorkflowRunUrl: string
  SecretSubkeyBase64: string
  Passphrase: string
}

interface ISigningContext {
  GnuPgHome: string
  SigningFingerprint: string
  Environment: NodeJS.ProcessEnv
}

export interface IRepositoryInitializationDependencies {
  Delay: (Milliseconds: number) => Promise<void>
  RemoveRepository: (RepositoryPath: string) => Promise<void>
  RunCommand: typeof RunCommand
  Warn: (Message: string) => void
}

const PublishedPullRetryDelaysMilliseconds = [1_000, 5_000] as const

const RepositoryInitializationDependencies: IRepositoryInitializationDependencies = {
  Delay: async (Milliseconds) => {
    await Delay(Milliseconds)
  },
  RemoveRepository: async (RepositoryPath) => {
    await rm(RepositoryPath, { recursive: true, force: true })
  },
  RunCommand,
  Warn: (Message) => console.warn(Message),
}

async function PrepareSigning(
  SecretSubkeyBase64: string,
  Passphrase: string,
  TemporaryDirectory: string,
): Promise<ISigningContext> {
  if (SecretSubkeyBase64.length < 100 || Passphrase.length < 20) {
    throw new Error('Signing secrets are missing or unexpectedly short')
  }
  const GnuPgHome = join(TemporaryDirectory, 'gnupg')
  const SecretKeyPath = join(TemporaryDirectory, 'secret-subkeys.asc')
  const Environment = { ...process.env }
  delete Environment.FLATPAK_GPG_SECRET_SUBKEY_B64
  delete Environment.FLATPAK_GPG_PASSPHRASE
  await mkdir(GnuPgHome, { recursive: true })
  await chmod(GnuPgHome, 0o700)
  await writeFile(
    SecretKeyPath,
    Buffer.from(SecretSubkeyBase64, 'base64'),
    { mode: 0o600 },
  )
  const Redactions = [SecretSubkeyBase64, Passphrase]
  await RunCommand('gpg', [
    '--batch',
    '--homedir',
    GnuPgHome,
    '--import',
    SecretKeyPath,
  ], { Environment, Redactions })
  const Fingerprints = await ReadFingerprintFile(RepositoryFingerprintPath)
  const Listing = await RunCommand('gpg', [
    '--batch',
    '--homedir',
    GnuPgHome,
    '--with-colons',
    '--fingerprint',
    '--list-secret-keys',
    Fingerprints.Primary,
  ], { Environment, Redactions })
  const SecretFingerprints = Listing.Stdout
    .split(/\r?\n/u)
    .filter((Line) => Line.startsWith('fpr:'))
    .map((Line) => Line.split(':')[9])
    .filter((Fingerprint): Fingerprint is string => Fingerprint !== undefined)
  if (
    !SecretFingerprints.includes(Fingerprints.Primary)
    || !SecretFingerprints.includes(Fingerprints.Signing)
  ) {
    throw new Error('The imported secret subkey does not match the tracked signing fingerprints')
  }

  const ProbePath = join(TemporaryDirectory, 'signing-probe')
  await writeFile(ProbePath, randomBytes(32))
  await RunCommand('gpg', [
    '--batch',
    '--yes',
    '--homedir',
    GnuPgHome,
    '--pinentry-mode',
    'loopback',
    '--passphrase-fd',
    '0',
    '--local-user',
    Fingerprints.Signing,
    '--detach-sign',
    ProbePath,
  ], {
    Input: `${Passphrase}\n`,
    Environment,
    Redactions,
  })
  await rm(SecretKeyPath, { force: true })
  return {
    GnuPgHome,
    SigningFingerprint: Fingerprints.Signing,
    Environment: { ...Environment, GNUPGHOME: GnuPgHome },
  }
}

function ExpectedRef(Ref: string, AppId: TAppId, Architecture: string): boolean {
  const EscapedAppId = AppId.replaceAll('.', '\\.')
  return new RegExp(
    `^(?:app/${EscapedAppId}|runtime/${EscapedAppId}\\.(?:Locale|Debug))`
    + `/${Architecture}/${FlatpakBranch}$`,
    'u',
  ).test(Ref)
}

function ExpectedCombinedRef(Ref: string): boolean {
  return DefinitionConfigurations.some((Configuration) =>
    Architectures.some((Architecture) =>
      ExpectedRef(Ref, Configuration.AppId, Architecture)))
}

function RetryablePublishedPullError(CatchValue: unknown): boolean {
  if (!(CatchValue instanceof Error)) {
    return false
  }
  return CatchValue.message.startsWith('ostree exited with ')
    && CatchValue.message.includes(`URI ${RepositoryUrl}objects/`)
    && /exceeded maximum size of [0-9]+ bytes/u.test(CatchValue.message)
}

async function InitializeRepositoryAttempt(
  RepositoryPath: string,
  PullPublishedRepository: boolean,
  Environment: NodeJS.ProcessEnv,
  Dependencies: IRepositoryInitializationDependencies,
): Promise<void> {
  await Dependencies.RemoveRepository(RepositoryPath)
  await Dependencies.RunCommand('ostree', [
    `--repo=${RepositoryPath}`,
    'init',
    '--mode=archive-z2',
    `--collection-id=${CollectionId}`,
  ], { Environment })
  if (PullPublishedRepository) {
    await Dependencies.RunCommand('ostree', [
      `--repo=${RepositoryPath}`,
      'remote',
      'add',
      `--collection-id=${CollectionId}`,
      '--set=gpg-verify=true',
      '--set=gpg-verify-summary=true',
      `--gpg-import=${RepositoryPublicKeyPath}`,
      'published',
      RepositoryUrl,
    ], { Environment })
    await Dependencies.RunCommand('ostree', [
      `--repo=${RepositoryPath}`,
      'pull',
      '--mirror',
      '--depth=1',
      'published',
    ], { Environment })
  }
}

export async function InitializeRepository(
  RepositoryPath: string,
  PullPublishedRepository: boolean,
  Environment: NodeJS.ProcessEnv,
  Dependencies: IRepositoryInitializationDependencies = RepositoryInitializationDependencies,
): Promise<void> {
  if (!PullPublishedRepository) {
    await InitializeRepositoryAttempt(
      RepositoryPath,
      PullPublishedRepository,
      Environment,
      Dependencies,
    )
    return
  }

  for (
    let Attempt = 0;
    Attempt <= PublishedPullRetryDelaysMilliseconds.length;
    Attempt += 1
  ) {
    try {
      await InitializeRepositoryAttempt(
        RepositoryPath,
        PullPublishedRepository,
        Environment,
        Dependencies,
      )
      return
    } catch (CatchValue) {
      const RetryDelay = PublishedPullRetryDelaysMilliseconds[Attempt]
      if (RetryDelay === undefined || !RetryablePublishedPullError(CatchValue)) {
        throw CatchValue
      }
      Dependencies.Warn(
        'Published repository pull received an unexpected-size response; '
        + `retrying attempt ${Attempt + 2} of `
        + `${PublishedPullRetryDelaysMilliseconds.length + 1} in ${RetryDelay} ms`,
      )
      await Dependencies.Delay(RetryDelay)
    }
  }
}

async function ImportBuildRepositories(
  RepositoryPath: string,
  BuildArtifactsDirectory: string,
  Bundle: TResolutionBundle,
  Signing: ISigningContext,
): Promise<void> {
  const Entries = Bundle.Matrix.include.filter(
    (Entry) => Entry.Variant === 'production',
  )
  if (Entries.length === 0) {
    throw new Error('Publication matrix does not contain changed production builds')
  }
  for (const Entry of Entries) {
    const Configuration = DefinitionConfiguration(Entry.Definition)
    if (Entry.AppId !== Configuration.AppId) {
      throw new Error(
        `Build matrix maps ${Entry.Definition} to unexpected app ID ${Entry.AppId}`,
      )
    }
    const SourceRepository = AssertPathWithin(
      BuildArtifactsDirectory,
      join(BuildArtifactsDirectory, Entry.ArtifactName, 'repo'),
    )
    await ListRegularFiles(SourceRepository)
    const RefsResult = await RunCommand('ostree', [
      `--repo=${SourceRepository}`,
      'refs',
    ], { Environment: Signing.Environment })
    const Refs = RefsResult.Stdout.split(/\r?\n/u).filter((Ref) => Ref !== '')
    const ImportableRefs = Refs.filter(
      (Ref) => Ref.startsWith('app/') || Ref.startsWith('runtime/'),
    )
    const ExpectedMainRef =
      `app/${Entry.AppId}/${Entry.Architecture}/${FlatpakBranch}`
    if (!ImportableRefs.includes(ExpectedMainRef)) {
      throw new Error(`Build repository is missing ${ExpectedMainRef}`)
    }
    const UnexpectedRefs = ImportableRefs.filter(
      (Ref) => !ExpectedRef(Ref, Entry.AppId, Entry.Architecture),
    )
    if (UnexpectedRefs.length > 0) {
      throw new Error(`Build repository contains unexpected refs: ${UnexpectedRefs.join(', ')}`)
    }
    for (const Ref of ImportableRefs) {
      await RunCommand('flatpak', [
        'build-commit-from',
        '--untrusted',
        `--src-repo=${SourceRepository}`,
        `--src-ref=${Ref}`,
        `--gpg-sign=${Signing.SigningFingerprint}`,
        `--gpg-homedir=${Signing.GnuPgHome}`,
        RepositoryPath,
        Ref,
      ], { Environment: Signing.Environment })
    }
  }
}

async function ValidateCombinedRepository(
  RepositoryPath: string,
  Signing: ISigningContext,
): Promise<void> {
  const RefsResult = await RunCommand('ostree', [
    `--repo=${RepositoryPath}`,
    'refs',
  ], { Environment: Signing.Environment })
  const Refs = RefsResult.Stdout.split(/\r?\n/u).filter((Ref) => Ref !== '')
  const ImportableRefs = Refs.filter(
    (Ref) => Ref.startsWith('app/') || Ref.startsWith('runtime/'),
  )
  const UnexpectedRefs = ImportableRefs.filter((Ref) => !ExpectedCombinedRef(Ref))
  if (UnexpectedRefs.length > 0) {
    throw new Error(`Combined repository contains unexpected refs: ${UnexpectedRefs.join(', ')}`)
  }
  for (const Configuration of DefinitionConfigurations) {
    for (const Architecture of Architectures) {
      const MainRef =
        `app/${Configuration.AppId}/${Architecture}/${FlatpakBranch}`
      if (!ImportableRefs.includes(MainRef)) {
        throw new Error(`Combined repository is missing ${MainRef}`)
      }
    }
  }
}

async function CreateMergedLinterFile(TemporaryDirectory: string): Promise<string> {
  const LinterSchema = z.record(z.string(), z.array(z.string()))
  const Merged: Record<string, string[]> = {}
  for (const Configuration of DefinitionConfigurations) {
    const Parsed = LinterSchema.parse(
      JSON.parse(await readFile(Configuration.LinterPath, 'utf8')) as unknown,
    )
    const Keys = Object.keys(Parsed)
    if (Keys.length !== 1 || Keys[0] !== Configuration.AppId) {
      throw new Error(
        `${Configuration.Name}/linter.json must contain only ${Configuration.AppId}`,
      )
    }
    Merged[Configuration.AppId] = Parsed[Configuration.AppId]!
  }
  const LinterPath = join(TemporaryDirectory, 'linter.json')
  await writeFile(LinterPath, PrettyCanonicalJson(Merged))
  return LinterPath
}

async function UpdateRepository(
  RepositoryPath: string,
  Signing: ISigningContext,
  HistoryDepth: 0 | 1,
  LinterPath: string,
): Promise<void> {
  if (HistoryDepth === 0) {
    const DeltasPath = AssertPathWithin(RepositoryPath, join(RepositoryPath, 'deltas'))
    await rm(DeltasPath, { recursive: true, force: true })
  }
  const Arguments = [
    'build-update-repo',
    '--title=Browsers Flatpak Repository',
    '--comment=Independently maintained browser Flatpaks',
    `--homepage=${SiteUrl}`,
    `--default-branch=${FlatpakBranch}`,
    `--collection-id=${CollectionId}`,
    '--deploy-sideload-collection-id',
    '--prune',
    `--prune-depth=${HistoryDepth}`,
    `--gpg-sign=${Signing.SigningFingerprint}`,
    `--gpg-homedir=${Signing.GnuPgHome}`,
  ]
  if (HistoryDepth === 1) {
    Arguments.push('--generate-static-deltas', '--static-delta-jobs=2')
  }
  Arguments.push(RepositoryPath)
  await RunCommand('flatpak', Arguments, { Environment: Signing.Environment })
  await RunCommand('ostree', [
    `--repo=${RepositoryPath}`,
    'fsck',
  ], { Environment: Signing.Environment })
  await RunCommand('flatpak-builder-lint', [
    '--exceptions',
    '--user-exceptions',
    LinterPath,
    'repo',
    RepositoryPath,
  ], { Environment: Signing.Environment })
}

export function LandingPage(Bundle: TResolutionBundle): string {
  const Cards = DefinitionConfigurations.map((Configuration) => {
    const Resolution = Bundle.Resolutions.find(
      (Candidate) =>
        Candidate.Variant === 'production'
        && Candidate.Definition === Configuration.Name,
    )
    if (Resolution === undefined) {
      throw new Error(`Landing page resolution is missing ${Configuration.Name}`)
    }
    const ReferenceName = basename(Configuration.FlatpakRefPath)
    const InstallCommand = `flatpak install ${SiteUrl}${ReferenceName}`
    const Build = Resolution.Definition === NightlyDefinitionName
      ? `<p>Mozilla build: <code>${EscapeHtml(Resolution.BuildId)}</code></p>`
      : ''
    return `  <div class="card">
    <h2>${EscapeHtml(Configuration.Title)} ${EscapeHtml(Resolution.Version)}</h2>
    ${Build}
    <p>Architectures: <code>${Architectures.join(', ')}</code></p>
    <p><a href="${EscapeHtml(ReferenceName)}">Download the Flatpak reference</a></p>
    <pre><code>${EscapeHtml(InstallCommand)}</code></pre>
  </div>`
  }).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browsers Flatpak Repository</title>
  <style>
    :root { color-scheme: light dark; font: 18px/1.55 system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 48rem; padding: 3rem 1.25rem; }
    code { overflow-wrap: anywhere; }
    .card { border: 1px solid #8888; border-radius: .75rem; margin-block: 1rem; padding: 1.25rem; }
  </style>
</head>
<body>
  <h1>Browsers Flatpak Repository</h1>
  <p>Independently maintained browser Flatpaks, built from reviewed definitions.</p>
${Cards}
  <p><a href="publication-state.json">Signed publication metadata</a> ·
    <a href="browsers-flatpak-signing-key.asc">Repository public key</a></p>
</body>
</html>
`
}

async function WriteSignedState(
  SiteDirectory: string,
  Bundle: TResolutionBundle,
  Signing: ISigningContext,
  WorkflowRunUrl: string,
  HistoryDepth: 0 | 1,
): Promise<number> {
  const StatePath = join(SiteDirectory, 'publication-state.json')
  const SignaturePath = join(SiteDirectory, 'publication-state.json.asc')
  let ClaimedSize = 0
  for (let Attempt = 0; Attempt < 5; Attempt += 1) {
    const State = CreatePublicationState(
      Bundle,
      WorkflowRunUrl,
      new Date().toISOString(),
      HistoryDepth,
      ClaimedSize,
    )
    await writeFile(StatePath, PrettyCanonicalJson(State as unknown as TJsonValue))
    await RunCommand('gpg', [
      '--batch',
      '--yes',
      '--armor',
      '--homedir',
      Signing.GnuPgHome,
      '--local-user',
      Signing.SigningFingerprint,
      '--output',
      SignaturePath,
      '--detach-sign',
      StatePath,
    ], { Environment: Signing.Environment })
    const MeasuredSize = await DirectorySize(SiteDirectory)
    if (MeasuredSize === ClaimedSize) {
      return MeasuredSize
    }
    ClaimedSize = MeasuredSize
  }
  throw new Error('Could not stabilize the exact published site size')
}

async function StageSite(
  SiteDirectory: string,
  RepositoryPath: string,
  Bundle: TResolutionBundle,
  Signing: ISigningContext,
  WorkflowRunUrl: string,
  HistoryDepth: 0 | 1,
): Promise<number> {
  await rm(SiteDirectory, { recursive: true, force: true })
  await mkdir(SiteDirectory, { recursive: true })
  await CopyRegularTree(RepositoryPath, join(SiteDirectory, 'repo'))
  await writeFile(join(SiteDirectory, 'index.html'), LandingPage(Bundle))
  await writeFile(join(SiteDirectory, '.nojekyll'), '')
  await Promise.all(DefinitionConfigurations.map(async (Configuration) =>
    await writeFile(
      join(SiteDirectory, basename(Configuration.FlatpakRefPath)),
      await readFile(Configuration.FlatpakRefPath),
    )))
  await writeFile(
    join(SiteDirectory, 'browsers-flatpak-signing-key.asc'),
    await readFile(RepositoryPublicKeyPath),
  )
  return await WriteSignedState(
    SiteDirectory,
    Bundle,
    Signing,
    WorkflowRunUrl,
    HistoryDepth,
  )
}

export async function FinalizePublication(Options: IFinalizeOptions): Promise<number> {
  const Bundle = ResolutionBundleSchema.parse(
    JSON.parse(await readFile(Options.BundlePath, 'utf8')) as unknown,
  )
  if (Bundle.Mode !== 'production' || !Bundle.ShouldPublish) {
    throw new Error('Finalization requires a production bundle selected for publication')
  }
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'browsers-flatpak-publish-'))
  try {
    const Signing = await PrepareSigning(
      Options.SecretSubkeyBase64,
      Options.Passphrase,
      TemporaryDirectory,
    )
    const LinterPath = await CreateMergedLinterFile(TemporaryDirectory)
    const RepositoryPath = join(TemporaryDirectory, 'repo')
    const InternalSiteDirectory = join(TemporaryDirectory, 'site')
    await InitializeRepository(
      RepositoryPath,
      Bundle.CurrentState !== null,
      Signing.Environment,
    )
    await ImportBuildRepositories(
      RepositoryPath,
      Options.BuildArtifactsDirectory,
      Bundle,
      Signing,
    )
    await ValidateCombinedRepository(RepositoryPath, Signing)
    await UpdateRepository(RepositoryPath, Signing, 1, LinterPath)
    let HistoryDepth: 0 | 1 = 1
    let SiteSize = await StageSite(
      InternalSiteDirectory,
      RepositoryPath,
      Bundle,
      Signing,
      Options.WorkflowRunUrl,
      HistoryDepth,
    )
    if (SiteSize > PagesSizeLimitBytes) {
      HistoryDepth = 0
      await UpdateRepository(RepositoryPath, Signing, HistoryDepth, LinterPath)
      SiteSize = await StageSite(
        InternalSiteDirectory,
        RepositoryPath,
        Bundle,
        Signing,
        Options.WorkflowRunUrl,
        HistoryDepth,
      )
    }
    if (SiteSize > PagesSizeLimitBytes) {
      throw new Error(
        `Current publication is ${SiteSize} bytes and exceeds the `
        + `${PagesSizeLimitBytes}-byte Pages budget`,
      )
    }
    const RootEntries = await readdir(InternalSiteDirectory)
    const RequiredRootEntries = [
      'repo',
      'publication-state.json',
      ...DefinitionConfigurations.map(
        (Configuration) => basename(Configuration.FlatpakRefPath),
      ),
    ]
    const MissingRootEntries = RequiredRootEntries.filter(
      (Entry) => !RootEntries.includes(Entry),
    )
    if (MissingRootEntries.length > 0) {
      throw new Error(`Staged Pages site is incomplete: ${MissingRootEntries.join(', ')}`)
    }
    await mkdir(dirname(Options.SiteDirectory), { recursive: true })
    await mkdir(Options.SiteDirectory)
    await CopyRegularTree(InternalSiteDirectory, Options.SiteDirectory)
    return SiteSize
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

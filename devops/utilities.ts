import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  BetaVersionSchema,
  FingerprintSchema,
  NightlyBuildIdSchema,
} from './contracts.js'

type TJsonPrimitive = boolean | number | string | null
export type TJsonValue = TJsonPrimitive | TJsonValue[] | { [Key: string]: TJsonValue }

export interface ICommandOptions {
  Cwd?: string
  Environment?: NodeJS.ProcessEnv
  Input?: string | Uint8Array
  Redactions?: string[]
}

export interface ICommandResult {
  Stdout: string
  Stderr: string
}

function Redact(Value: string, Redactions: string[]): string {
  return Redactions.reduce((Result, Secret) => {
    if (Secret.length === 0) {
      return Result
    }
    return Result.split(Secret).join('***')
  }, Value)
}

export async function RunCommand(
  Command: string,
  CommandArguments: string[],
  Options: ICommandOptions = {},
): Promise<ICommandResult> {
  return await new Promise<ICommandResult>((ResolvePromise, RejectPromise) => {
    const Child = spawn(Command, CommandArguments, {
      cwd: Options.Cwd,
      env: Options.Environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const StdoutChunks: Buffer[] = []
    const StderrChunks: Buffer[] = []

    Child.stdout.on('data', (Chunk: Buffer) => StdoutChunks.push(Chunk))
    Child.stderr.on('data', (Chunk: Buffer) => StderrChunks.push(Chunk))
    Child.on('error', RejectPromise)
    Child.on('close', (Code, Signal) => {
      const Redactions = Options.Redactions ?? []
      const Stdout = Redact(Buffer.concat(StdoutChunks).toString('utf8'), Redactions)
      const Stderr = Redact(Buffer.concat(StderrChunks).toString('utf8'), Redactions)
      if (Code !== 0) {
        RejectPromise(new Error(
          `${Command} exited with ${Code ?? `signal ${Signal ?? 'unknown'}`}\n${Stderr}${Stdout}`,
        ))
        return
      }
      ResolvePromise({ Stdout, Stderr })
    })

    if (Options.Input !== undefined) {
      Child.stdin.write(Options.Input)
    }
    Child.stdin.end()
  })
}

function Canonicalize(Value: TJsonValue): TJsonValue {
  if (Array.isArray(Value)) {
    return Value.map((Item) => Canonicalize(Item))
  }
  if (Value !== null && typeof Value === 'object') {
    return Object.fromEntries(
      Object.entries(Value)
        .sort(([Left], [Right]) => Left.localeCompare(Right))
        .map(([Key, Item]) => [Key, Canonicalize(Item)]),
    )
  }
  return Value
}

export function CanonicalJson(Value: TJsonValue): string {
  return JSON.stringify(Canonicalize(Value))
}

export function PrettyCanonicalJson(Value: TJsonValue): string {
  return `${JSON.stringify(Canonicalize(Value), null, 2)}\n`
}

export function Sha256(Value: string | Uint8Array): string {
  return createHash('sha256').update(Value).digest('hex')
}

export async function ListRegularFiles(Root: string): Promise<string[]> {
  const Results: string[] = []

  async function Visit(Current: string): Promise<void> {
    const Entries = await readdir(Current, { withFileTypes: true })
    Entries.sort((Left, Right) => Left.name.localeCompare(Right.name))
    for (const Entry of Entries) {
      const FullPath = join(Current, Entry.name)
      if (Entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in generated artifacts: ${FullPath}`)
      }
      if (Entry.isDirectory()) {
        await Visit(FullPath)
        continue
      }
      if (!Entry.isFile()) {
        throw new Error(`Non-regular artifact entry is not allowed: ${FullPath}`)
      }
      Results.push(FullPath)
    }
  }

  await Visit(Root)
  return Results
}

export async function HashRegularTree(Root: string): Promise<Record<string, string>> {
  const Result: Record<string, string> = {}
  for (const FilePath of await ListRegularFiles(Root)) {
    const RelativePath = relative(Root, FilePath).split(sep).join('/')
    Result[RelativePath] = Sha256(await readFile(FilePath))
  }
  return Result
}

export async function CopyRegularTree(Source: string, Destination: string): Promise<void> {
  await mkdir(Destination, { recursive: true })
  for (const SourcePath of await ListRegularFiles(Source)) {
    const RelativePath = relative(Source, SourcePath)
    const DestinationPath = join(Destination, RelativePath)
    await mkdir(dirname(DestinationPath), { recursive: true })
    await copyFile(SourcePath, DestinationPath)
    const DestinationStat = await stat(DestinationPath)
    if (DestinationStat.nlink !== 1) {
      throw new Error(`Generated Pages file retained hard links: ${DestinationPath}`)
    }
  }
}

export async function DirectorySize(Root: string): Promise<number> {
  let Total = 0
  for (const FilePath of await ListRegularFiles(Root)) {
    Total += (await stat(FilePath)).size
  }
  return Total
}

export function AssertPathWithin(Base: string, Candidate: string): string {
  const ResolvedBase = resolve(Base)
  const ResolvedCandidate = resolve(Candidate)
  const RelativePath = relative(ResolvedBase, ResolvedCandidate)
  if (
    RelativePath === ''
    || RelativePath === '..'
    || RelativePath.startsWith(`..${sep}`)
    || resolve(ResolvedBase, RelativePath) !== ResolvedCandidate
  ) {
    throw new Error(`Path must be a child of ${ResolvedBase}: ${ResolvedCandidate}`)
  }
  return ResolvedCandidate
}

export function CompareBetaVersions(Left: string, Right: string): number {
  BetaVersionSchema.parse(Left)
  BetaVersionSchema.parse(Right)

  const Parse = (Value: string): { Components: number[], Beta: number } => {
    const [VersionPart, BetaPart] = Value.split('b')
    if (VersionPart === undefined || BetaPart === undefined) {
      throw new Error(`Invalid beta version: ${Value}`)
    }
    return {
      Components: VersionPart.split('.').map((Part) => Number.parseInt(Part, 10)),
      Beta: Number.parseInt(BetaPart, 10),
    }
  }

  const LeftParsed = Parse(Left)
  const RightParsed = Parse(Right)
  const Length = Math.max(LeftParsed.Components.length, RightParsed.Components.length)
  for (let Index = 0; Index < Length; Index += 1) {
    const Difference = (LeftParsed.Components[Index] ?? 0) - (RightParsed.Components[Index] ?? 0)
    if (Difference !== 0) {
      return Math.sign(Difference)
    }
  }
  return Math.sign(LeftParsed.Beta - RightParsed.Beta)
}

export function CompareNightlyBuildIds(Left: string, Right: string): number {
  NightlyBuildIdSchema.parse(Left)
  NightlyBuildIdSchema.parse(Right)
  return Math.sign(Left.localeCompare(Right))
}

export async function ReadFingerprintFile(
  FingerprintPath: string,
): Promise<{ Primary: string, Signing: string, TrustedSigning: string[] }> {
  const Content = await readFile(FingerprintPath, 'utf8')
  const Values = Object.fromEntries(
    Content
      .split(/\r?\n/u)
      .filter((Line) => Line.includes('='))
      .map((Line) => {
        const Separator = Line.indexOf('=')
        return [Line.slice(0, Separator), Line.slice(Separator + 1)]
      }),
  )
  const Signing = FingerprintSchema.parse(Values.Signing)
  const TrustedSigning = (Values.TrustedSigning ?? Signing)
    .split(',')
    .map((Fingerprint) => FingerprintSchema.parse(Fingerprint))
  if (!TrustedSigning.includes(Signing) || new Set(TrustedSigning).size !== TrustedSigning.length) {
    throw new Error('TrustedSigning must be unique and include the active signing fingerprint')
  }
  return { Primary: FingerprintSchema.parse(Values.Primary), Signing, TrustedSigning }
}

async function VerifyDetachedPaths(
  DataPath: string,
  SignaturePath: string,
  PublicKeyPath: string,
  ExpectedPrimaryFingerprint: string,
  ExpectedSigningFingerprints: string | readonly string[],
): Promise<void> {
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'browsers-flatpak-verify-'))
  const GnuPgHome = join(TemporaryDirectory, 'gnupg')
  await mkdir(GnuPgHome, { recursive: true })
  await chmod(GnuPgHome, 0o700)

  try {
    await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--import',
      PublicKeyPath,
    ])
    const Verification = await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--status-fd',
      '1',
      '--verify',
      SignaturePath,
      DataPath,
    ])
    const ValidSignature = Verification.Stdout
      .split(/\r?\n/u)
      .find((Line) => Line.startsWith('[GNUPG:] VALIDSIG '))
    if (ValidSignature === undefined) {
      throw new Error('GPG verification succeeded without a VALIDSIG status record')
    }
    const Fields = ValidSignature.split(/\s+/u)
    const SigningFingerprint = Fields[2]
    const PrimaryFingerprint = Fields.at(-1)
    const AllowedSigningFingerprints = typeof ExpectedSigningFingerprints === 'string'
      ? [ExpectedSigningFingerprints]
      : ExpectedSigningFingerprints
    if (
      SigningFingerprint === undefined
      || !AllowedSigningFingerprints.includes(SigningFingerprint)
      || PrimaryFingerprint !== ExpectedPrimaryFingerprint
    ) {
      throw new Error(
        `Unexpected signature identity: signing=${SigningFingerprint ?? 'missing'} `
        + `primary=${PrimaryFingerprint ?? 'missing'}`,
      )
    }
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

export async function VerifyDetachedSignature(
  Data: string | Uint8Array,
  Signature: string | Uint8Array,
  PublicKeyPath: string,
  ExpectedPrimaryFingerprint: string,
  ExpectedSigningFingerprints: string | readonly string[],
): Promise<void> {
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'browsers-flatpak-data-'))
  const DataPath = join(TemporaryDirectory, 'signed-data')
  const SignaturePath = join(TemporaryDirectory, 'signed-data.asc')
  try {
    await writeFile(DataPath, Data)
    await writeFile(SignaturePath, Signature)
    await VerifyDetachedPaths(
      DataPath,
      SignaturePath,
      PublicKeyPath,
      ExpectedPrimaryFingerprint,
      ExpectedSigningFingerprints,
    )
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

export async function VerifyDetachedFileSignature(
  DataPath: string,
  Signature: string | Uint8Array,
  PublicKeyPath: string,
  ExpectedPrimaryFingerprint: string,
  ExpectedSigningFingerprints: string | readonly string[],
): Promise<void> {
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'browsers-flatpak-signature-'))
  const SignaturePath = join(TemporaryDirectory, 'signed-data.asc')
  try {
    await writeFile(SignaturePath, Signature)
    await VerifyDetachedPaths(
      DataPath,
      SignaturePath,
      PublicKeyPath,
      ExpectedPrimaryFingerprint,
      ExpectedSigningFingerprints,
    )
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

export function EscapeHtml(Value: string): string {
  return Value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

export function SafeBasename(Value: string): string {
  if (Value !== basename(Value) || Value.includes('\0')) {
    throw new Error(`Unsafe filename: ${Value}`)
  }
  return Value
}

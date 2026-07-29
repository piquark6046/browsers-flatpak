import { randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FilterArgumentsForOptions,
  ParseArgumentsAndOptions,
} from '@typescriptprime/parsing'
import { z } from 'zod'
import {
  DefinitionConfigurations,
  RepositoryFingerprintPath,
  RepositoryPublicKeyPath,
  RepositoryRoot,
} from './paths.js'
import { FlatpakRef } from './upstream.js'
import { RunCommand } from './utilities.js'

const KeyUid =
  'browsers-flatpak repository signing <piquark6046@users.noreply.github.com>'
const DefaultOutputDirectory = join(RepositoryRoot, '.agents/temp/browsers-flatpak-signing-key')

const OptionsSchema = z.object({
  OutputDirectory: z.string().optional(),
})

interface IKeyListing {
  PrimaryFingerprint: string
  SigningFingerprint: string
  SigningExpiry: number
}

function ParseKeyListing(Listing: string): IKeyListing {
  let PrimaryFingerprint: string | undefined
  let SigningFingerprint: string | undefined
  let SigningExpiry: number | undefined
  let Pending: 'primary' | 'signing' | undefined
  for (const Line of Listing.split(/\r?\n/u)) {
    const Fields = Line.split(':')
    if (Fields[0] === 'sec') {
      Pending = 'primary'
    } else if (Fields[0] === 'ssb') {
      if (!(Fields[11] ?? '').includes('s')) {
        throw new Error('The generated subkey is not signing-capable')
      }
      SigningExpiry = Number.parseInt(Fields[6] ?? '', 10)
      Pending = 'signing'
    } else if (Fields[0] === 'fpr' && Fields[9] !== undefined) {
      if (Pending === 'primary') {
        PrimaryFingerprint = Fields[9]
      } else if (Pending === 'signing') {
        SigningFingerprint = Fields[9]
      }
      Pending = undefined
    }
  }
  if (
    PrimaryFingerprint === undefined
    || SigningFingerprint === undefined
    || SigningExpiry === undefined
    || !Number.isSafeInteger(SigningExpiry)
    || SigningExpiry === 0
  ) {
    throw new Error('Could not identify the generated primary key and signing subkey')
  }
  return { PrimaryFingerprint, SigningFingerprint, SigningExpiry }
}

async function Main(): Promise<void> {
  const Parsed = await ParseArgumentsAndOptions(
    process.argv.length > 2 ? FilterArgumentsForOptions(process.argv) : [],
  )
  const Options = OptionsSchema.parse(Parsed.Options)
  if (Parsed.Positional.length !== 0) {
    throw new Error(`Unexpected positional arguments: ${Parsed.Positional.join(', ')}`)
  }
  const OutputDirectory = Options.OutputDirectory ?? DefaultOutputDirectory
  const TemporaryDirectory = await mkdtemp(join(tmpdir(), 'bflatpak-key-'))
  const GnuPgHome = join(TemporaryDirectory, 'gnupg')
  const Passphrase = randomBytes(36).toString('base64url')

  await mkdir(dirname(OutputDirectory), { recursive: true })
  await mkdir(OutputDirectory, { recursive: false })
  await mkdir(GnuPgHome)
  await chmod(OutputDirectory, 0o700)
  await chmod(GnuPgHome, 0o700)
  const Redactions = [Passphrase]
  try {
    await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--pinentry-mode',
      'loopback',
      '--passphrase-fd',
      '0',
      '--quick-generate-key',
      KeyUid,
      'ed25519',
      'cert',
      '0',
    ], { Input: `${Passphrase}\n`, Redactions })
    const PrimaryListing = await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--with-colons',
      '--fingerprint',
      '--list-secret-keys',
      KeyUid,
    ], { Redactions })
    const PrimaryFingerprint = PrimaryListing.Stdout
      .split(/\r?\n/u)
      .find((Line) => Line.startsWith('fpr:'))
      ?.split(':')[9]
    if (PrimaryFingerprint === undefined) {
      throw new Error('Could not identify the generated primary key')
    }
    await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--pinentry-mode',
      'loopback',
      '--passphrase-fd',
      '0',
      '--quick-add-key',
      PrimaryFingerprint,
      'ed25519',
      'sign',
      '3y',
    ], { Input: `${Passphrase}\n`, Redactions })
    const Listing = await RunCommand('gpg', [
      '--batch',
      '--homedir',
      GnuPgHome,
      '--with-colons',
      '--fingerprint',
      '--list-secret-keys',
      PrimaryFingerprint,
    ], { Redactions })
    const Key = ParseKeyListing(Listing.Stdout)
    const PublicKey = await RunCommand('gpg', [
      '--batch',
      '--armor',
      '--homedir',
      GnuPgHome,
      '--export',
      Key.PrimaryFingerprint,
    ], { Redactions })
    const FullSecretKey = await RunCommand('gpg', [
      '--batch',
      '--armor',
      '--homedir',
      GnuPgHome,
      '--pinentry-mode',
      'loopback',
      '--passphrase-fd',
      '0',
      '--export-secret-keys',
      Key.PrimaryFingerprint,
    ], { Input: `${Passphrase}\n`, Redactions })
    const SecretSubkeys = await RunCommand('gpg', [
      '--batch',
      '--armor',
      '--homedir',
      GnuPgHome,
      '--pinentry-mode',
      'loopback',
      '--passphrase-fd',
      '0',
      '--export-secret-subkeys',
      Key.PrimaryFingerprint,
    ], { Input: `${Passphrase}\n`, Redactions })

    const PublicKeyExportPath = join(OutputDirectory, 'browsers-flatpak-signing-key.asc')
    const FullSecretKeyPath = join(OutputDirectory, 'browsers-flatpak-primary-secret-key.asc')
    const SecretSubkeysPath = join(OutputDirectory, 'browsers-flatpak-ci-secret-subkeys.asc')
    await writeFile(PublicKeyExportPath, PublicKey.Stdout, { mode: 0o644 })
    await writeFile(FullSecretKeyPath, FullSecretKey.Stdout, { mode: 0o600 })
    await writeFile(SecretSubkeysPath, SecretSubkeys.Stdout, { mode: 0o600 })
    await cp(
      join(GnuPgHome, 'openpgp-revocs.d', `${Key.PrimaryFingerprint}.rev`),
      join(OutputDirectory, 'browsers-flatpak-primary-key.rev'),
    )
    const SecretSubkeyBase64 = Buffer.from(SecretSubkeys.Stdout, 'utf8').toString('base64')
    await writeFile(
      join(OutputDirectory, 'github-actions-secrets.env'),
      `FLATPAK_GPG_SECRET_SUBKEY_B64=${SecretSubkeyBase64}\n`
      + `FLATPAK_GPG_PASSPHRASE=${Passphrase}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(OutputDirectory, 'README.txt'),
      `Signing identity: ${KeyUid}\n`
      + `Primary fingerprint: ${Key.PrimaryFingerprint}\n`
      + `CI signing fingerprint: ${Key.SigningFingerprint}\n`
      + `CI signing subkey expires (Unix time): ${Key.SigningExpiry}\n\n`
      + 'Keep this entire directory offline and private. Store only the two values from\n'
      + 'github-actions-secrets.env in the protected flatpak-signing environment.\n',
      { mode: 0o600 },
    )

    await mkdir(join(RepositoryPublicKeyPath, '..'), { recursive: true })
    await writeFile(RepositoryPublicKeyPath, PublicKey.Stdout)
    await writeFile(
      RepositoryFingerprintPath,
      `Primary=${Key.PrimaryFingerprint}\n`
      + `Signing=${Key.SigningFingerprint}\n`
      + `TrustedSigning=${Key.SigningFingerprint}\n`,
    )
    const BinaryPublicKeyPath = join(OutputDirectory, 'browsers-flatpak-signing-key.gpg')
    await RunCommand('gpg', [
      '--batch',
      '--yes',
      '--dearmor',
      '--output',
      BinaryPublicKeyPath,
      PublicKeyExportPath,
    ], { Redactions })
    const PublicKeyBase64 = (await readFile(BinaryPublicKeyPath)).toString('base64')
    await Promise.all(DefinitionConfigurations.map(async (Configuration) =>
      await writeFile(
        Configuration.FlatpakRefPath,
        FlatpakRef(PublicKeyBase64, Configuration),
      )))
    await rm(BinaryPublicKeyPath, { force: true })

    process.stdout.write(
      `Created protected signing exports in ${OutputDirectory}\n`
      + `Primary fingerprint: ${Key.PrimaryFingerprint}\n`
      + `CI signing fingerprint: ${Key.SigningFingerprint}\n`,
    )
  } catch (CatchValue) {
    await rm(OutputDirectory, { recursive: true, force: true })
    throw CatchValue
  } finally {
    await rm(TemporaryDirectory, { recursive: true, force: true })
  }
}

Main().catch((CatchValue: unknown) => {
  process.stderr.write(
    `${CatchValue instanceof globalThis.Error
      ? CatchValue.stack ?? CatchValue.message
      : String(CatchValue)}\n`,
  )
  process.exitCode = 1
})

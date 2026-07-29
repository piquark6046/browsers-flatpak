import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  Architectures,
  CollectionId,
  DeveloperAppId,
  DeveloperDefinitionName,
  LegacyPublicationStateSchema,
  NightlyAppId,
  NightlyDefinitionName,
  PublicationStateSchema,
  RepositoryName,
  RepositoryUrl,
  ResolutionBundleSchema,
  SchemaVersion,
  type TDefinitionResolution,
  type TPublicationState,
} from './contracts.js'
import {
  DeveloperConfiguration,
  NightlyConfiguration,
} from './paths.js'
import { LandingPage } from './publication.js'
import {
  CreatePublicationState,
  MigrateLegacyState,
  ParseChecksumFile,
  ParseNightlyChecksumFile,
  PatchManifest,
  PatchMetainfo,
  ShouldBuildDefinition,
} from './upstream.js'
import {
  CanonicalJson,
  CompareBetaVersions,
  CompareNightlyBuildIds,
  Sha256,
} from './utilities.js'

test('Firefox version and Nightly build comparisons are numeric and chronological', () => {
  assert.equal(CompareBetaVersions('154.0b10', '154.0b2'), 1)
  assert.equal(CompareBetaVersions('155.0b1', '154.9b99'), 1)
  assert.equal(CompareBetaVersions('154.0b2', '154.0b2'), 0)
  assert.equal(CompareBetaVersions('154.0b1', '154.0b2'), -1)
  assert.equal(CompareNightlyBuildIds('20260729010203', '20260728235959'), 1)
  assert.equal(CompareNightlyBuildIds('20260728214328', '20260728214328'), 0)
  assert.equal(CompareNightlyBuildIds('20260727000000', '20260728214328'), -1)
})

test('canonical JSON and SHA-256 are deterministic', () => {
  const Left = CanonicalJson({ Beta: [2, 1], Alpha: 'value' })
  const Right = CanonicalJson({ Alpha: 'value', Beta: [2, 1] })
  assert.equal(Left, '{"Alpha":"value","Beta":[2,1]}')
  assert.equal(Left, Right)
  assert.equal(Sha256(Left), Sha256(Right))
})

test('checksum parsers reject malformed, duplicate, and unsafe paths', () => {
  const Hash = 'a'.repeat(64)
  assert.deepEqual(
    [...ParseChecksumFile(`${Hash}  linux/file.tar.xz\n`, 'sha256')],
    [['linux/file.tar.xz', Hash]],
  )
  assert.deepEqual(
    [...ParseNightlyChecksumFile(`${Hash} sha256 123 file.tar.xz\n`)],
    [['sha256:file.tar.xz', Hash]],
  )
  assert.throws(
    () => ParseChecksumFile(`${Hash}  ../file\n`, 'sha256'),
    /Unsafe or duplicate/u,
  )
  assert.throws(
    () => ParseNightlyChecksumFile(`${Hash} sha256 123 ../file\n`),
    /Unsafe or duplicate/u,
  )
  assert.throws(
    () => ParseNightlyChecksumFile(
      `${Hash} sha256 123 file\n${Hash} sha256 123 file\n`,
    ),
    /Unsafe or duplicate/u,
  )
  assert.throws(
    () => ParseNightlyChecksumFile('not-a-checksum\n'),
    /Malformed/u,
  )
})

test('Developer Edition manifest patching is architecture-specific and ephemeral', async () => {
  const ManifestPath = join(
    DeveloperConfiguration.Directory,
    DeveloperConfiguration.ManifestFilename,
  )
  const Manifest = await readFile(ManifestPath, 'utf8')
  const Facts = {
    Definition: DeveloperDefinitionName,
    Version: '999.0b4',
    ReleaseDate: '2026-12-31',
    Architectures: Architectures.map((Architecture, Index) => ({
      Architecture,
      ArchiveUrl:
        `https://download-installer.cdn.mozilla.net/releases/999.0b4/${Architecture}/archive.tar.xz`,
      ArchiveSha256: String(Index + 1).repeat(64),
      LanguagePacks: [{
        Architecture,
        Locale: 'fr',
        Url: `https://download-installer.cdn.mozilla.net/${Architecture}/fr.xpi`,
        Sha512: String(Index + 3).repeat(128),
        DestinationFilename: 'langpack-fr@devedition.mozilla.org.xpi',
      }],
    })),
  } as const
  const Patched = PatchManifest(Manifest, Facts)
  assert.match(Patched, /999\.0b4/u)
  assert.match(Patched, /only-arches:\n\s+- x86_64/u)
  assert.match(Patched, /only-arches:\n\s+- aarch64/u)
  assert.equal((Patched.match(/dest-filename: langpack-fr/gu) ?? []).length, 2)
  assert.doesNotMatch(Manifest, /999\.0b4/u)
})

test('Nightly manifest patching preserves upstream language-pack IDs', async () => {
  const ManifestPath = join(
    NightlyConfiguration.Directory,
    NightlyConfiguration.ManifestFilename,
  )
  const Manifest = await readFile(ManifestPath, 'utf8')
  const Facts = {
    Definition: NightlyDefinitionName,
    Version: '999.0a1',
    ReleaseDate: '2026-12-31',
    BuildId: '20261231235959',
    SourceRevision: 'a'.repeat(40),
    Architectures: Architectures.map((Architecture, Index) => ({
      Architecture,
      ArchiveUrl:
        `https://archive.mozilla.org/pub/firefox/nightly/2026/12/build/firefox-999.0a1.en-US.linux-${Architecture}.tar.xz`,
      ArchiveSha256: String(Index + 1).repeat(64),
      LanguagePacks: [{
        Architecture,
        Locale: 'fr',
        Url: 'https://archive.mozilla.org/pub/firefox/nightly/build-l10n/fr.xpi',
        Sha512: 'f'.repeat(128),
        DestinationFilename: 'langpack-fr@firefox.mozilla.org.xpi',
      }],
    })),
  } as const
  const Patched = PatchManifest(Manifest, Facts)
  assert.match(Patched, /999\.0a1/u)
  assert.equal(
    (Patched.match(/dest-filename: langpack-fr@firefox\.mozilla\.org\.xpi/gu) ?? [])
      .length,
    2,
  )
  assert.match(Manifest, /2026-07-28-21-43-28-mozilla-central/u)
})

test('AppStream patch requires one self-closing release', () => {
  const Input =
    '<component><releases><release version="1.0b1" date="2026-01-01"/></releases></component>'
  assert.equal(
    PatchMetainfo(Input, '2.0b1', '2026-02-02'),
    '<component><releases>\n    <release version="2.0b1" date="2026-02-02"/>\n  </releases></component>',
  )
  assert.throws(
    () => PatchMetainfo('<component><releases/></component>', '2.0b1', '2026-02-02'),
    /exactly one/u,
  )
})

function DeveloperResolution(
  Fingerprint: string,
  Version = '154.0b3',
): TDefinitionResolution {
  return {
    Variant: 'production',
    Definition: DeveloperDefinitionName,
    AppId: DeveloperAppId,
    Branch: 'stable',
    Version,
    ReleaseDate: '2026-07-27',
    Fingerprint,
    PatchedDefinitionPath: 'production/firefox/dev',
    ManifestPath: `production/firefox/dev/${DeveloperAppId}.yaml`,
    LinterPath: 'production/firefox/dev/linter.json',
    Architectures: Architectures.map((Architecture, Index) => ({
      Architecture,
      ArchiveUrl: `https://example.com/dev-${Architecture}.tar.xz`,
      ArchiveSha256: String(Index + 1).repeat(64),
      LanguagePacks: [],
    })),
  }
}

function NightlyResolution(
  Fingerprint: string,
  BuildId = '20260728214328',
  SourceRevision = 'b'.repeat(40),
): TDefinitionResolution {
  return {
    Variant: 'production',
    Definition: NightlyDefinitionName,
    AppId: NightlyAppId,
    Branch: 'stable',
    Version: '155.0a1',
    ReleaseDate: '2026-07-28',
    BuildId,
    SourceRevision,
    Fingerprint,
    PatchedDefinitionPath: 'production/firefox/nightly',
    ManifestPath: `production/firefox/nightly/${NightlyAppId}.yaml`,
    LinterPath: 'production/firefox/nightly/linter.json',
    Architectures: Architectures.map((Architecture, Index) => ({
      Architecture,
      ArchiveUrl: `https://example.com/nightly-${Architecture}.tar.xz`,
      ArchiveSha256: String(Index + 3).repeat(64),
      LanguagePacks: [],
    })),
  }
}

function PublishedState(
  DeveloperFingerprint = 'a'.repeat(64),
  NightlyFingerprint = 'b'.repeat(64),
): TPublicationState {
  return PublicationStateSchema.parse({
    SchemaVersion,
    Repository: RepositoryName,
    CollectionId,
    RepositoryUrl,
    SourceRevision: 'c'.repeat(40),
    WorkflowRunUrl: 'https://github.com/piquark6046/browsers-flatpak/actions/runs/1',
    PublishedAt: '2026-07-28T00:00:00.000Z',
    RetainedHistoryDepth: 1,
    SiteSizeBytes: 123,
    Definitions: [
      {
        Definition: DeveloperDefinitionName,
        AppId: DeveloperAppId,
        Branch: 'stable',
        Version: '154.0b3',
        ReleaseDate: '2026-07-27',
        Fingerprint: DeveloperFingerprint,
        Architectures,
      },
      {
        Definition: NightlyDefinitionName,
        AppId: NightlyAppId,
        Branch: 'stable',
        Version: '155.0a1',
        ReleaseDate: '2026-07-28',
        BuildId: '20260728214328',
        SourceRevision: 'b'.repeat(40),
        Fingerprint: NightlyFingerprint,
        Architectures,
      },
    ],
  })
}

test('publication gates changed definitions and protects channel downgrades', () => {
  const State = PublishedState()
  assert.equal(
    ShouldBuildDefinition(State, DeveloperResolution('a'.repeat(64)), false, false),
    false,
  )
  assert.equal(
    ShouldBuildDefinition(State, NightlyResolution('b'.repeat(64)), false, false),
    false,
  )
  assert.equal(
    ShouldBuildDefinition(State, NightlyResolution('c'.repeat(64)), false, false),
    true,
  )
  assert.equal(
    ShouldBuildDefinition(State, DeveloperResolution('a'.repeat(64)), true, false),
    true,
  )
  assert.throws(
    () => ShouldBuildDefinition(
      State,
      DeveloperResolution('d'.repeat(64), '154.0b2'),
      false,
      false,
    ),
    /Refusing firefox\/dev downgrade/u,
  )
  assert.throws(
    () => ShouldBuildDefinition(
      State,
      NightlyResolution('d'.repeat(64), '20260727214328'),
      false,
      false,
    ),
    /Refusing firefox\/nightly downgrade/u,
  )
  assert.throws(
    () => ShouldBuildDefinition(
      State,
      NightlyResolution('d'.repeat(64), '20260728214328', 'd'.repeat(40)),
      false,
      true,
    ),
    /changed source revision/u,
  )
})

test('legacy dev-only state migrates without bootstrap and v2 records both channels', () => {
  const Legacy = LegacyPublicationStateSchema.parse({
    SchemaVersion: 1,
    Repository: RepositoryName,
    CollectionId,
    RepositoryUrl,
    SourceRevision: 'a'.repeat(40),
    WorkflowRunUrl: 'https://github.com/piquark6046/browsers-flatpak/actions/runs/1',
    PublishedAt: '2026-07-28T00:00:00.000Z',
    RetainedHistoryDepth: 1,
    SiteSizeBytes: 123,
    Definitions: [{
      Definition: DeveloperDefinitionName,
      AppId: DeveloperAppId,
      Branch: 'stable',
      Version: '154.0b3',
      ReleaseDate: '2026-07-27',
      Fingerprint: 'a'.repeat(64),
      Architectures,
    }],
  })
  const Migrated = MigrateLegacyState(Legacy)
  assert.equal(Migrated.SchemaVersion, 2)
  assert.equal(Migrated.Definitions.length, 1)

  const Bundle = ResolutionBundleSchema.parse({
    SchemaVersion,
    Mode: 'production',
    ShouldPublish: true,
    Bootstrap: false,
    Forced: false,
    SourceRevision: 'e'.repeat(40),
    SiteUrl: 'https://piquark6046.github.io/browsers-flatpak/',
    RepositoryUrl,
    CurrentState: Migrated,
    Resolutions: [
      DeveloperResolution('c'.repeat(64)),
      NightlyResolution('d'.repeat(64)),
    ],
    Matrix: { include: [] },
  })
  const Next = CreatePublicationState(
    Bundle,
    'https://github.com/piquark6046/browsers-flatpak/actions/runs/2',
    '2026-07-29T00:00:00.000Z',
    1,
    456,
  )
  assert.equal(Next.SchemaVersion, 2)
  assert.deepEqual(
    Next.Definitions.map((Definition) => Definition.Definition),
    [DeveloperDefinitionName, NightlyDefinitionName],
  )
  assert.equal(Next.Definitions[1]?.Definition, NightlyDefinitionName)
  if (Next.Definitions[1]?.Definition === NightlyDefinitionName) {
    assert.equal(Next.Definitions[1].BuildId, '20260728214328')
  }
  const Page = LandingPage(Bundle)
  assert.match(Page, /Firefox Developer Edition 154\.0b3/u)
  assert.match(Page, /Firefox Nightly 155\.0a1/u)
  assert.match(Page, /Mozilla build: <code>20260728214328<\/code>/u)
  assert.match(Page, /dev\.piquark6046\.Firefox\.Dev\.flatpakref/u)
  assert.match(Page, /dev\.piquark6046\.Firefox\.Nightly\.flatpakref/u)
})

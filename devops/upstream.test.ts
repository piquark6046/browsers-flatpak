import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Architectures, type TPublicationState } from './contracts.js'
import { FirefoxManifestPath } from './paths.js'
import {
  ParseChecksumFile,
  PatchManifest,
  PatchMetainfo,
  ShouldPublish,
} from './upstream.js'
import {
  CanonicalJson,
  CompareBetaVersions,
  Sha256,
} from './utilities.js'

test('beta versions compare numeric components and beta sequence', () => {
  assert.equal(CompareBetaVersions('154.0b10', '154.0b2'), 1)
  assert.equal(CompareBetaVersions('155.0b1', '154.9b99'), 1)
  assert.equal(CompareBetaVersions('154.0b2', '154.0b2'), 0)
  assert.equal(CompareBetaVersions('154.0b1', '154.0b2'), -1)
})

test('canonical JSON and SHA-256 are deterministic', () => {
  const Left = CanonicalJson({ Beta: [2, 1], Alpha: 'value' })
  const Right = CanonicalJson({ Alpha: 'value', Beta: [2, 1] })
  assert.equal(Left, '{"Alpha":"value","Beta":[2,1]}')
  assert.equal(Left, Right)
  assert.equal(Sha256(Left), Sha256(Right))
})

test('signed checksum parser rejects malformed, duplicate, and unsafe paths', () => {
  const Hash = 'a'.repeat(64)
  assert.deepEqual(
    [...ParseChecksumFile(`${Hash}  linux/file.tar.xz\n`, 'sha256')],
    [['linux/file.tar.xz', Hash]],
  )
  assert.throws(
    () => ParseChecksumFile(`${Hash}  ../file\n`, 'sha256'),
    /Unsafe or duplicate/u,
  )
  assert.throws(
    () => ParseChecksumFile(`${Hash}  file\n${Hash}  file\n`, 'sha256'),
    /Unsafe or duplicate/u,
  )
  assert.throws(
    () => ParseChecksumFile('not-a-checksum\n', 'sha256'),
    /Malformed/u,
  )
})

test('Firefox manifest patching is architecture-specific and ephemeral', async () => {
  const Manifest = await readFile(FirefoxManifestPath, 'utf8')
  const Facts = {
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
  }
  const Patched = PatchManifest(Manifest, Facts)
  assert.match(Patched, /999\.0b4/u)
  assert.match(Patched, /only-arches:\n\s+- x86_64/u)
  assert.match(Patched, /only-arches:\n\s+- aarch64/u)
  assert.equal((Patched.match(/dest-filename: langpack-fr/gu) ?? []).length, 2)
  assert.match(Manifest, /154\.0b2/u)
})

test('AppStream patch requires one self-closing release', () => {
  const Input = '<component><releases><release version="1.0b1" date="2026-01-01"/></releases></component>'
  assert.equal(
    PatchMetainfo(Input, '2.0b1', '2026-02-02'),
    '<component><releases>\n    <release version="2.0b1" date="2026-02-02"/>\n  </releases></component>',
  )
  assert.throws(
    () => PatchMetainfo('<component><releases/></component>', '2.0b1', '2026-02-02'),
    /exactly one/u,
  )
})

function PublishedState(Version: string, Fingerprint: string): TPublicationState {
  return {
    SchemaVersion: 1,
    Repository: 'piquark6046/browsers-flatpak',
    CollectionId: 'dev.piquark6046.Browsers',
    RepositoryUrl: 'https://piquark6046.github.io/browsers-flatpak/repo/',
    SourceRevision: 'a'.repeat(40),
    WorkflowRunUrl: 'https://github.com/piquark6046/browsers-flatpak/actions/runs/1',
    PublishedAt: '2026-07-28T00:00:00.000Z',
    RetainedHistoryDepth: 1,
    SiteSizeBytes: 123,
    Definitions: [{
      Definition: 'firefox/dev',
      AppId: 'dev.piquark6046.Firefox.Dev',
      Branch: 'stable',
      Version,
      ReleaseDate: '2026-07-28',
      Fingerprint,
      Architectures: ['x86_64', 'aarch64'],
    }],
  }
}

test('publication gate compares output fingerprints and protects downgrades', () => {
  const CurrentFingerprint = 'a'.repeat(64)
  const Resolution = {
    Variant: 'production' as const,
    Definition: 'firefox/dev' as const,
    AppId: 'dev.piquark6046.Firefox.Dev' as const,
    Branch: 'stable' as const,
    Version: '154.0b2',
    ReleaseDate: '2026-07-28',
    Fingerprint: CurrentFingerprint,
    PatchedDefinitionPath: '/tmp/definition',
    ManifestPath: '/tmp/definition/manifest.yaml',
    Architectures: [],
  }
  assert.equal(ShouldPublish(PublishedState('154.0b2', CurrentFingerprint), Resolution, false, false), false)
  assert.equal(ShouldPublish(PublishedState('154.0b2', CurrentFingerprint), Resolution, true, false), true)
  assert.equal(
    ShouldPublish(
      PublishedState('154.0b2', CurrentFingerprint),
      { ...Resolution, Fingerprint: 'b'.repeat(64) },
      false,
      false,
    ),
    true,
  )
  assert.throws(
    () => ShouldPublish(
      PublishedState('155.0b1', CurrentFingerprint),
      Resolution,
      false,
      false,
    ),
    /Refusing downgrade/u,
  )
  assert.equal(
    ShouldPublish(PublishedState('155.0b1', CurrentFingerprint), Resolution, false, true),
    false,
  )
})

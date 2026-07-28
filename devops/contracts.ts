import { z } from 'zod'

export const SchemaVersion = 1
export const RepositoryName = 'piquark6046/browsers-flatpak'
export const DefinitionName = 'firefox/dev'
export const AppId = 'dev.piquark6046.Firefox.Dev'
export const FlatpakBranch = 'stable'
export const CollectionId = 'dev.piquark6046.Browsers'
export const SuggestedRemoteName = 'browsers-flatpak'
export const SiteUrl = 'https://piquark6046.github.io/browsers-flatpak/'
export const RepositoryUrl = `${SiteUrl}repo/`
export const StateUrl = `${SiteUrl}publication-state.json`
export const StateSignatureUrl = `${StateUrl}.asc`
export const RuntimeRepositoryUrl = 'https://dl.flathub.org/repo/flathub.flatpakrepo'
export const PagesSizeLimitBytes = 900 * 1024 * 1024

export const MozillaPrimaryFingerprint = '14F26682D0916CDD81E37B6D61B7B526D98F0353'
export const MozillaSigningFingerprint = '09BEED63F3462A2DFFAB3B875ECB6497C1A20256'

export const ArchitectureSchema = z.enum(['x86_64', 'aarch64'])
export type TArchitecture = z.infer<typeof ArchitectureSchema>

export const Architectures: readonly TArchitecture[] = ['x86_64', 'aarch64']

export const BuildImageByArchitecture: Readonly<Record<TArchitecture, string>> = {
  x86_64: 'ghcr.io/flathub-infra/flatpak-github-actions@sha256:f584c1b5d516b413993557f9f88d2532e32888386e043ce4c8c4afeaf771c6b9',
  aarch64: 'ghcr.io/flathub-infra/flatpak-github-actions@sha256:e3c5b58822c171715d147b43a140c7cc9848fa2e605490a5bc8bd65e3b6069a1',
}

export const BetaVersionSchema = z.string().regex(/^[0-9]+(?:\.[0-9]+)*b[0-9]+$/u)
export const IsoDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
export const Sha512Schema = z.string().regex(/^[a-f0-9]{128}$/u)
export const FingerprintSchema = z.string().regex(/^[A-F0-9]{40,64}$/u)

export const LanguagePackSourceSchema = z.object({
  Architecture: ArchitectureSchema,
  Locale: z.string().min(1),
  Url: z.string().url(),
  Sha512: Sha512Schema,
  DestinationFilename: z.string().min(1),
})

export const ArchitectureResolutionSchema = z.object({
  Architecture: ArchitectureSchema,
  ArchiveUrl: z.string().url(),
  ArchiveSha256: Sha256Schema,
  LanguagePacks: z.array(LanguagePackSourceSchema),
})

export const DefinitionResolutionSchema = z.object({
  Variant: z.enum(['production', 'tracked', 'latest']),
  Definition: z.literal(DefinitionName),
  AppId: z.literal(AppId),
  Branch: z.literal(FlatpakBranch),
  Version: BetaVersionSchema,
  ReleaseDate: IsoDateSchema,
  Fingerprint: Sha256Schema,
  PatchedDefinitionPath: z.string().min(1),
  ManifestPath: z.string().min(1),
  Architectures: z.array(ArchitectureResolutionSchema).length(Architectures.length),
})
export type TDefinitionResolution = z.infer<typeof DefinitionResolutionSchema>

export const BuildMatrixEntrySchema = z.object({
  Variant: z.enum(['production', 'tracked', 'latest']),
  Architecture: ArchitectureSchema,
  Definition: z.literal(DefinitionName),
  DefinitionPath: z.string().min(1),
  ManifestPath: z.string().min(1),
  ArtifactName: z.string().min(1),
  Image: z.string().min(1),
  Runner: z.enum(['ubuntu-24.04', 'ubuntu-24.04-arm']),
  Version: BetaVersionSchema,
})
export type TBuildMatrixEntry = z.infer<typeof BuildMatrixEntrySchema>

export const PublicationDefinitionSchema = z.object({
  Definition: z.literal(DefinitionName),
  AppId: z.literal(AppId),
  Branch: z.literal(FlatpakBranch),
  Version: BetaVersionSchema,
  ReleaseDate: IsoDateSchema,
  Fingerprint: Sha256Schema,
  Architectures: z.array(ArchitectureSchema).length(Architectures.length),
})

export const PublicationStateSchema = z.object({
  SchemaVersion: z.literal(SchemaVersion),
  Repository: z.literal(RepositoryName),
  CollectionId: z.literal(CollectionId),
  RepositoryUrl: z.literal(RepositoryUrl),
  SourceRevision: z.string().min(1),
  WorkflowRunUrl: z.string().url(),
  PublishedAt: z.string().datetime(),
  RetainedHistoryDepth: z.number().int().min(0).max(1),
  SiteSizeBytes: z.number().int().nonnegative(),
  Definitions: z.array(PublicationDefinitionSchema).min(1),
})
export type TPublicationState = z.infer<typeof PublicationStateSchema>

export const ResolutionBundleSchema = z.object({
  SchemaVersion: z.literal(SchemaVersion),
  Mode: z.enum(['production', 'pr']),
  ShouldPublish: z.boolean(),
  Bootstrap: z.boolean(),
  Forced: z.boolean(),
  SourceRevision: z.string().min(1),
  SiteUrl: z.literal(SiteUrl),
  RepositoryUrl: z.literal(RepositoryUrl),
  CurrentState: PublicationStateSchema.nullable(),
  Resolutions: z.array(DefinitionResolutionSchema).min(1),
  Matrix: z.object({
    include: z.array(BuildMatrixEntrySchema),
  }),
})
export type TResolutionBundle = z.infer<typeof ResolutionBundleSchema>

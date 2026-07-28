import * as Core from '@actions/core'
import {
  FilterArgumentsForOptions,
  ParseArgumentsAndOptions,
} from '@typescriptprime/parsing'
import { z } from 'zod'
import { FinalizePublication } from './publication.js'
import { ResolveDefinitions } from './upstream.js'

const OptionsSchema = z.object({
  Command: z.enum(['resolve', 'finalize']),
  Mode: z.enum(['production', 'pr']).optional(),
  OutputDirectory: z.string().optional(),
  SourceRevision: z.string().optional(),
  Version: z.string().optional(),
  Force: z.union([z.boolean(), z.string()]).optional(),
  AllowDowngrade: z.union([z.boolean(), z.string()]).optional(),
  Bootstrap: z.union([z.boolean(), z.string()]).optional(),
  Bundle: z.string().optional(),
  BuildArtifactsDirectory: z.string().optional(),
  SiteDirectory: z.string().optional(),
  WorkflowRunUrl: z.string().url().optional(),
})

function BooleanOption(Value: boolean | string | undefined): boolean {
  if (Value === undefined || Value === false || Value === 'false' || Value === '') {
    return false
  }
  if (Value === true || Value === 'true') {
    return true
  }
  throw new Error(`Expected true or false; received ${Value}`)
}

function Required(Value: string | undefined, Name: string): string {
  if (Value === undefined || Value === '') {
    throw new Error(`Missing required option --${Name}`)
  }
  return Value
}

async function Main(): Promise<void> {
  const Parsed = await ParseArgumentsAndOptions(
    process.argv.length > 2 ? FilterArgumentsForOptions(process.argv) : [],
  )
  const Options = OptionsSchema.parse(Parsed.Options)
  if (Parsed.Positional.length !== 0) {
    throw new Error(`Unexpected positional arguments: ${Parsed.Positional.join(', ')}`)
  }

  if (Options.Command === 'resolve') {
    const Bundle = await ResolveDefinitions({
      Mode: Options.Mode ?? 'production',
      OutputDirectory: Required(Options.OutputDirectory, 'output-directory'),
      SourceRevision: Required(Options.SourceRevision, 'source-revision'),
      Version: Options.Version,
      Force: BooleanOption(Options.Force),
      AllowDowngrade: BooleanOption(Options.AllowDowngrade),
      Bootstrap: BooleanOption(Options.Bootstrap),
    })
    Core.setOutput('should-publish', Bundle.ShouldPublish.toString())
    Core.setOutput('matrix', JSON.stringify(Bundle.Matrix))
    Core.setOutput('bundle-path', `${Required(Options.OutputDirectory, 'output-directory')}/resolution-bundle.json`)
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      await Core.summary
        .addHeading('Upstream resolution')
        .addTable([
          [{ data: 'Variant', header: true }, { data: 'Version', header: true }, { data: 'Fingerprint', header: true }],
          ...Bundle.Resolutions.map((Resolution) => [
            Resolution.Variant,
            Resolution.Version,
            `\`${Resolution.Fingerprint}\``,
          ]),
        ])
        .addRaw(`Publication selected: **${Bundle.ShouldPublish ? 'yes' : 'no'}**`)
        .write()
    }
    return
  }

  const SecretSubkeyBase64 = process.env.FLATPAK_GPG_SECRET_SUBKEY_B64
  const Passphrase = process.env.FLATPAK_GPG_PASSPHRASE
  if (SecretSubkeyBase64 === undefined || Passphrase === undefined) {
    throw new Error('The protected Flatpak signing secrets are required')
  }
  Core.setSecret(SecretSubkeyBase64)
  Core.setSecret(Passphrase)
  const SiteSize = await FinalizePublication({
    BundlePath: Required(Options.Bundle, 'bundle'),
    BuildArtifactsDirectory: Required(
      Options.BuildArtifactsDirectory,
      'build-artifacts-directory',
    ),
    SiteDirectory: Required(Options.SiteDirectory, 'site-directory'),
    WorkflowRunUrl: Required(Options.WorkflowRunUrl, 'workflow-run-url'),
    SecretSubkeyBase64,
    Passphrase,
  })
  Core.setOutput('site-size-bytes', SiteSize.toString())
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await Core.summary
      .addHeading('Signed Pages publication')
      .addRaw(`Staged site size: **${SiteSize.toLocaleString('en-US')} bytes**`)
      .write()
  }
}

Main().catch((CatchValue: unknown) => {
  Core.setFailed(
    CatchValue instanceof globalThis.Error
      ? CatchValue.stack ?? CatchValue.message
      : String(CatchValue),
  )
  process.exitCode = 1
})

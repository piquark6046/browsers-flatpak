import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CollectionId,
  RepositoryUrl,
} from './contracts.js'
import {
  InitializeRepository,
  type IRepositoryInitializationDependencies,
} from './publication.js'
import { RepositoryPublicKeyPath } from './paths.js'
import type {
  ICommandOptions,
  ICommandResult,
} from './utilities.js'

interface ICommandCall {
  Command: string
  Arguments: string[]
  Options: ICommandOptions
}

interface ITestHarness {
  Calls: ICommandCall[]
  Delays: number[]
  Dependencies: IRepositoryInitializationDependencies
  Events: string[]
  Warnings: string[]
}

function CreateHarness(
  PullBehavior: (Attempt: number) => Promise<void>,
): ITestHarness {
  const Calls: ICommandCall[] = []
  const Delays: number[] = []
  const Events: string[] = []
  const Warnings: string[] = []
  let PullAttempts = 0
  const Dependencies: IRepositoryInitializationDependencies = {
    Delay: async (Milliseconds) => {
      Delays.push(Milliseconds)
      Events.push(`delay:${Milliseconds}`)
    },
    RemoveRepository: async () => {
      Events.push('remove')
    },
    RunCommand: async (
      Command: string,
      Arguments: string[],
      Options: ICommandOptions = {},
    ): Promise<ICommandResult> => {
      Calls.push({ Command, Arguments, Options })
      const Subcommand = Arguments[1] ?? 'unknown'
      Events.push(Subcommand)
      if (Subcommand === 'pull') {
        PullAttempts += 1
        await PullBehavior(PullAttempts)
      }
      return { Stdout: '', Stderr: '' }
    },
    Warn: (Message) => {
      Warnings.push(Message)
    },
  }
  return { Calls, Delays, Dependencies, Events, Warnings }
}

const RepositoryPath = '/tmp/publication-test-repository'
const Environment = {
  GNUPGHOME: '/tmp/publication-test-gnupg',
  TEST_SIGNING_SECRET: 'must-not-appear-in-retry-logs',
}
const ObjectUrl = `${RepositoryUrl}objects/${'a'.repeat(2)}/${'b'.repeat(62)}.commit`

function UnexpectedSizeError(): Error {
  return new Error(
    'ostree exited with 1\n'
    + `error: URI ${ObjectUrl} exceeded maximum size of 916 bytes\n`,
  )
}

test('published repository pull retries in a fresh verified repository', async () => {
  const Harness = CreateHarness(async (Attempt) => {
    if (Attempt === 1) {
      throw UnexpectedSizeError()
    }
  })

  await InitializeRepository(
    RepositoryPath,
    true,
    Environment,
    Harness.Dependencies,
  )

  assert.deepEqual(Harness.Events, [
    'remove',
    'init',
    'remote',
    'pull',
    'delay:1000',
    'remove',
    'init',
    'remote',
    'pull',
  ])
  assert.deepEqual(Harness.Delays, [1_000])
  assert.equal(Harness.Warnings.length, 1)
  assert.doesNotMatch(Harness.Warnings[0]!, /must-not-appear/u)

  const RemoteCalls = Harness.Calls.filter(
    (Call) => Call.Arguments[1] === 'remote',
  )
  assert.equal(RemoteCalls.length, 2)
  for (const Call of RemoteCalls) {
    assert.equal(Call.Command, 'ostree')
    assert(Call.Arguments.includes(`--collection-id=${CollectionId}`))
    assert(Call.Arguments.includes('--set=gpg-verify=true'))
    assert(Call.Arguments.includes('--set=gpg-verify-summary=true'))
    assert(Call.Arguments.includes(`--gpg-import=${RepositoryPublicKeyPath}`))
    assert(Call.Arguments.includes(RepositoryUrl))
    assert.equal(Call.Options.Environment, Environment)
  }
})

test('published repository pull exhausts the bounded retry schedule', async () => {
  const Failure = UnexpectedSizeError()
  const Harness = CreateHarness(async () => {
    throw Failure
  })

  await assert.rejects(
    InitializeRepository(
      RepositoryPath,
      true,
      Environment,
      Harness.Dependencies,
    ),
    (CatchValue: unknown) => CatchValue === Failure,
  )

  assert.equal(
    Harness.Calls.filter((Call) => Call.Arguments[1] === 'pull').length,
    3,
  )
  assert.equal(Harness.Events.filter((Event) => Event === 'remove').length, 3)
  assert.deepEqual(Harness.Delays, [1_000, 5_000])
  assert.equal(Harness.Warnings.length, 2)
})

test('published repository pull does not retry trust failures', async () => {
  const Failure = new Error('ostree exited with 1\nerror: GPG verification failed\n')
  const Harness = CreateHarness(async () => {
    throw Failure
  })

  await assert.rejects(
    InitializeRepository(
      RepositoryPath,
      true,
      Environment,
      Harness.Dependencies,
    ),
    (CatchValue: unknown) => CatchValue === Failure,
  )

  assert.equal(
    Harness.Calls.filter((Call) => Call.Arguments[1] === 'pull').length,
    1,
  )
  assert.deepEqual(Harness.Delays, [])
  assert.deepEqual(Harness.Warnings, [])
})

test('bootstrap initializes once without configuring the published remote', async () => {
  const Harness = CreateHarness(async () => undefined)

  await InitializeRepository(
    RepositoryPath,
    false,
    Environment,
    Harness.Dependencies,
  )

  assert.deepEqual(Harness.Events, ['remove', 'init'])
  assert.deepEqual(Harness.Delays, [])
  assert.deepEqual(Harness.Warnings, [])
})

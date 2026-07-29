import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { SimpleSecureReq } from '@typescriptprime/securereq'
import { CloseNetworkClient, Request } from './network.js'

interface IRequestOptions {
  PreferredProtocol?: string
}

interface IMockResponse {
  StatusCode: number
  Headers: Record<string, string | string[] | undefined>
  Body: string
  Protocol: 'http/1.1'
  ContentEncoding: 'identity'
  DecodedBody: false
}

interface IMockClient {
  Request: (Url: URL, Options: IRequestOptions) => Promise<IMockResponse>
  Close: () => void
}

const Client = SimpleSecureReq as unknown as IMockClient
const TestUrl = 'https://product-details.mozilla.org/1.0/test.json'

function Response(
  StatusCode = 200,
  Headers: Record<string, string | string[] | undefined> = {},
): IMockResponse {
  return {
    StatusCode,
    Headers,
    Body: StatusCode === 200 ? 'ok' : '',
    Protocol: 'http/1.1',
    ContentEncoding: 'identity',
    DecodedBody: false,
  }
}

afterEach(() => {
  mock.restoreAll()
})

test('requests force HTTP/1.1 and return successful responses', async () => {
  let PreferredProtocol: string | undefined
  mock.method(Client, 'Request', async (_Url: URL, Options: IRequestOptions) => {
    PreferredProtocol = Options.PreferredProtocol
    return Response()
  })

  const Result = await Request(TestUrl)

  assert.equal(Result.Status, 200)
  assert.equal(Result.Body, 'ok')
  assert.equal(PreferredProtocol, 'http/1.1')
})

test('transient transport errors retry at most three times', async () => {
  let Attempts = 0
  mock.method(console, 'warn', () => undefined)
  mock.method(Client, 'Request', async () => {
    Attempts += 1
    throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
  })

  await assert.rejects(
    Request(TestUrl),
    /failed after 3 attempts: ECONNRESET/u,
  )
  assert.equal(Attempts, 3)
})

test('retryable HTTP responses recover while 404 is returned immediately', async () => {
  let Attempts = 0
  mock.method(console, 'warn', () => undefined)
  mock.method(Client, 'Request', async () => {
    Attempts += 1
    return Attempts === 1 ? Response(503) : Response()
  })

  assert.equal((await Request(TestUrl)).Status, 200)
  assert.equal(Attempts, 2)

  mock.restoreAll()
  Attempts = 0
  mock.method(Client, 'Request', async () => {
    Attempts += 1
    return Response(404)
  })

  assert.equal((await Request(TestUrl)).Status, 404)
  assert.equal(Attempts, 1)
})

test('terminal failures include sanitized context without query values', async () => {
  mock.method(Client, 'Request', async () => {
    throw new Error('certificate rejected')
  })

  await assert.rejects(
    Request('https://download.mozilla.org/?private=value'),
    (CatchValue: unknown) => {
      assert(CatchValue instanceof Error)
      assert.match(
        CatchValue.message,
        /GET request to https:\/\/download\.mozilla\.org\/ failed after 1 attempt: Error/u,
      )
      assert.doesNotMatch(CatchValue.message, /private|value/u)
      return true
    },
  )
})

test('redirect allowlisting and explicit client cleanup remain enforced', async () => {
  let Requests = 0
  let Closes = 0
  mock.method(Client, 'Request', async () => {
    Requests += 1
    return Response(302, { location: 'https://example.com/file' })
  })
  mock.method(Client, 'Close', () => {
    Closes += 1
  })

  await assert.rejects(
    Request(TestUrl),
    /outside the approved HTTPS allowlist/u,
  )
  assert.equal(Requests, 1)

  CloseNetworkClient()
  assert.equal(Closes, 1)
})

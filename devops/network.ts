import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { setTimeout as Delay } from 'node:timers/promises'
import { SimpleSecureReq } from '@typescriptprime/securereq'

const AllowedHosts = new Set([
  'archive.mozilla.org',
  'download-installer.cdn.mozilla.net',
  'download.mozilla.org',
  'piquark6046.github.io',
  'product-details.mozilla.org',
])

const MaximumBodyBytes = 16 * 1024 * 1024
const MaximumDownloadBytes = 192 * 1024 * 1024
const RequestTimeoutMilliseconds = 30_000
const DownloadTimeoutMilliseconds = 180_000
const MaximumRequestAttempts = 3
const RetryDelayMilliseconds = [250, 1_000] as const
const RetryableStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504])
const RetryableErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
])

export interface IHttpResponse {
  Status: number
  Headers: Record<string, string | string[] | undefined>
  Body: string
  Url: URL
}

export interface IDownloadResult {
  Bytes: number
  Sha256: string
  Sha512: string
  Url: URL
}

class RetryableDownloadError extends Error {
  public constructor(public readonly Label: string) {
    super(Label)
  }
}

function AssertAllowedUrl(Url: URL): void {
  if (Url.protocol !== 'https:' || !AllowedHosts.has(Url.hostname)) {
    throw new Error(`Network request is outside the approved HTTPS allowlist: ${Url.href}`)
  }
  if (Url.username !== '' || Url.password !== '') {
    throw new Error(`Credentials are not allowed in upstream URLs: ${Url.href}`)
  }
}

function Header(
  Headers: Record<string, string | string[] | undefined>,
  Name: string,
): string | undefined {
  const Value = Headers[Name] ?? Headers[Name.toLowerCase()]
  return Array.isArray(Value) ? Value[0] : Value
}

function SanitizedTarget(Url: URL): string {
  return `${Url.origin}${Url.pathname}`
}

function TransientErrorLabel(CatchValue: unknown): string | undefined {
  const Seen = new Set<unknown>()
  let Current = CatchValue
  while (Current instanceof Error && !Seen.has(Current)) {
    Seen.add(Current)
    const Code = (Current as NodeJS.ErrnoException).code
    if (Code !== undefined && RetryableErrorCodes.has(Code)) {
      return Code
    }
    if (Current.name === 'TimeoutError') {
      return Current.name
    }
    Current = Current.cause
  }
  return undefined
}

function ErrorLabel(CatchValue: unknown): string {
  if (CatchValue instanceof Error) {
    const Code = (CatchValue as NodeJS.ErrnoException).code
    return Code ?? CatchValue.name
  }
  return 'unknown error'
}

async function RequestWithRetries(
  Url: URL,
  Method: 'GET' | 'HEAD',
) {
  const Target = SanitizedTarget(Url)
  for (let Attempt = 1; Attempt <= MaximumRequestAttempts; Attempt += 1) {
    let Response
    try {
      Response = await SimpleSecureReq.Request(Url, {
        ExpectedAs: 'String',
        FollowRedirects: false,
        HttpHeaders: {
          Accept: 'application/json, text/plain, application/pgp-signature, */*',
          'User-Agent': 'browsers-flatpak-updater/1',
        },
        HttpMethod: Method,
        PreferredProtocol: 'http/1.1',
        TimeoutMs: RequestTimeoutMilliseconds,
      })
    } catch (CatchValue) {
      const TransientLabel = TransientErrorLabel(CatchValue)
      if (TransientLabel === undefined || Attempt === MaximumRequestAttempts) {
        const Attempts = Attempt === 1 ? '1 attempt' : `${Attempt} attempts`
        throw new Error(
          `${Method} request to ${Target} failed after ${Attempts}: `
          + `${TransientLabel ?? ErrorLabel(CatchValue)}`,
          { cause: CatchValue },
        )
      }
      console.warn(
        `Retrying ${Method} request to ${Target} after ${TransientLabel} `
        + `(attempt ${Attempt + 1}/${MaximumRequestAttempts})`,
      )
      await Delay(RetryDelayMilliseconds[Attempt - 1]!)
      continue
    }

    if (!RetryableStatusCodes.has(Response.StatusCode)) {
      return Response
    }
    if (Attempt === MaximumRequestAttempts) {
      throw new Error(
        `${Method} request to ${Target} failed after ${Attempt} attempts: `
        + `HTTP ${Response.StatusCode}`,
      )
    }
    console.warn(
      `Retrying ${Method} request to ${Target} after HTTP ${Response.StatusCode} `
      + `(attempt ${Attempt + 1}/${MaximumRequestAttempts})`,
    )
    await Delay(RetryDelayMilliseconds[Attempt - 1]!)
  }
  throw new Error(`${Method} request retry loop terminated unexpectedly for ${Target}`)
}

export async function Request(
  Input: string | URL,
  Method: 'GET' | 'HEAD' = 'GET',
  MaximumRedirects = 5,
): Promise<IHttpResponse> {
  let Url = typeof Input === 'string' ? new URL(Input) : Input
  for (let Redirect = 0; Redirect <= MaximumRedirects; Redirect += 1) {
    AssertAllowedUrl(Url)
    const Response = await RequestWithRetries(Url, Method)
    const Status = Response.StatusCode
    const Location = Header(Response.Headers, 'location')
    if ([301, 302, 303, 307, 308].includes(Status) && Location !== undefined) {
      if (Redirect === MaximumRedirects) {
        throw new Error(`Too many redirects while requesting ${Input.toString()}`)
      }
      Url = new URL(Location, Url)
      continue
    }

    const ContentLength = Header(Response.Headers, 'content-length')
    if (
      Method !== 'HEAD'
      &&
      ContentLength !== undefined
      && Number.parseInt(ContentLength, 10) > MaximumBodyBytes
    ) {
      throw new Error(`Response exceeds ${MaximumBodyBytes} bytes: ${Url.href}`)
    }
    if (Method !== 'HEAD' && Buffer.byteLength(Response.Body, 'utf8') > MaximumBodyBytes) {
      throw new Error(`Response exceeds ${MaximumBodyBytes} bytes: ${Url.href}`)
    }
    return {
      Status,
      Headers: Response.Headers,
      Body: Response.Body,
      Url,
    }
  }
  throw new Error(`Redirect handling terminated unexpectedly for ${Input.toString()}`)
}

export async function FetchText(Input: string | URL): Promise<string> {
  const Response = await Request(Input)
  if (Response.Status !== 200) {
    throw new Error(`Expected HTTP 200 from ${Response.Url.href}; received ${Response.Status}`)
  }
  return Response.Body
}

export async function ResolveRedirect(Input: string | URL): Promise<URL> {
  const Response = await Request(Input, 'HEAD')
  if (Response.Status !== 200) {
    throw new Error(`Expected HTTP 200 from ${Response.Url.href}; received ${Response.Status}`)
  }
  return Response.Url
}

async function DownloadAttempt(
  Input: string | URL,
  Destination: string,
  MaximumBytes: number,
): Promise<IDownloadResult> {
  let Url = typeof Input === 'string' ? new URL(Input) : Input
  let Response: Response | undefined
  for (let Redirect = 0; Redirect <= 5; Redirect += 1) {
    AssertAllowedUrl(Url)
    Response = await fetch(Url, {
      headers: {
        Accept: 'application/octet-stream, application/zip, */*',
        'User-Agent': 'browsers-flatpak-updater/1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(DownloadTimeoutMilliseconds),
    })
    const Location = Response.headers.get('location')
    if (
      [301, 302, 303, 307, 308].includes(Response.status)
      && Location !== null
    ) {
      if (Redirect === 5) {
        throw new Error(`Too many redirects while downloading ${Input.toString()}`)
      }
      Url = new URL(Location, Url)
      continue
    }
    break
  }
  if (Response === undefined) {
    throw new Error(`Download redirect handling terminated unexpectedly for ${Input.toString()}`)
  }
  if (RetryableStatusCodes.has(Response.status)) {
    throw new RetryableDownloadError(`HTTP ${Response.status}`)
  }
  if (Response.status !== 200 || Response.body === null) {
    throw new Error(`Expected HTTP 200 from ${Url.href}; received ${Response.status}`)
  }
  const ContentLength = Response.headers.get('content-length')
  if (
    ContentLength !== null
    && Number.parseInt(ContentLength, 10) > MaximumBytes
  ) {
    throw new Error(`Download exceeds ${MaximumBytes} bytes: ${Url.href}`)
  }

  const File = await open(Destination, 'w', 0o600)
  const Sha256Hash = createHash('sha256')
  const Sha512Hash = createHash('sha512')
  let Bytes = 0
  try {
    for await (const Value of Response.body) {
      const Chunk = Buffer.from(Value)
      Bytes += Chunk.byteLength
      if (Bytes > MaximumBytes) {
        throw new Error(`Download exceeds ${MaximumBytes} bytes: ${Url.href}`)
      }
      Sha256Hash.update(Chunk)
      Sha512Hash.update(Chunk)
      let Offset = 0
      while (Offset < Chunk.byteLength) {
        const Written = await File.write(
          Chunk,
          Offset,
          Chunk.byteLength - Offset,
          Bytes - Chunk.byteLength + Offset,
        )
        Offset += Written.bytesWritten
      }
    }
  } finally {
    await File.close()
  }
  if (Bytes === 0) {
    throw new Error(`Downloaded file was empty: ${Url.href}`)
  }
  return {
    Bytes,
    Sha256: Sha256Hash.digest('hex'),
    Sha512: Sha512Hash.digest('hex'),
    Url,
  }
}

export async function DownloadFile(
  Input: string | URL,
  Destination: string,
  MaximumBytes = MaximumDownloadBytes,
): Promise<IDownloadResult> {
  if (!Number.isSafeInteger(MaximumBytes) || MaximumBytes <= 0) {
    throw new Error(`Invalid maximum download size: ${MaximumBytes}`)
  }
  const Target = SanitizedTarget(typeof Input === 'string' ? new URL(Input) : Input)
  for (let Attempt = 1; Attempt <= MaximumRequestAttempts; Attempt += 1) {
    await rm(Destination, { force: true })
    try {
      return await DownloadAttempt(Input, Destination, MaximumBytes)
    } catch (CatchValue) {
      await rm(Destination, { force: true })
      const RetryableLabel = CatchValue instanceof RetryableDownloadError
        ? CatchValue.Label
        : TransientErrorLabel(CatchValue)
      if (RetryableLabel === undefined || Attempt === MaximumRequestAttempts) {
        const Attempts = Attempt === 1 ? '1 attempt' : `${Attempt} attempts`
        throw new Error(
          `Download from ${Target} failed after ${Attempts}: `
          + `${RetryableLabel ?? ErrorLabel(CatchValue)}`,
          { cause: CatchValue },
        )
      }
      console.warn(
        `Retrying download from ${Target} after ${RetryableLabel} `
        + `(attempt ${Attempt + 1}/${MaximumRequestAttempts})`,
      )
      await Delay(RetryDelayMilliseconds[Attempt - 1]!)
    }
  }
  throw new Error(`Download retry loop terminated unexpectedly for ${Target}`)
}

export function CloseNetworkClient(): void {
  SimpleSecureReq.Close()
}

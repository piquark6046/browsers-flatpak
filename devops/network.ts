import { setTimeout as Delay } from 'node:timers/promises'
import { SimpleSecureReq } from '@typescriptprime/securereq'

const AllowedHosts = new Set([
  'download-installer.cdn.mozilla.net',
  'download.mozilla.org',
  'piquark6046.github.io',
  'product-details.mozilla.org',
])

const MaximumBodyBytes = 16 * 1024 * 1024
const RequestTimeoutMilliseconds = 30_000
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

export function CloseNetworkClient(): void {
  SimpleSecureReq.Close()
}

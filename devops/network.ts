import { SimpleSecureReq } from '@typescriptprime/securereq'

const AllowedHosts = new Set([
  'download-installer.cdn.mozilla.net',
  'download.mozilla.org',
  'piquark6046.github.io',
  'product-details.mozilla.org',
])

const MaximumBodyBytes = 16 * 1024 * 1024
const RequestTimeoutMilliseconds = 30_000

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

export async function Request(
  Input: string | URL,
  Method: 'GET' | 'HEAD' = 'GET',
  MaximumRedirects = 5,
): Promise<IHttpResponse> {
  let Url = typeof Input === 'string' ? new URL(Input) : Input
  for (let Redirect = 0; Redirect <= MaximumRedirects; Redirect += 1) {
    AssertAllowedUrl(Url)
    const Response = await SimpleSecureReq.Request(Url, {
      ExpectedAs: 'String',
      FollowRedirects: false,
      HttpHeaders: {
        Accept: 'application/json, text/plain, application/pgp-signature, */*',
        'User-Agent': 'browsers-flatpak-updater/1',
      },
      HttpMethod: Method,
      TimeoutMs: RequestTimeoutMilliseconds,
    })
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

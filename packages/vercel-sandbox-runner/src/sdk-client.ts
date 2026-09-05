import { Sandbox, type NetworkPolicy } from '@vercel/sandbox'

export interface VercelSandboxCreateRequest {
  readonly name: string
  readonly image: string
  readonly resources: { readonly vcpus: number }
  readonly timeout: number
  readonly networkPolicy: NetworkPolicy
  readonly persistent: false
  readonly ports: readonly []
  readonly tags: Readonly<Record<string, string>>
}

export interface VercelSandboxHandle {
  readonly name: string
  readonly image: string | undefined
  readonly vcpus: number | undefined
  readonly memory: number | undefined
  readonly timeout: number | undefined
  readonly persistent: boolean
  readonly status: string
  readonly expiresAt: Date | undefined
  readonly networkPolicy: NetworkPolicy | undefined
  readonly tags: Record<string, string> | undefined
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    options?: { signal?: AbortSignal },
  ): Promise<void>
  runCommand(request: VercelSandboxRunCommandRequest): Promise<VercelSandboxCommandResult>
  readFileToBuffer(
    request: { path: string },
    options?: { signal?: AbortSignal },
  ): Promise<Buffer | null>
  stop(options?: { signal?: AbortSignal }): Promise<unknown>
}

export interface VercelSandboxRunCommandRequest {
  readonly cmd: string
  readonly args: string[]
  readonly env: Record<string, string>
  readonly sudo: true
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface VercelSandboxCommandResult {
  readonly exitCode: number
  stdout(options?: { signal?: AbortSignal }): Promise<string>
  stderr(options?: { signal?: AbortSignal }): Promise<string>
}

export interface VercelSandboxFactory {
  create(request: VercelSandboxCreateRequest): Promise<VercelSandboxHandle>
  get(request: { readonly name: string; readonly resume: true }): Promise<VercelSandboxHandle>
}

/** Live SDK boundary. Credentials are resolved by Vercel OIDC or its credential chain. */
export class SdkVercelSandboxFactory implements VercelSandboxFactory {
  async create(request: VercelSandboxCreateRequest): Promise<VercelSandboxHandle> {
    return Sandbox.create({
      name: request.name,
      image: request.image,
      resources: request.resources,
      timeout: request.timeout,
      networkPolicy: request.networkPolicy,
      persistent: request.persistent,
      ports: [...request.ports],
      tags: { ...request.tags },
      env: {},
    })
  }

  async get(request: { readonly name: string; readonly resume: true }) {
    return Sandbox.get(request)
  }
}

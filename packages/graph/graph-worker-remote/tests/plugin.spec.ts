import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import GraphWorkerRuntime from '@deepseek-ai/dsh-graph-worker'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import * as RemoteWorker from '../src/index.ts'

describe('remote Graph Worker plugin composition', () => {
  it('registers and disposes the durable HTTP service route without an outbound subagent dependency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-graph-worker-plugin-'))
    const routes: WebRoute[] = []
    const ctx = new Context()
    await ctx.plugin(AgentRegistry).await()
    await ctx.plugin(GraphWorkerRuntime).await()
    ctx.provide('credentials', {
      resolve: async () => ({ value: '0123456789abcdef0123456789abcdef', source: 'test' }),
    } as unknown as CredentialProvider)
    ctx.provide('webServer', {
      register: (route: WebRoute) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    } as WebServer)
    const fiber = ctx.plugin(RemoteWorker, {
      mode: 'server',
      providerName: 'unused-client-route',
      subagentProvider: 'unused-subagent-route',
      maxArtifactFiles: 10,
      maxArtifactBytes: 1_000,
      server: {
        audience: 'worker-west',
        basePath: '/graph-worker',
        journalPath: join(root, 'jobs.sqlite'),
        workerProvider: 'local-worker',
        parentSessionId: 'worker-service-parent',
        principals: [{ principal: 'graph-host-east', credentialRef: 'GRAPH_WORKER_SECRET' }],
        maxClockSkewMs: 30_000,
        maxRequestBytes: 1_000_000,
        maxResultBytes: 1_000_000,
        maxReplayEntries: 1_000,
        busyTimeoutMs: 5_000,
        operationTimeoutMs: 30_000,
        resourceRouteName: '',
        resourceProvider: '',
        schedulerRouteName: '',
        schedulerProvider: '',
        artifactRouteName: '',
        artifactProvider: '',
        artifactTempRoot: join(root, 'artifacts'),
        artifactMaxFiles: 10,
        artifactMaxBytes: 1_000,
      },
    })
    try {
      await fiber.await()
      expect(routes).toMatchObject([{ kind: 'prefix', path: '/graph-worker' }])
      await fiber.dispose()
      expect(routes).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails at load when server mode lacks required optional services', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-graph-worker-plugin-missing-'))
    const ctx = new Context()
    await ctx.plugin(GraphWorkerRuntime).await()
    try {
      await expect(ctx.plugin(RemoteWorker, {
        mode: 'server',
        providerName: 'unused-client-route',
        subagentProvider: 'unused-subagent-route',
        maxArtifactFiles: 10,
        maxArtifactBytes: 1_000,
        server: {
          audience: 'worker-west',
          basePath: '/graph-worker',
          journalPath: join(root, 'jobs.sqlite'),
          workerProvider: 'local-worker',
          parentSessionId: 'worker-service-parent',
          principals: [{ principal: 'graph-host-east', credentialRef: 'GRAPH_WORKER_SECRET' }],
          maxClockSkewMs: 30_000,
          maxRequestBytes: 1_000_000,
          maxResultBytes: 1_000_000,
          maxReplayEntries: 1_000,
          busyTimeoutMs: 5_000,
          operationTimeoutMs: 30_000,
          resourceRouteName: '',
          resourceProvider: '',
          schedulerRouteName: '',
          schedulerProvider: '',
          artifactRouteName: '',
          artifactProvider: '',
          artifactTempRoot: join(root, 'artifacts'),
          artifactMaxFiles: 10,
          artifactMaxBytes: 1_000,
        },
      })).rejects.toThrow('requires ctx.credentials')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

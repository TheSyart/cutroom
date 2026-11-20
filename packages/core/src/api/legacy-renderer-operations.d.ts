/** Type-only contracts used by historical renderer components. The Cutroom registry owns executable IPC. */
import type { z } from 'zod'
import type { CoreOperationSpec } from './operations'
export interface LegacyRendererOperations {
  readonly 'executors.list': CoreOperationSpec<
    z.ZodTuple<[], null>,
    | {
        config: import('..').ExecutorConfig
        diagnostic: null
        signInNotice: boolean
        signIn: import('..').ClaudeSignInView | null
        profiles: {
          profile: import('..').ExecutorProfile
          probe: import('..').ExecutorProbe | null
          specialties: string[]
          runtime: import('..').ExecutorRuntimeFacts
          consent: 'always' | null
        }[]
      }
    | {
        config: null
        diagnostic: string
        signInNotice: boolean
        signIn: import('..').ClaudeSignInView | null
        profiles: never[]
      }
  >
  readonly 'executors.models': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            refresh: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ExecutorModelCatalog>
  >
  readonly 'executors.probe': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ExecutorProbe>
  >
  readonly 'executors.configure': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            expectedRevision: z.ZodNumber
            config: z.ZodObject<
              {
                schemaVersion: z.ZodLiteral<1>
                revision: z.ZodNumber
                profiles: z.ZodArray<
                  z.ZodObject<
                    {
                      id: z.ZodString
                      backend: z.ZodEnum<{
                        codex: 'codex'
                        'claude-code': 'claude-code'
                      }>
                      enabled: z.ZodBoolean
                      executableSource: z.ZodOptional<
                        z.ZodEnum<{
                          system: 'system'
                          bundled: 'bundled'
                        }>
                      >
                      executablePath: z.ZodString
                      expectedVersion: z.ZodOptional<z.ZodString>
                      customModels: z.ZodOptional<
                        z.ZodPipe<
                          z.ZodArray<z.ZodString>,
                          z.ZodTransform<string[], string[]>
                        >
                      >
                      defaultModel: z.ZodOptional<z.ZodString>
                      specialties: z.ZodOptional<z.ZodArray<z.ZodString>>
                      authRef: z.ZodDiscriminatedUnion<
                        [
                          z.ZodObject<
                            {
                              kind: z.ZodLiteral<'model-route'>
                              routeId: z.ZodString
                            },
                            z.core.$strict
                          >,
                          z.ZodObject<
                            {
                              kind: z.ZodLiteral<'managed-cli-login'>
                            },
                            z.core.$strict
                          >,
                        ],
                        'kind'
                      >
                      stateDirectoryId: z.ZodString
                      concurrencyLimit: z.ZodNumber
                    },
                    z.core.$strict
                  >
                >
                limits: z.ZodObject<
                  {
                    globalConcurrency: z.ZodNumber
                    maxQueuedMessages: z.ZodNumber
                    maxRunsPerTask: z.ZodNumber
                    maxDepth: z.ZodNumber
                    runTimeoutMs: z.ZodNumber
                    questionTimeoutMs: z.ZodNumber
                    estimatedBudgetUsd: z.ZodNumber
                    claudeMaxTurns: z.ZodOptional<z.ZodNumber>
                  },
                  z.core.$strict
                >
                touchedAt: z.ZodOptional<z.ZodNumber>
                upgradeNotice: z.ZodOptional<
                  z.ZodLiteral<'external-default-off'>
                >
                diagnosticsMode: z.ZodOptional<z.ZodBoolean>
                verifyBeforeApply: z.ZodOptional<z.ZodBoolean>
                developmentEnvironment: z.ZodOptional<
                  z.ZodObject<
                    {
                      gitIdentity: z.ZodBoolean
                      proxy: z.ZodBoolean
                      sshAgent: z.ZodBoolean
                      toolchains: z.ZodBoolean
                      github: z.ZodBoolean
                    },
                    z.core.$strict
                  >
                >
                localSubagentModel: z.ZodOptional<z.ZodString>
                defaultWorkspace: z.ZodOptional<
                  z.ZodEnum<{
                    'isolated-worktree': 'isolated-worktree'
                    'shared-exclusive': 'shared-exclusive'
                  }>
                >
              },
              z.core.$strict
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ExecutorConfig>
  >
  readonly 'executors.setCredential': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            kind: z.ZodLiteral<'api-key'>
            token: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      probe: import('..').ExecutorProbe
    }>
  >
  readonly 'executors.clearCredential': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      probe: import('..').ExecutorProbe
    }>
  >
  readonly 'executors.signIn': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            method: z.ZodEnum<{
              'claude-ai': 'claude-ai'
              console: 'console'
            }>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      signIn: import('..').ClaudeSignInView
    }>
  >
  readonly 'executors.cancelSignIn': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      signIn: import('..').ClaudeSignInView | null
    }>
  >
  readonly 'executors.signOut': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      probe: import('..').ExecutorProbe
    }>
  >
  readonly 'executors.dismissNotice': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            notice: z.ZodLiteral<'claude-sign-in'>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<Record<string, never>>
  >
  readonly 'executors.versions': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            refresh: z.ZodOptional<
              z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<'auto'>]>
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ExecutorVersionsView>
  >
  readonly 'executors.upgrade': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            target: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      upgrade: import('..').ExecutorUpgradeView
    }>
  >
  readonly 'executors.rollback': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            target: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      upgrade: import('..').ExecutorUpgradeView
    }>
  >
  readonly 'executors.selfCheck': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      selfCheck: import('../harness/delegation/executor-health').SelfCheckResult
    }>
  >
  readonly 'executors.cancelUpgrade': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      upgrade: import('..').ExecutorUpgradeView | null
    }>
  >
  readonly 'executors.dismissUpgrades': CoreOperationSpec<
    z.ZodTuple<[z.ZodObject<Record<never, never>, z.core.$strict>], null>,
    Promise<import('..').ExecutorVersionsView>
  >
  readonly 'delegations.get': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    import('../harness/delegation/fold').DelegationState
  >
  readonly 'delegations.history': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            before: z.ZodOptional<z.ZodString>
            after: z.ZodOptional<z.ZodString>
            limit: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    import('./services/delegation-history').DelegationHistoryPage
  >
  readonly 'delegations.send': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            messageId: z.ZodString
            text: z.ZodString
            delivery: z.ZodEnum<{
              steer: 'steer'
              queue: 'queue'
            }>
            expectedRunId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      messageId: string
      state: 'queued' | 'accepted'
      runId?: string
    }>
  >
  readonly 'delegations.interrupt': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            runId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      requested: boolean
    }>
  >
  readonly 'delegations.recover': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            expectedRevision: z.ZodNumber
            inspect: z.ZodOptional<z.ZodBoolean>
            verificationId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<
      | import('..').DelegationRecord
      | import('../harness/delegation/types').NativeSessionInspection
    >
  >
  readonly 'delegations.abandon': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').DelegationRecord>
  >
  readonly 'delegations.collect': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').DelegationReceipt>
  >
  readonly 'delegations.receipt': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      patch: {
        content: string
        truncated: boolean
      } | null
      patchError: string | null
      previewError: string | null
      receipt: import('..').DelegationReceipt | null
      requiresAcceptance: boolean
      acceptance: import('..').AcceptanceReceipt | null
      preview: import('..').IntegrationPreview | null
      verificationActive: boolean
      verificationRecoveryIds: string[]
    }>
  >
  readonly 'delegations.validate': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            receiptId: z.ZodString
            criteria: z.ZodObject<
              {
                description: z.ZodString
                commands: z.ZodArray<
                  z.ZodObject<
                    {
                      executable: z.ZodString
                      args: z.ZodArray<z.ZodString>
                      timeoutMs: z.ZodOptional<z.ZodNumber>
                    },
                    z.core.$strict
                  >
                >
                requiresReview: z.ZodOptional<z.ZodBoolean>
              },
              z.core.$strict
            >
            reviewedTreeDigest: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').AcceptanceReceipt>
  >
  readonly 'delegations.integrate': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            action: z.ZodEnum<{
              preview: 'preview'
              apply: 'apply'
            }>
            expectedBase: z.ZodOptional<
              z.ZodObject<
                {
                  cwd: z.ZodString
                  head: z.ZodNullable<z.ZodString>
                  indexDigest: z.ZodNullable<z.ZodString>
                  treeDigest: z.ZodString
                },
                z.core.$strict
              >
            >
            previewId: z.ZodOptional<z.ZodString>
            expectedRevision: z.ZodOptional<z.ZodNumber>
            previewDigest: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').IntegrationPreview | import('..').IntegrationReceipt>
  >
  readonly 'delegations.diff': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
            path: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      path: string
      diff: string
      truncated: boolean
    }>
  >
  readonly 'delegations.apply': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').DelegationResult>
  >
  readonly 'delegations.undo': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').DelegationResult>
  >
  readonly 'delegations.discard': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            runId: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').DelegationResult>
  >
  readonly 'delegations.close': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            id: z.ZodString
            sessionId: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<void>
  >
  readonly 'config.effective': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('../config/resolver').EffectiveConfigSnapshot>
  >
  readonly 'computerUse.status': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').ComputerUseStatusView>
  >
  readonly 'computerUse.listProfiles': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('..').BrowserProfileView[]
  >
  readonly 'computerUse.manageProfile': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            action: z.ZodEnum<{
              rename: 'rename'
              create: 'create'
              clear: 'clear'
              delete: 'delete'
            }>
            profileId: z.ZodOptional<z.ZodString>
            name: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      profile?: import('..').BrowserProfileView
      revokedGrants?: number
    }>
  >
  readonly 'computerUse.listSitePermissions': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('..').SitePermission[]
  >
  readonly 'computerUse.setSitePermission': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            profileId: z.ZodString
            origin: z.ZodString
            kind: z.ZodEnum<{
              camera: 'camera'
              microphone: 'microphone'
              geolocation: 'geolocation'
              notifications: 'notifications'
              'clipboard-read': 'clipboard-read'
              'clipboard-write': 'clipboard-write'
              fullscreen: 'fullscreen'
            }>
            allow: z.ZodBoolean
            minutes: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      permissions: import('..').SitePermission[]
    }
  >
  readonly 'computerUse.externalBrowserSettings': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('..').ExternalBrowserSettingsView
  >
  readonly 'computerUse.setExternalBrowserSettings': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            defaults: z.ZodOptional<
              z.ZodObject<
                {
                  browse: z.ZodOptional<
                    z.ZodEnum<{
                      block: 'block'
                      allow: 'allow'
                      ask: 'ask'
                    }>
                  >
                  download: z.ZodOptional<
                    z.ZodEnum<{
                      block: 'block'
                      allow: 'allow'
                      ask: 'ask'
                    }>
                  >
                },
                z.core.$strict
              >
            >
            sites: z.ZodOptional<
              z.ZodArray<
                z.ZodObject<
                  {
                    pattern: z.ZodString
                    browse: z.ZodEnum<{
                      block: 'block'
                      allow: 'allow'
                      ask: 'ask'
                    }>
                    download: z.ZodEnum<{
                      block: 'block'
                      allow: 'allow'
                      ask: 'ask'
                    }>
                  },
                  z.core.$strict
                >
              >
            >
            history: z.ZodOptional<
              z.ZodEnum<{
                allow: 'allow'
                ask: 'ask'
                never: 'never'
              }>
            >
            siteTools: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    import('..').ExternalBrowserSettingsView
  >
  readonly 'computerUse.setEnabled': CoreOperationSpec<
    z.ZodTuple<[z.ZodBoolean], null>,
    Promise<import('..').ComputerUseStatusView>
  >
  readonly 'computerUse.setDriverEnabled': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            driver: z.ZodEnum<{
              desktop: 'desktop'
              'embedded-browser': 'embedded-browser'
              'external-browser': 'external-browser'
            }>
            enabled: z.ZodBoolean
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ComputerUseStatusView>
  >
  readonly 'computerUse.acknowledgeRetiredApps': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').ComputerUseStatusView>
  >
  readonly 'computerUse.setDownloadRetention': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            days: z.ZodUnion<
              readonly [
                z.ZodLiteral<0>,
                z.ZodLiteral<7>,
                z.ZodLiteral<30>,
                z.ZodLiteral<90>,
              ]
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').ComputerUseStatusView>
  >
  readonly 'computerUse.clearScreenshots': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodString>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    {
      removed: number
      bytes: number
    }
  >
  readonly 'desktopPet.get': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('./services/desktop-pet-service').CoreDesktopPetPayload>
  >
  readonly 'browser.preferences': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').BrowserPreferences>
  >
  readonly 'browser.setPreferences': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            linkTarget: z.ZodOptional<
              z.ZodEnum<{
                system: 'system'
                builtin: 'builtin'
              }>
            >
            localTarget: z.ZodOptional<
              z.ZodEnum<{
                system: 'system'
                builtin: 'builtin'
              }>
            >
            showFullUrl: z.ZodOptional<z.ZodBoolean>
            history: z.ZodOptional<z.ZodBoolean>
            downloadDirectory: z.ZodOptional<z.ZodNullable<z.ZodString>>
            askWhereToSave: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').BrowserPreferences>
  >
  readonly 'desktopPet.setEnabled': CoreOperationSpec<
    z.ZodTuple<[z.ZodBoolean], null>,
    Promise<import('./services/desktop-pet-service').CoreDesktopPetPayload>
  >
  readonly 'diagnostics.get': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('./services/diagnostics-service').CoreDiagnosticsPayload>
  >
  readonly 'environment.cancelInstall': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            jobId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      cancelled: boolean
      job: import('../environment/models').EnvironmentJobRecord | null
    }>
  >
  readonly 'environment.createInstallPlan': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            toolIds: z.ZodArray<
              z.ZodEnum<{
                git: 'git'
                npm: 'npm'
                node: 'node'
                gh: 'gh'
                go: 'go'
                ripgrep: 'ripgrep'
                volta: 'volta'
                uv: 'uv'
                python: 'python'
                rustup: 'rustup'
                rust: 'rust'
                cargo: 'cargo'
                'msvc-build-tools': 'msvc-build-tools'
              }>
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<never>
  >
  readonly 'environment.getInstallLog': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            jobId: z.ZodString
            cursor: z.ZodOptional<z.ZodNumber>
            limit: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('../environment/store').EnvironmentLogPage>
  >
  readonly 'environment.getStatus': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodOptional<
          z.ZodObject<
            {
              forceRefresh: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<
      import('./services/environment-service').CoreEnvironmentStatusPayload
    >
  >
  readonly 'environment.install': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            planId: z.ZodString
            acceptedLicenseIds: z.ZodArray<z.ZodString>
            confirmedStepIds: z.ZodArray<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<never>
  >
  readonly 'files.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            relativePath: z.ZodString
            cursor: z.ZodOptional<z.ZodString>
            limit: z.ZodOptional<z.ZodNumber>
            showHidden: z.ZodOptional<z.ZodBoolean>
            showIgnored: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('../workspace/files').WorkspaceFileListResult>
  >
  readonly 'files.search': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            cursor: z.ZodOptional<z.ZodString>
            limit: z.ZodOptional<z.ZodNumber>
            showHidden: z.ZodOptional<z.ZodBoolean>
            showIgnored: z.ZodOptional<z.ZodBoolean>
            query: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('../workspace/files').WorkspaceFileListResult>
  >
  readonly 'files.watch': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      watching: boolean
    }
  >
  readonly 'files.unwatch': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      watching: false
    }
  >
  readonly 'git.branches': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      current: string | null
      branches: Array<{
        name: string
        head: string
        upstream: string | null
      }>
    }>
  >
  readonly 'git.commit': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            message: z.ZodString
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.compare': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            baseRef: z.ZodString
            headRef: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      ahead: number
      behind: number
      diff: string
      truncated: boolean
    }>
  >
  readonly 'git.createBranch': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            name: z.ZodString
            expectedRevision: z.ZodString
            startPoint: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.diff': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            path: z.ZodOptional<z.ZodString>
            area: z.ZodEnum<{
              worktree: 'worktree'
              staged: 'staged'
              compare: 'compare'
            }>
            baseRef: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      content: string
      truncated: boolean
    }>
  >
  readonly 'git.repository': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('../workspace/git-repository').GitRepositoryIdentity>
  >
  readonly 'git.remote': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitRemoteInfo>
  >
  readonly 'git.log': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            baseRef: z.ZodOptional<z.ZodString>
            limit: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      commits: Array<{
        oid: string
        parents: string[]
        authoredAt: string
        author: string
        subject: string
      }>
      truncated: boolean
    }>
  >
  readonly 'git.worktrees': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      worktrees: import('..').GitWorktreeSummary[]
      owned: import('..').GitWorktreeSummary[]
    }>
  >
  readonly 'git.enterWorktree': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            name: z.ZodOptional<z.ZodString>
            startPoint: z.ZodOptional<z.ZodString>
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      worktree: import('..').GitWorktreeSummary
      status: import('..').GitStatusResult
    }>
  >
  readonly 'git.exitWorktree': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            action: z.ZodEnum<{
              remove: 'remove'
              keep: 'keep'
            }>
            discardChanges: z.ZodBoolean
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      result: {
        action: 'keep' | 'remove'
        path: string
      }
      status: import('..').GitStatusResult
    }>
  >
  readonly 'git.pullRequest': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestSummary | null>
  >
  readonly 'git.publishPreview': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            baseRef: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      baseRef: string
      branch: string
      headOid: string
      commits: Array<{
        oid: string
        subject: string
      }>
      additions: number
      deletions: number
      binary: number
      changedFiles: number
      uncommittedFiles: number
    }>
  >
  readonly 'git.publishPullRequest': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            title: z.ZodString
            body: z.ZodString
            draft: z.ZodBoolean
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestSummary>
  >
  readonly 'git.readyPullRequest': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            number: z.ZodNumber
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestSummary>
  >
  readonly 'git.mergePullRequest': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            number: z.ZodNumber
            expectedRevision: z.ZodString
            method: z.ZodEnum<{
              merge: 'merge'
              rebase: 'rebase'
              squash: 'squash'
            }>
            deleteBranch: z.ZodBoolean
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestSummary>
  >
  readonly 'git.closePullRequest': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            number: z.ZodNumber
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestSummary>
  >
  readonly 'git.discard': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            paths: z.ZodArray<z.ZodString>
            expectedRevision: z.ZodString
            confirmed: z.ZodLiteral<true>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.fetch': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.pull': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.push': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            expectedRevision: z.ZodString
            setUpstream: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.stage': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            paths: z.ZodArray<z.ZodString>
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.status': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.switchBranch': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            confirmed: z.ZodLiteral<true>
            name: z.ZodString
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'git.unstage': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            paths: z.ZodArray<z.ZodString>
            expectedRevision: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').GitStatusResult>
  >
  readonly 'hooks.cancelRun': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    Promise<never>
  >
  readonly 'hooks.getAudit': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodOptional<
          z.ZodObject<
            {
              cursor: z.ZodOptional<
                z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>
              >
              limit: z.ZodOptional<
                z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>
              >
              eventName: z.ZodOptional<z.ZodNullable<z.ZodString>>
              outcome: z.ZodOptional<z.ZodNullable<z.ZodString>>
              sourceId: z.ZodOptional<z.ZodNullable<z.ZodString>>
              runId: z.ZodOptional<z.ZodNullable<z.ZodString>>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<import('..').CoreHooksAuditPayload>
  >
  readonly 'hooks.getConfig': CoreOperationSpec<
    z.ZodTuple<[z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>], null>,
    Promise<import('..').CoreHooksConfigPayload>
  >
  readonly 'hooks.getMetadata': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('..').CoreHooksMetadataPayload
  >
  readonly 'hooks.saveConfig': CoreOperationSpec<
    z.ZodTuple<[z.ZodUnknown], null>,
    Promise<import('..').CoreHooksConfigPayload>
  >
  readonly 'hooks.setProjectTrust': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    Promise<never>
  >
  readonly 'hooks.testMatch': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    Promise<import('..').CoreHooksMatchPayload>
  >
  readonly 'hooks.testRun': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    Promise<{
      [x: string]: unknown
    }>
  >
  readonly 'hooks.validateConfig': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    import('..').CoreHooksValidationPayload
  >
  readonly 'mcp.getConfig': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('../mcp/config').MCPConfig>
  >
  readonly 'mcp.status': CoreOperationSpec<
    z.ZodTuple<[], null>,
    MCPClientSnapshot
  >
  readonly 'mcp.serverLog': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            name: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      name: string
      text: string | null
    }
  >
  readonly 'mcp.saveConfig': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            servers: z.ZodRecord<
              z.ZodString,
              z.ZodObject<
                {
                  transport: z.ZodOptional<z.ZodString>
                  command: z.ZodOptional<z.ZodNullable<z.ZodString>>
                  args: z.ZodOptional<z.ZodArray<z.ZodString>>
                  env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
                  url: z.ZodOptional<z.ZodNullable<z.ZodString>>
                  headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
                  enabled: z.ZodOptional<z.ZodBoolean>
                  tool_overrides: z.ZodOptional<
                    z.ZodRecord<
                      z.ZodString,
                      z.ZodObject<
                        {
                          read_only: z.ZodOptional<z.ZodBoolean>
                          exclusive: z.ZodOptional<z.ZodBoolean>
                        },
                        z.core.$loose
                      >
                    >
                  >
                },
                z.core.$loose
              >
            >
            defaults: z.ZodOptional<
              z.ZodObject<
                {
                  read_only: z.ZodOptional<z.ZodBoolean>
                  exclusive: z.ZodOptional<z.ZodBoolean>
                },
                z.core.$loose
              >
            >
          },
          z.core.$loose
        >,
      ],
      null
    >,
    Promise<import('../mcp/config').MCPConfig>
  >
  readonly 'mcp.importServers': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            raw: z.ZodUnion<
              readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>]
            >
            overwrite: z.ZodOptional<
              z.ZodUnion<readonly [z.ZodBoolean, z.ZodArray<z.ZodString>]>
            >
            dryRun: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      status: MCPClientSnapshot
      added: string[]
      updated: string[]
      skipped: string[]
      conflicts: string[]
      warnings: string[]
      servers: import('../mcp/manage').McpImportServerPlan[]
      dryRun: boolean
      config: import('../mcp/config').MCPConfig
    }>
  >
  readonly 'mcp.setServerEnabled': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            name: z.ZodString
            enabled: z.ZodBoolean
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      status: MCPClientSnapshot
      name: string
      enabled: boolean
      changed: boolean
      config: import('../mcp/config').MCPConfig
    }>
  >
  readonly 'mcp.removeServer': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            name: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      status: MCPClientSnapshot
      removed: string
      config: import('../mcp/config').MCPConfig
    }>
  >
  readonly 'memory.checkWatchlist': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<{
      decision: Record<string, unknown>
      watchlist: Record<string, unknown>
    }>
  >
  readonly 'memory.getWatchlist': CoreOperationSpec<
    z.ZodTuple<[], null>,
    {
      [x: string]: any
    }
  >
  readonly 'memory.saveWatchlist': CoreOperationSpec<
    z.ZodTuple<[z.ZodString], null>,
    {
      [x: string]: any
    }
  >
  readonly 'onboarding.getProfileStatus': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('../sessions/onboarding').ProfileOnboardingPayload
  >
  readonly 'onboarding.startProfileInterview': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('../sessions/onboarding').ProfileOnboardingActionResult>
  >
  readonly 'onboarding.skipProfileInterview': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('../sessions/onboarding').ProfileOnboardingActionResult>
  >
  readonly 'pullRequests.status': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').PullRequestBrowserStatus>
  >
  readonly 'pullRequests.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            filter: z.ZodEnum<{
              all: 'all'
              reviewing: 'reviewing'
              mine: 'mine'
            }>
            query: z.ZodOptional<z.ZodString>
            limit: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestListResult>
  >
  readonly 'pullRequests.view': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            repo: z.ZodString
            number: z.ZodNumber
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestDetail>
  >
  readonly 'pullRequests.diff': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            repo: z.ZodString
            number: z.ZodNumber
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').PullRequestDiffResult>
  >
  readonly 'scheduler.createJob': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            name: z.ZodOptional<z.ZodString>
            schedule: z.ZodDiscriminatedUnion<
              [
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'at'>
                    atMs: z.ZodNumber
                  },
                  z.core.$strict
                >,
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'every'>
                    everyMs: z.ZodNumber
                  },
                  z.core.$strict
                >,
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'cron'>
                    expr: z.ZodString
                    tz: z.ZodOptional<z.ZodNullable<z.ZodString>>
                  },
                  z.core.$strict
                >,
              ],
              'kind'
            >
            payload: z.ZodDiscriminatedUnion<
              [
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'agent_turn'>
                    message: z.ZodString
                    target: z.ZodOptional<z.ZodNull>
                    projectId: z.ZodOptional<z.ZodNullable<z.ZodString>>
                    deliver: z.ZodOptional<z.ZodBoolean>
                    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
                  },
                  z.core.$strict
                >,
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'team_wake'>
                    message: z.ZodString
                    target: z.ZodString
                    projectId: z.ZodString
                    deliver: z.ZodOptional<z.ZodBoolean>
                    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
                  },
                  z.core.$strict
                >,
              ],
              'kind'
            >
            deleteAfterRun: z.ZodOptional<z.ZodBoolean>
            misfirePolicy: z.ZodOptional<
              z.ZodEnum<{
                skip: 'skip'
                latest: 'latest'
                'catch-up-one': 'catch-up-one'
              }>
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      job: import('../scheduler/models').SchedulerPublicJobViewPayload
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }
  >
  readonly 'scheduler.deleteJob': CoreOperationSpec<
    z.ZodTuple<[z.ZodString], null>,
    {
      deleted: string
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }
  >
  readonly 'scheduler.get': CoreOperationSpec<
    z.ZodTuple<[], null>,
    {
      status: import('../scheduler/service').SchedulerStatusPayload
      jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
      diagnostics: Record<string, unknown>
    }
  >
  readonly 'scheduler.pauseJob': CoreOperationSpec<
    z.ZodTuple<[z.ZodString], null>,
    {
      job: import('../scheduler/models').SchedulerPublicJobViewPayload
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }
  >
  readonly 'scheduler.resumeJob': CoreOperationSpec<
    z.ZodTuple<[z.ZodString], null>,
    {
      job: import('../scheduler/models').SchedulerPublicJobViewPayload
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }
  >
  readonly 'scheduler.runJob': CoreOperationSpec<
    z.ZodTuple<[z.ZodString], null>,
    Promise<{
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }>
  >
  readonly 'scheduler.updateJob': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodObject<
          {
            name: z.ZodOptional<z.ZodString>
            schedule: z.ZodOptional<
              z.ZodDiscriminatedUnion<
                [
                  z.ZodObject<
                    {
                      kind: z.ZodLiteral<'at'>
                      atMs: z.ZodNumber
                    },
                    z.core.$strict
                  >,
                  z.ZodObject<
                    {
                      kind: z.ZodLiteral<'every'>
                      everyMs: z.ZodNumber
                    },
                    z.core.$strict
                  >,
                  z.ZodObject<
                    {
                      kind: z.ZodLiteral<'cron'>
                      expr: z.ZodString
                      tz: z.ZodOptional<z.ZodNullable<z.ZodString>>
                    },
                    z.core.$strict
                  >,
                ],
                'kind'
              >
            >
            payload: z.ZodOptional<
              z.ZodDiscriminatedUnion<
                [
                  z.ZodObject<
                    {
                      kind: z.ZodLiteral<'agent_turn'>
                      message: z.ZodString
                      target: z.ZodOptional<z.ZodNull>
                      projectId: z.ZodOptional<z.ZodNullable<z.ZodString>>
                      deliver: z.ZodOptional<z.ZodBoolean>
                      meta: z.ZodOptional<
                        z.ZodRecord<z.ZodString, z.ZodUnknown>
                      >
                    },
                    z.core.$strict
                  >,
                  z.ZodObject<
                    {
                      kind: z.ZodLiteral<'team_wake'>
                      message: z.ZodString
                      target: z.ZodString
                      projectId: z.ZodString
                      deliver: z.ZodOptional<z.ZodBoolean>
                      meta: z.ZodOptional<
                        z.ZodRecord<z.ZodString, z.ZodUnknown>
                      >
                    },
                    z.core.$strict
                  >,
                ],
                'kind'
              >
            >
            deleteAfterRun: z.ZodOptional<z.ZodBoolean>
            misfirePolicy: z.ZodOptional<
              z.ZodEnum<{
                skip: 'skip'
                latest: 'latest'
                'catch-up-one': 'catch-up-one'
              }>
            >
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      job: import('../scheduler/models').SchedulerPublicJobViewPayload
      scheduler: {
        status: import('../scheduler/service').SchedulerStatusPayload
        jobs: import('../scheduler/models').SchedulerPublicJobViewPayload[]
        diagnostics: Record<string, unknown>
      }
    }
  >
  readonly 'agents.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            rootSessionIds: z.ZodArray<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      agents: import('..').AgentView[]
    }
  >
  readonly 'agents.send': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            text: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      messageId: string
    }
  >
  readonly 'sidebar.get': CoreOperationSpec<
    z.ZodTuple<[], null>,
    {
      [x: string]: unknown
    }
  >
  readonly 'sidebar.patch': CoreOperationSpec<
    z.ZodTuple<[z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
    {
      [x: string]: unknown
    }
  >
  readonly 'tasks.get': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodString>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    import('./core-api').CoreTaskRecord | null
  >
  readonly 'storage.usage': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('../storage/retention').StorageUsage>
  >
  readonly 'storage.clean': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<{
      report: import('../storage/retention').RetentionReport
      usage: import('../storage/retention').StorageUsage
    }>
  >
  readonly 'updates.status': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('..').UpdateStatus
  >
  readonly 'updates.setEnabled': CoreOperationSpec<
    z.ZodTuple<[z.ZodBoolean], null>,
    Promise<import('..').UpdateStatus>
  >
  readonly 'updates.check': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').UpdateStatus>
  >
  readonly 'updates.download': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').UpdateStatus>
  >
  readonly 'updates.cancelDownload': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').UpdateStatus>
  >
  readonly 'updates.reveal': CoreOperationSpec<
    z.ZodTuple<[], null>,
    Promise<import('..').UpdateStatus>
  >
  readonly 'tasks.budget': CoreOperationSpec<
    z.ZodTuple<[], null>,
    import('../config/local-config').TaskBudgetSettings
  >
  readonly 'tasks.setBudget': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            maxSteps: z.ZodOptional<z.ZodNumber>
            maxBackgroundSteps: z.ZodOptional<z.ZodNumber>
            maxActiveAgents: z.ZodOptional<z.ZodNumber>
            maxTotalAgents: z.ZodOptional<z.ZodNumber>
            maxNoticeWakes: z.ZodOptional<z.ZodNumber>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('../config/local-config').TaskBudgetSettings>
  >
  readonly 'tasks.cancel': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              reason: z.ZodOptional<z.ZodString>
              sessionId: z.ZodOptional<z.ZodString>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<{
      [x: string]: unknown
    }>
  >
  readonly 'tasks.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    import('./core-api').CoreTaskRecord[]
  >
  readonly 'tasks.transcript': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodString>
              offset: z.ZodOptional<z.ZodNumber>
              limit: z.ZodOptional<z.ZodNumber>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    {
      taskId: string
      entries: {
        role: string
        content: string
      }[]
      offset: number
      total: number
      eof: boolean
    }
  >
  readonly 'tasks.readOutput': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              cursor: z.ZodOptional<z.ZodString>
              sessionId: z.ZodOptional<z.ZodString>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<{
      content: string
      nextCursor: null
      eof: boolean
      truncated: boolean
      truncation: null
    }>
  >
  readonly 'tasks.resume': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              mode: z.ZodOptional<
                z.ZodEnum<{
                  background: 'background'
                  foreground: 'foreground'
                }>
              >
              ttlMs: z.ZodOptional<z.ZodNumber>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<never>
  >
  readonly 'tasks.wait': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodString>
              timeoutMs: z.ZodOptional<z.ZodNumber>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    Promise<{
      [x: string]: unknown
    } | null>
  >
  readonly 'processes.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodOptional<
          z.ZodObject<
            {
              sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>
              activeOnly: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strict
          >
        >,
      ],
      null
    >,
    {
      [x: string]: unknown
    }[]
  >
  readonly 'processes.cancel': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodObject<
          {
            sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>
            leaseId: z.ZodString
            reason: z.ZodOptional<z.ZodString>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      [x: string]: unknown
    }
  >
  readonly 'processes.reparent': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodString,
        z.ZodObject<
          {
            sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>
            leaseId: z.ZodString
            ownerKind: z.ZodEnum<{
              session: 'session'
              task: 'task'
              terminal: 'terminal'
            }>
            ownerId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      [x: string]: unknown
    }
  >
  readonly 'terminals.close': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            terminalId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      closed: boolean
    }
  >
  readonly 'terminals.create': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            cols: z.ZodNumber
            rows: z.ZodNumber
          },
          z.core.$strict
        >,
      ],
      null
    >,
    import('..').TerminalSummary
  >
  readonly 'terminals.list': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    import('..').TerminalSummary[]
  >
  readonly 'terminals.read': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            terminalId: z.ZodString
            afterSeq: z.ZodNumber
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      terminal: import('..').TerminalSummary
      chunks: Array<{
        seq: number
        data: string
      }>
      latestSeq: number
    }
  >
  readonly 'terminals.resize': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            terminalId: z.ZodString
            cols: z.ZodNumber
            rows: z.ZodNumber
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      resized: boolean
    }
  >
  readonly 'terminals.write': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            terminalId: z.ZodString
            data: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    {
      written: boolean
    }
  >
  readonly 'tools.networkSettings': CoreOperationSpec<
    z.ZodTuple<[], null>,
    WebToolsStatus
  >
  readonly 'tools.setNetworkSettings': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            webFetch: z.ZodOptional<z.ZodBoolean>
            webSearch: z.ZodOptional<z.ZodBoolean>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<WebToolsStatus>
  >
  readonly 'workspace.snapshot': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').WorkspaceSnapshot>
  >
  readonly 'workspace.turnDiff': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            turn: z.ZodNumber
            path: z.ZodString
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<{
      path: string
      diff: string
      truncated: boolean
    }>
  >
  readonly 'workspace.revertTurn': CoreOperationSpec<
    z.ZodTuple<
      [
        z.ZodObject<
          {
            sessionId: z.ZodString
            turn: z.ZodNumber
            paths: z.ZodOptional<z.ZodArray<z.ZodString>>
          },
          z.core.$strict
        >,
      ],
      null
    >,
    Promise<import('..').TurnFilesReverted>
  >
}

type MCPConnectionState =
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'backoff'
  | 'auth_failed'
  | 'failed'
  | 'stopped'

type MCPConnectionHealth = 'unknown' | 'healthy' | 'unhealthy'

type MCPConnectionAuth = 'unknown' | 'ok' | 'failed'

interface MCPConnectionDiagnosticError {
  readonly code: MCPConnectionErrorCode
  readonly message: string
}

interface MCPConnectionSnapshot {
  readonly serverName: string
  readonly transport: string
  readonly generation: number
  readonly clientId: string | null
  readonly state: MCPConnectionState
  readonly health: MCPConnectionHealth
  readonly auth: MCPConnectionAuth
  readonly toolCount: number
  readonly tools: string[]
  readonly restartAttempts: number
  readonly nextRetryAt: number | null
  readonly activeRequestCount: number
  readonly activeRequestIds: string[]
  readonly lastError: MCPConnectionDiagnosticError | null
}

interface MCPClientSnapshot {
  readonly initialized: boolean
  readonly servers: MCPConnectionSnapshot[]
  readonly ready: number
  readonly configured: number
  readonly tools: number
  readonly toolCapabilities: MCPToolCapabilitySnapshot[]
}

interface MCPToolCapabilitySnapshot {
  readonly name: string
  readonly serverName: string
  readonly toolName: string
  readonly readOnly: boolean
  readonly exclusive: boolean
  readonly evidencePolicy: 'context_only'
  readonly readOnlySource: string
  readonly exclusiveSource: string
  readonly generation: number | null
  readonly clientId: string | null
}

type WebSearchProvider = 'deepseek' | 'host'

interface WebToolsStatus {
  webFetch: { enabled: boolean; available: boolean }
  webSearch: {
    enabled: boolean
    /** The current model's provider offers search (or the host does). */
    available: boolean
    provider: WebSearchProvider | null
    /** The current model's display name, to explain an unavailable search. */
    model: string | null
  }
}

export type HistoricalMcpSnapshot = MCPClientSnapshot

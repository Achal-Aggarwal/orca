// Branch handoff and worktree iteration checks share selection, deadlines, and progress.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  collectChangedFiles,
  computePassHash,
  readPassHash,
  writePassHash
} from './check-changed-pass-cache.mjs'
import { planChangedChecks } from './check-changed-selection.mjs'
import { outputTail as tail, runPool, runTask } from './check-changed-task-runner.mjs'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

// Windows caps a command line near 32K characters; past this, lint the whole tree instead.
const MAX_PATH_ARGUMENT_CHARS = 24_000
const LINTABLE = /\.[cm]?[jt]sx?$/
const ANTI_SLOP_ROOTS = ['src/', 'config/', 'tests/', 'mobile/']

function parseArgs(argv) {
  const options = {
    force: false,
    base: null,
    maxWorkers: null,
    scope: 'branch',
    stepTimeoutMs: 300_000
  }
  for (const argument of argv) {
    if (argument === '--') {
      continue
    } else if (argument === '--force') {
      options.force = true
    } else if (argument.startsWith('--base=')) {
      options.base = argument.slice('--base='.length)
    } else if (argument.startsWith('--scope=')) {
      options.scope = argument.slice('--scope='.length)
    } else if (argument.startsWith('--stepTimeoutMs=')) {
      options.stepTimeoutMs = Number(argument.slice('--stepTimeoutMs='.length))
    } else if (/^--max-?workers=\d+$/i.test(argument)) {
      options.maxWorkers = argument.split('=')[1]
    } else {
      throw new Error(
        `Unknown option ${argument}. Use --force, --base=<ref>, --scope=branch|worktree, --stepTimeoutMs=<ms>, --maxWorkers=<n>.`
      )
    }
  }
  if (!['branch', 'worktree'].includes(options.scope)) {
    throw new Error('--scope must be branch or worktree.')
  }
  if (options.scope === 'worktree' && options.base) {
    throw new Error('--base applies only to --scope=branch.')
  }
  if (
    !Number.isSafeInteger(options.stepTimeoutMs) ||
    options.stepTimeoutMs <= 0 ||
    options.stepTimeoutMs > 2_147_483_647
  ) {
    throw new Error('--stepTimeoutMs must be a positive integer no larger than 2147483647.')
  }
  if (options.maxWorkers !== null && Number(options.maxWorkers) < 1) {
    throw new Error('--maxWorkers must be positive.')
  }
  return options
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function resolveMergeBase(root, requested) {
  for (const candidate of [requested, process.env.ORCA_CODE_QUALITY_BASE, 'origin/main', 'main']) {
    if (!candidate) {
      continue
    }
    const verified = spawnSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      {
        cwd: root,
        stdio: 'ignore'
      }
    )
    if (verified.status === 0) {
      return { ref: candidate, mergeBase: git(root, ['merge-base', candidate, 'HEAD']) }
    }
  }
  throw new Error('No base: fetch origin/main or pass --base=<ref>.')
}

function seconds(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`
}

function fitsCommandLine(files) {
  return files.reduce((total, file) => total + file.length + 1, 0) <= MAX_PATH_ARGUMENT_CHARS
}

function buildTasks(root, plan, { files, mergeBase, maxWorkers, bun }) {
  const node = process.execPath
  const oxlint = resolveOxcCliInvocation('oxlint', 'oxlint', root)
  const oxfmt = resolveOxcCliInvocation('oxfmt', 'oxfmt', root)
  const existing = files.filter((file) => existsSync(path.join(root, file)))
  const step = (program, args) => ({ program, args })
  const tasks = []

  if (plan.typecheckProjects.length > 0) {
    tasks.push({
      name: `typecheck (${plan.typecheckProjects.map((config) => path.basename(config, '.json')).join(', ')})`,
      steps: [
        step(node, [
          'config/scripts/run-typecheck-projects-in-parallel.mjs',
          ...plan.typecheckProjects.map((config) => `--project=${config}`),
          // A worker cap means a shared host; 4 checkers cut typecheck CPU by about a third.
          ...(maxWorkers ? [`--checkers=${Math.max(2, Number(maxWorkers) * 2)}`] : [])
        ])
      ]
    })
  }
  const related = plan.unitTests.related.filter((file) => existsSync(path.join(root, file)))
  const colocated = plan.unitTests.colocated.filter((file) => existsSync(path.join(root, file)))
  if (related.length > 0 || colocated.length > 0) {
    const vitest = (selection) => ({
      ...step(node, [
        'config/scripts/run-vitest.mjs',
        ...selection,
        '--config',
        'config/vitest.config.ts',
        '--passWithNoTests',
        '--reporter=default',
        ...(maxWorkers ? [`--maxWorkers=${maxWorkers}`] : [])
      ]),
      liveOutput: true
    })
    tasks.push({
      name: 'unit tests',
      steps: [
        step(node, ['config/scripts/ensure-native-runtime.mjs', '--runtime=node']),
        ...(related.length > 0
          ? [
              vitest(
                fitsCommandLine(related)
                  ? ['related', '--run', ...related]
                  : ['run', `--changed=${mergeBase}`]
              )
            ]
          : []),
        ...(colocated.length > 0 ? [vitest(['run', ...colocated])] : [])
      ]
    })
  }
  if (plan.staticAnalysis) {
    tasks.push({
      name: 'changed-code quality',
      steps: [step(node, ['config/scripts/check-changed-code-quality.mjs', mergeBase])]
    })
    if (existing.length > 0) {
      tasks.push({
        name: 'format',
        steps: [
          step(oxfmt.command, [
            ...oxfmt.prefixArgs,
            '--check',
            '--no-error-on-unmatched-pattern',
            ...(fitsCommandLine(existing) ? existing : ['.'])
          ])
        ]
      })
    }
    const lintable = existing.filter((file) => LINTABLE.test(file))
    if (lintable.length > 0) {
      const wholeTree = !fitsCommandLine(lintable)
      const antiSlop = lintable.filter((file) =>
        ANTI_SLOP_ROOTS.some((root) => file.startsWith(root))
      )
      tasks.push({
        name: 'oxlint',
        steps: [
          step(oxlint.command, [...oxlint.prefixArgs, '--quiet', ...(wholeTree ? [] : lintable)]),
          ...(antiSlop.length > 0
            ? [
                step(node, ['config/scripts/sync-anti-slop-plugin.mjs']),
                step(bun(), [
                  '--smol',
                  ...oxlint.prefixArgs,
                  '--config',
                  'config/oxlint-anti-slop.json',
                  '--deny-warnings',
                  ...(wholeTree ? ANTI_SLOP_ROOTS : antiSlop)
                ])
              ]
            : [])
        ]
      })
    }
  }
  for (const check of plan.checks) {
    tasks.push({
      name: check.name,
      steps: [
        check.oxlint
          ? step(oxlint.command, [...oxlint.prefixArgs, ...check.oxlint])
          : step(check.runtime === 'bun' ? bun() : node, check.args)
      ]
    })
  }
  return tasks
}

export async function main(root, argv) {
  const startedAt = performance.now()
  const options = parseArgs(argv)
  const { ref, mergeBase } =
    options.scope === 'worktree'
      ? { ref: 'HEAD (staged, unstaged, untracked)', mergeBase: git(root, ['rev-parse', 'HEAD']) }
      : resolveMergeBase(root, options.base)
  const files = collectChangedFiles(root, mergeBase)
  if (files.length === 0) {
    console.log(`check:changed: no changes against ${ref}.`)
    return 0
  }
  const hash = computePassHash(root, mergeBase, options.scope)
  if (!options.force && readPassHash(root, options.scope) === hash) {
    console.log(`check:changed (${options.scope}): nothing changed since last passing run.`)
    return 0
  }

  const plan = planChangedChecks(files, {
    scriptsDir: path.join(root, 'config', 'scripts'),
    listDirectory: (directory) => {
      try {
        return readdirSync(path.join(root, directory))
      } catch {
        return []
      }
    }
  })
  const env = {
    ...process.env,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_UNIT_INVENTORY: options.scope === 'worktree' ? 'ci' : 'local',
    // Why: spawned gates that read the base themselves (flaky-test ratchet) must use --base too.
    ORCA_CODE_QUALITY_BASE: mergeBase,
    ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {})
  }
  console.log(
    `check:changed (${options.scope}): ${files.length} changed file(s) since ${ref} (${mergeBase.slice(0, 10)}); unit inventory: ${options.scope === 'worktree' ? 'CI' : 'local'}.`
  )
  // Load the source runner so even its own initial build has tree cancellation and a deadline.
  const requireFromHost = createRequire(
    new URL('../../src/packages/process-host/package.json', import.meta.url)
  )
  const { tsImport } = await import(pathToFileURL(requireFromHost.resolve('tsx/esm/api')).href)
  const { runProcess, runProcessSync } = await tsImport(
    '../../src/packages/process-host/src/run-process.ts',
    import.meta.url
  )
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  const run = async (task) => {
    const result = await runTask(task, {
      root,
      env,
      runProcess,
      stepTimeoutMs: options.stepTimeoutMs,
      signal: abort.signal
    })
    if (!result.ok) {
      console.error(`\n✗ ${task.name} (${result.elapsed})\n${tail(result.output)}`)
    }
    return result
  }
  try {
    if (
      plan.typecheckProjects.length > 0 ||
      plan.unitTests.related.length + plan.unitTests.colocated.length > 0
    ) {
      const build = await run({
        name: 'build workspace packages',
        steps: [
          {
            program: process.execPath,
            args: ['config/scripts/build-workspace-packages.mjs'],
            liveOutput: true
          }
        ]
      })
      if (!build.ok) {
        return 1
      }
    }
    const { resolvePinnedBunExecutable } = await import('./pinned-bun-executable.mjs')
    const bun = () => resolvePinnedBunExecutable(root, runProcessSync) ?? 'bun'
    const tasks = buildTasks(root, plan, { files, mergeBase, maxWorkers: options.maxWorkers, bun })
    console.log(`check:changed: running ${tasks.length} check(s).`)
    // Typecheck and tests lead the queue so short checks fill in around them.
    const concurrency = options.maxWorkers
      ? Number(options.maxWorkers)
      : Math.max(3, Math.floor(availableParallelism() / 3))
    const results = await runPool(tasks, concurrency, run)
    const failed = results.filter((result) => !result.ok)
    if (failed.length > 0 || abort.signal.aborted) {
      console.error(
        `\n✗ ${failed.length} of ${results.length} check(s) failed in ${seconds(startedAt)}: ${failed.map((result) => result.task.name).join(', ')}`
      )
      return 1
    }
    writePassHash(root, hash, options.scope)
    console.log(`✓ ${results.length} check(s) passed in ${seconds(startedAt)}.`)
    return 0
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    process.exitCode = await main(root, process.argv.slice(2))
  } catch (error) {
    console.error(`check:changed: ${error.message ?? error}`)
    process.exitCode = 1
  }
}

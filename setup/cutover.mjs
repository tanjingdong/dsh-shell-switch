import fs from 'node:fs/promises'
import path from 'node:path'

async function lstatSafe(target) {
  try {
    return await fs.lstat(target)
  } catch {
    return null
  }
}

function normalize(value) {
  return String(value ?? '').replace(/\//g, '\\').toLowerCase()
}

/** Where a junction/symlink really points, or null when it is not one. */
async function linkTarget(target) {
  try {
    const raw = await fs.readlink(target)
    return path.resolve(path.dirname(target), raw)
  } catch {
    return null
  }
}

function defaultStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Prove the cutover landed: `web` must be a link that resolves to `desktop`.
 * A link to anywhere else is a broken cutover, not a finished one.
 */
export async function verifyCutover({ profilesDir }) {
  const web = path.join(profilesDir, 'web')
  const desktop = path.join(profilesDir, 'desktop')
  const target = await linkTarget(web)
  if (!target) throw new Error(`web 不是联接：${web}`)
  if (normalize(target) !== normalize(path.resolve(desktop))) {
    throw new Error(`web 联接到了 ${target}，应指向 ${desktop}`)
  }
  return true
}

/** Decide what the cutover must do without changing anything. */
export async function planCutover({ profilesDir, now = defaultStamp() }) {
  const web = path.join(profilesDir, 'web')
  const desktop = path.join(profilesDir, 'desktop')
  if (!(await lstatSafe(desktop))) throw new Error(`desktop profile 不存在：${desktop}`)
  const stat = await lstatSafe(web)
  if (stat && stat.isSymbolicLink()) {
    const target = await linkTarget(web)
    if (target && normalize(target) === normalize(path.resolve(desktop))) {
      return { steps: [], backupPath: null }
    }
    return {
      steps: ['rename-backup', 'create-junction'],
      backupPath: path.join(profilesDir, `web.bak-${now}`),
    }
  }
  if (stat) {
    return {
      steps: ['rename-backup', 'create-junction'],
      backupPath: path.join(profilesDir, `web.bak-${now}`),
    }
  }
  return { steps: ['create-junction'], backupPath: null }
}

/**
 * Make `profiles/web` a junction to `profiles/desktop`. Idempotent, refuses
 * while a shell holds the profiles, and verifies the result before returning.
 */
export async function applyCutover({
  profilesDir, now, detect = async () => null,
}) {
  const plan = await planCutover({ profilesDir, now })
  if (plan.steps.length === 0) return plan
  const current = await detect()
  if (current !== null) {
    throw new Error('请先关闭桌面客户端与 Web 外壳，再建立联接')
  }
  const web = path.join(profilesDir, 'web')
  if (plan.steps.includes('rename-backup')) await fs.rename(web, plan.backupPath)
  await fs.symlink(path.join(profilesDir, 'desktop'), web, 'junction')
  await verifyCutover({ profilesDir })
  return plan
}

/** Undo the cutover using the backup recorded by a previous run. */
export async function revertCutover({ profilesDir, backupPath }) {
  const web = path.join(profilesDir, 'web')
  await fs.rm(web, { force: true })
  if (backupPath) await fs.rename(backupPath, web)
}

/** `--revert <backup>` is the manual rollback entry point. */
export function parseCutoverArgs(argv = []) {
  let revert = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--revert') {
      revert = argv[index + 1] ?? null
      index += 1
      if (!revert) throw new Error('--revert 需要一个备份目录')
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return { revert }
}

if (process.argv[1]?.endsWith('cutover.mjs')) {
  const { resolvePaths } = await import('../src/paths.mjs')
  const { detectCurrent } = await import('../src/launcher.mjs')
  const { profilesDir } = resolvePaths()
  try {
    const { revert } = parseCutoverArgs(process.argv.slice(2))
    if (revert) {
      await revertCutover({ profilesDir, backupPath: revert })
      process.stdout.write(`已回滚到 ${revert}\n`)
    } else {
      const plan = await applyCutover({
        profilesDir,
        detect: () => detectCurrent({ paths: resolvePaths() }),
      })
      process.stdout.write(plan.steps.length === 0
        ? 'web 已经是联接，无需改动\n'
        : `已建立联接并验证；原目录备份为 ${plan.backupPath ?? '(无)'}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

import fs from 'node:fs/promises'
import path from 'node:path'

async function lstatSafe(target) {
  try {
    return await fs.lstat(target)
  } catch {
    return null
  }
}

function defaultStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Decide what the cutover must do without changing anything. */
export async function planCutover({ profilesDir, now = defaultStamp() }) {
  const web = path.join(profilesDir, 'web')
  const desktop = path.join(profilesDir, 'desktop')
  if (!(await lstatSafe(desktop))) throw new Error(`desktop profile 不存在：${desktop}`)
  const stat = await lstatSafe(web)
  if (stat && stat.isSymbolicLink()) return { steps: [], backupPath: null }
  if (stat) {
    return {
      steps: ['rename-backup', 'create-junction'],
      backupPath: path.join(profilesDir, `web.bak-${now}`),
    }
  }
  return { steps: ['create-junction'], backupPath: null }
}

/** Make `profiles/web` a junction to `profiles/desktop`. Idempotent. */
export async function applyCutover({ profilesDir, now }) {
  const plan = await planCutover({ profilesDir, now })
  if (plan.steps.length === 0) return plan
  const web = path.join(profilesDir, 'web')
  if (plan.steps.includes('rename-backup')) await fs.rename(web, plan.backupPath)
  await fs.symlink(path.join(profilesDir, 'desktop'), web, 'junction')
  return plan
}

/** Undo the cutover using the backup recorded by a previous run. */
export async function revertCutover({ profilesDir, backupPath }) {
  const web = path.join(profilesDir, 'web')
  await fs.rm(web, { force: true })
  if (backupPath) await fs.rename(backupPath, web)
}

import fs from 'node:fs/promises'
import path from 'node:path'

/** Read the launcher state; missing or corrupt reads as null. */
export async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Write state atomically so a crash never leaves a half file. */
export async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** Remove the state file if present. */
export async function clearState(file) {
  await fs.rm(file, { force: true })
}

import { verifyCutover } from '../setup/cutover.mjs'

/**
 * Whether the two shells share one profile. The junction is a global change we
 * must not make from a running host, so the settings page reports it instead.
 */
export async function profileHealth({ profilesDir, command, verify } = {}) {
  const check = verify ?? (() => verifyCutover({ profilesDir }))
  try {
    await check()
    return { linked: true, warning: null, command }
  } catch (error) {
    const reason = error?.message ?? error
    return {
      linked: false,
      warning: `web profile 还没有和 desktop 链接（${reason}）。两个外壳现在不会共享插件与设置；`
        + '先关掉两个外壳，再运行下面的命令。',
      command,
    }
  }
}

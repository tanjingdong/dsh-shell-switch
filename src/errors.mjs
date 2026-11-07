/** Launcher error carrying a stable machine-readable code. */
export class LauncherError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
  }
}

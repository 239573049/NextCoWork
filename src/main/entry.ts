import { app } from 'electron'

if (process.env.NCW_SSH_ASKPASS === '1') {
  app.disableHardwareAcceleration()
  void import('./environment/ssh/askpass').then(async ({ requestAskpass }) => {
    const answer = await requestAskpass(process.env, process.argv.at(-1) ?? '')
    process.stdout.write(`${answer}\n`, () => app.exit(0))
  }).catch(() => app.exit(1))
} else {
  void import('./index')
}
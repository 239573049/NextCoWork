#!/usr/bin/env node
/**
 * `create-nextcowork-plugin` —— 脚手架。
 *
 * ## 它要解决的是「30 分钟跑通 hello world」这一条
 *
 * 那条验收标准里最容易卡住的不是写代码,是**清单**:`engines` 怎么写、
 * `main` 指哪、`title` 为什么必须是 `%key%`、`l10n` 为什么两种语言都要。
 * 每一条写错的症状都是「装上了但没反应」,而错误信息离原因很远。
 *
 * 所以这个脚手架生成的是一份**已经能上架的**骨架:填三个字段,
 * `npm run package` 出来的 ZIP 直接过服务端校验。
 *
 * ## 为什么不问一堆问题
 *
 * 只问三样:publisher、name、显示名。其余全给默认值 —— 一个还没跑通
 * hello world 的人,回答不了「你需要哪些能力」。能力等他真的要用时再加,
 * 那时候他知道自己在要什么。
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(here, 'template')

/** 与客户端 `PLUGIN_NAME_RE` 同一形状。这里先挡一次,免得到上传才被拒。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 默认的 engines range。
 *
 * ★ `^0.x` 按 npm 的规矩锁到 **minor** —— 插件 API 在 1.0 之前明确可以 break,
 * 写 `>=0.2.0` 的插件会在下一个 minor 里静默坏掉,而作者不会收到任何通知。
 */
const DEFAULT_ENGINES = '^0.2.0'

async function main() {
  const args = process.argv.slice(2)
  const flag = (key) => {
    const index = args.indexOf(`--${key}`)
    return index === -1 ? undefined : args[index + 1]
  }
  const target = resolve(args.find((value) => !value.startsWith('--') && !isFlagValue(args, value)) ?? '.')

  /*
    ★ **非交互时不提问。** readline 的 `question()` 在 stdin 已经结束之后
    永远不会 resolve —— 而那时进程会因为「事件循环空了」以退出码 0 悄悄退出,
    什么都没生成,也没有任何错误。这是 CI 里最难查的一类失败。
    所以:有 TTY 才问,没有就用 flag / 默认值。
  */
  const interactive = process.stdin.isTTY === true && flag('yes') === undefined && !args.includes('--yes')
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null

  const publisher = flag('publisher') ?? (await ask(rl, 'publisher(你的发布者名,小写字母数字与连字符)', 'acme'))
  const name = flag('name') ?? (await ask(rl, 'name(插件名)', 'hello'))
  const displayName = flag('display-name') ?? (await ask(rl, '显示名', 'Hello'))
  const description = flag('description') ?? (await ask(rl, '一句话描述', 'A NextCoWork plugin'))
  rl?.close()

  if (!NAME_RE.test(publisher) || !NAME_RE.test(name)) {
    console.error('✗ publisher 与 name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
    process.exit(1)
  }

  const dir = join(target, `${publisher}.${name}`)
  await mkdir(dir, { recursive: true })
  await cp(TEMPLATE, dir, { recursive: true })

  /*
    ★ 占位符替换要**连 l10n key 一起改**:`showMessage` 传的 key 在宿主那边
    会被拼成 `plugin.<publisher>.<name>.<key>`,而模板里的调用写的是完整形式。
    只改 package.json 的话,生成出来的插件一按就显示一串 key,
    而作者完全看不出哪里错了。
  */
  const replacements = {
    __PUBLISHER__: publisher,
    __NAME__: name,
    __DISPLAY_NAME__: displayName,
    __DESCRIPTION__: description,
    __ENGINES__: DEFAULT_ENGINES
  }
  for (const file of await walk(dir)) {
    const raw = await readFile(file, 'utf8')
    let next = raw
    for (const [token, value] of Object.entries(replacements)) next = next.replaceAll(token, value)
    if (next !== raw) await writeFile(file, next)
  }

  console.log(`
✓ ${publisher}.${name} 已生成

  cd ${publisher}.${name}
  npm install
  npm run build
  npm run package

然后在 NextCoWork 的「扩展 › 插件 › 安装插件」里选那个目录(或 ZIP)。
改代码时用 npm run dev,它会监听 src/。
`)
}

async function ask(rl, question, fallback) {
  if (rl === null) return fallback
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
  return answer === '' ? fallback : answer
}

/** `--name hello` 里的 `hello` 不是目标目录。 */
function isFlagValue(args, value) {
  const index = args.indexOf(value)
  return index > 0 && args[index - 1].startsWith('--')
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (/\.(json|ts|md)$/.test(entry.name)) out.push(path)
  }
  return out
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})

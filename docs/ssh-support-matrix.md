# SSH 支持矩阵

记录每项 SSH 能力**当前被验证到什么程度**。四档区分严格，不要混用：

- **真实环境已验证** —— 有用例驱动真实 OpenSSH / 隔离 sshd 跑通
- **mock 已通过** —— 只有单元测试覆盖，未经真实 ssh
- **未验证** —— 代码已实现，但没有任何测试触及
- **阻塞** —— 缺少验证环境，不接受用 mock 冒充

真实连接用例在 `src/main/environment/__tests__/ssh-native.test.ts`，默认 **skip**，需显式开启：

```bash
NCW_SSH_INTEGRATION=1 npx vitest run src/main/environment
```

> ⚠️ 不开这个开关时，全量套件里**不含任何一次真实 SSH 验证**。「全绿」不等于连得上。
> 前置条件：`/usr/sbin/sshd`、`/usr/bin/ssh-keygen`、`/usr/libexec/sftp-server`（或 `/usr/lib/openssh/sftp-server`），非 Windows。

## POSIX 客户端（macOS 实测，OpenSSH 10.3p1 / LibreSSL 3.3.6）

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| 原生 ssh_config（`-F` 透传，不自行解析） | 真实环境已验证 | 隔离 sshd，`Host` 别名 + `IdentityFile` |
| `Include` 指令 | 真实环境已验证 | 身份与端口只出现在被 Include 的文件里 |
| `Match host` 块 | 真实环境已验证 | `User` 只在 Match 块里给出，实测生效 |
| ProxyJump | 真实环境已验证 | 经 `ssh -W` 跳板再连目标 |
| 加密私钥 + askpass passphrase | 真实环境已验证 | 隔离 sshd，passphrase 经 askpass 桥回 UI |
| host key 首次确认 | 真实环境已验证 | 判成 `host-key`，接受后写入**指定的** known_hosts |
| host key 变更拒绝 | 真实环境已验证 | 连接失败，且不给用户"确认"按钮 |
| SFTP 子系统（读写/rename/回收站） | 真实环境已验证 | 原生 `sftp-server`，不解析 shell 输出 |
| 终端输入透传 | 真实环境已验证 | 真实 node-pty + `ssh -tt`，远端 shell 真的执行 |
| 终端 resize（SIGWINCH 传到远端） | 真实环境已验证 | resize 后远端 `stty size` 读出新尺寸 |
| 终端 Ctrl+C（SIGINT 信号语义） | 真实环境已验证 | 远端前台进程被杀，shell 拿回控制权 |
| 终端逐页授权（批准前不 spawn） | 真实环境已验证 | `TerminalHost` 接真实环境，断言的是**进程表**而不是 spy |
| 活页切回免授权 / 关闭重开需重新授权 | 真实环境已验证 | 同上，真实 PTY 会话上走完整状态机 |
| 休眠：拆掉活会话后保留输出、不自动重连、重建需重新授权 | 真实环境已验证 | 复刻 `shutdownEnvironments()` 对终端 driver 的那一下 kill |
| 网络分区（真正丢包/对端消失）下的断线检测 | 未验证 | 见下"为什么本机造不出网络分区" |
| 关闭本机后回收远端进程（终端 `-tt`） | 真实环境已验证 | 远端有 pty，sshd 发 SIGHUP，进程随之退出 |
| 关闭本机后回收远端进程（MCP stdio `-T`） | **已知缺陷** | 见下"非 PTY 路径会留下孤儿" |
| 打包形态 askpass 入口 | 真实环境已验证 | 真跑 Electron 入口，且不创建应用数据目录 |
| 远端 MCP over TLS 的身份校验 | 真实环境已验证 | 真实握手，校验名取转发目标而非本机跳板 |
| 远端 MCP over 真实 `ssh -W` 转发 | 真实环境已验证 | 隔离 sshd 转发一次 HTTP，Host 头不被改写 |
| 断线后不重放 | 真实环境已验证 | 断线后请求立即失败，且不为重试新起转发 |
| 关闭后回收转发进程（含迟到 socket） | 真实环境已验证 | 数的是转发到本次端口的 `ssh -W` 进程，close 后归零 |
| ProxyCommand | 未验证 | 依赖的环境变量无法穷举，见下"已知取舍" |
| 密码认证 | 阻塞 | sshd 口令认证走 PAM/真实账户口令，本机无法在测试里提供 |
| 交互式 MFA（keyboard-interactive 多步） | 阻塞 | 同上，需要可控的 PAM 栈 |
| GSSAPI / Kerberos | 未验证 | 白名单已放行 `KRB5CCNAME` 等，但无 KDC 可测 |
| FIDO/`sk-*` 硬件密钥、PKCS#11 智能卡 | 未验证 | 白名单已放行 `SSH_SK_*`／`SSH_PKCS11_HELPER`，无硬件可测 |

## Windows 服务器 / 客户端

**全部阻塞。** 没有真实 Win32-OpenSSH 环境，一律不以 mock 计为通过。

| 项 | 风险 |
| --- | --- |
| 打包形态 askpass 是否生效 | Win32-OpenSSH 历史上走 ReadConsole 而非 `SSH_ASKPASS`。若不支持，`capture()` 会立刻 `stdin.end()`，最终表现为 **`Permission denied`** —— 一个看起来像"密码错了"、实际是"askpass 压根没被调用"的故障 |
| 默认登录名 | Windows 上 `ssh.exe` 靠 `USERNAME`（`USER` 在那边不存在）。白名单已补，但未实证 |
| 命名管道 endpoint 的 ACL | askpass 桥在 win32 用 `\\.\pipe\...`，未验证访问控制 |
| `powershellCommand` 的 `-EncodedCommand` 链路 | 远端命令组装仅有单元测试 |
| 路径围栏：ADS 与尾部点/空格 | `notes.txt:stream`、`foo.` / `foo ` 会被 Win32 归一，`requireAbsent` 查的是未归一的词法路径，存在静默覆盖同名文件的可能 |

## 为什么本机造不出网络分区

想验证"对端突然消失时客户端多久察觉"，直觉做法是把 sshd 杀掉。**这条路走不通**：sshd 为每条连接 fork 一个子进程，该子进程会改写自己的进程标题（`sshd: user@…`）并脱离进程组，所以

- 只 `kill` 监听进程，已建立的连接毫发无伤；
- 连进程组一起 `kill`，也碰不到那个已经 `setsid()` 出去的子进程；
- 而按 `/usr/sbin/sshd` 去数进程会**看不见**它（标题已被改写），于是计数器显示"sshd 已归零"，制造出一种连接已断的假象。

实测：杀掉监听进程组之后，客户端 `ssh -tt` 50 秒仍无任何察觉，pty 不退出。这**不能**当作断线检测的缺陷证据——因为连接压根没断。

要如实验证网络分区，需要能丢包的网络夹具（把转发端口挂到一个可切断的中间层上，或用 `pfctl`/netem 规则），属于尚未覆盖项。当前已覆盖的是**主动拆除**语义：`shutdownEnvironments()` 杀掉终端 driver 之后，输出保留、不自动重连、重建需重新授权。

`baseArgs()` 里的 `ServerAliveInterval=15` + `ServerAliveCountMax=2` 决定了理论检测上限约 30 秒，但这个数字目前是**读配置得来的，不是测出来的**。

## 已知缺陷：非 PTY 路径会留下孤儿

隔离 sshd 实测（2026-09-11）：

| 路径 | 关掉本机这一侧之后 |
| --- | --- |
| `-tt`（终端） | 远端进程**随之退出**。远端有 pty，连接断开时 sshd 向会话发 SIGHUP |
| `-T`（远端 MCP stdio） | 远端进程**继续运行**。本机 ssh 已消失，远端 `sleep` 30 秒后仍在，是真孤儿 |

影响：每次远端工作区断开/重连，一个不读 stdin 的远端 MCP 服务器就在服务器上多留一份，永不回收。

已做的缓解：`EnvironmentStdioTransport.close()` 先 `stdin.end()` 再等一个短暂的宽限期才杀本机侧。stdin EOF 是 MCP stdio 服务器的约定收尾信号，守规矩的服务器据此自行退出，于是最常见的一类从"必然泄漏"变成"正常退出"。

**仍未解决**：完全不读 stdin 的远端进程挡不住。彻底解法需要远端侧看门狗，而直接用 `sh -c 'cmd & …'` 包一层是**错的** —— 非交互 shell 会把后台作业的 stdin 重定向到 `/dev/null`，MCP 的 stdio 通道当场就断。改用 `-tt` 也不行：pty 会做 CR/LF 转换，弄坏二进制 stdio。需要一个既不碰 stdin 也能感知父进程消失的包装（例如轮询自身当前 PPID 是否变成 1），属于待设计项。

`ssh-native.test.ts` 里有一条用例把上述两种行为都钉住了，其中非 PTY 那条断言的是**现状**（仍然存活）。它一旦失败，说明语义变了，请同步本文件。

## 已知取舍

**客户端环境变量白名单**（`ssh/transport.ts` 的 `sshProcessEnvironment`）。默认只放行基础设施变量，因为 ssh 会把整个环境交给 ProxyCommand / `Match exec` / `KnownHostsCommand` 跑的 `/bin/sh -c`，而用户 ssh_config 里一条 `SendEnv *` 还能把它送到远端。

- 放行**选择器和路径**：`AWS_PROFILE`、`AWS_CONFIG_FILE`、`CLOUDSDK_*`、`TELEPORT_*`、`KRB5CCNAME`、代理变量等
- **不**放行原始凭据：`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`。缺席时 aws/gcloud 会自己读凭据文件；放行则会让它们同时暴露给 ProxyCommand 和配了 SendEnv 通配的远端
- 依赖其它变量的 ProxyCommand 目前会被打断，且症状是 ProxyCommand 报一条无关错误，很难诊断。彻底解法是每连接的显式透传列表，尚未实现

**askpass token 不走环境变量。** 一次性 token 写在 0700 目录下的 0600 文件里，env 只带路径。原因：`SendEnv *` 会把环境变量送到远端，而实测 `-o 'SendEnv=-*'` **清不掉**配置文件里的 `SendEnv *`（SendEnv 是累加列表，`-` 只从当前已累积的列表里移除，而命令行先于配置文件解析），OpenSSH 也没有 `SendEnv none`。

**askpass 始终包一层 wrapper 并用 `--` 终止开关解析。** OpenSSH 以 `execlp(askpass, askpass, msg)` 调用，`msg` 在 keyboard-interactive 下由远端 sshd 完全控制；而打包形态的 `SSH_ASKPASS` 就是 Electron 本体，Chromium 会抢在 JS 之前把它当开关解析。

**host key 提示按内容识别，不依赖 `SSH_ASKPASS_PROMPT`。** 实测 OpenSSH 10.3 在 host key 确认走 askpass 时并不设该变量。只认 hint 会让提示掉进 `challenge` 分支，进而 UI 降级成普通输入框、yes/no 强校验失效，并导致 ssh 反复重问（隔离 sshd 上实测 80+ 次直到超时）。

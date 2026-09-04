import markUrl from '../../assets/mark.png'

/**
 * NextCoWork 的标识。
 *
 * 图形来自 `nextcowork-symbol-transparent-v5.png`(透明底的符号)。
 * 这里不直接 `<img>` —— 那是一张固定炭灰色的图,贴到深色侧边栏会看不见。
 * 改用它的 alpha 通道做 CSS mask,让符号取 `currentColor`:
 * 形状是新符号,颜色跟随主题(深色→浅前景,浅色→深前景),两个主题都成立。
 *
 * 想换品牌图形?换掉 assets/mark.png 即可,其它地方只 import `<Mark />`。
 */
export function Mark({ size = 26, className }: { size?: number; className?: string }): React.ReactNode {
  return (
    <span
      role="img"
      aria-label="NextCoWork"
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        backgroundColor: 'currentColor',
        WebkitMaskImage: `url(${markUrl})`,
        maskImage: `url(${markUrl})`,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center'
      }}
    />
  )
}

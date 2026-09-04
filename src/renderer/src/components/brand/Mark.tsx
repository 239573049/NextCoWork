/**
 * NextCoWork 的标识。
 *
 * ⚠️ 参考截图里那个「M」是 **NewMax 自己的商标**(关于页 bc870493 证实),不能用。
 * 这里是一个占位:一笔连写的 N,方头圆角,和界面同一种几何语言。
 * 真正的品牌图形应当由你来定 —— 换掉这一个文件即可,其它地方只 import `<Mark />`。
 */
export function Mark({ size = 26, className }: { size?: number; className?: string }): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label="NextCoWork"
    >
      <path
        d="M4.5 19.5V5.2c0-.5.6-.7.9-.3L18.6 19c.3.4.9.2.9-.3V4.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

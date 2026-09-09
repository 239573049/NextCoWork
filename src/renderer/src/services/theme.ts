/**
 * 图片主题服务。组件不碰频道字符串(方案 §8 的服务层约定)。
 *
 * 导入是两相的,理由在契约的 `ImportedImage` 上:主进程没有 canvas,
 * 所以 `importImage` 只把字节递过来,颜色由这一侧算完再 `saveImage` 落表。
 */
import type { ImageTheme, ThemeProfile } from '../../../shared/domain/theme'
import type { ImportedImage, ThemeImageMetadata } from '../../../shared/ipc/contract'
import { invoke } from './ipc'

/** 主进程弹文件选择框;渲染层永不指定路径(方案 §9)。取消时返回 null。 */
export function importImage(): Promise<ImportedImage | null> {
  return invoke('theme:importImage', undefined)
}

/** 第二相:交回算好的 seed/palette。返回登记后的**全表**,直接拿来当新状态。 */
export function saveImage(req: {
  id: string
  name: string
  seed: string
  palette: string[]
  metadata?: ThemeImageMetadata
}): Promise<ImageTheme[]> {
  return invoke('theme:saveImage', req)
}

export function listImages(): Promise<ImageTheme[]> {
  return invoke('theme:listImages', undefined)
}

/** id → 主进程查表 → 读文件。这里给出的 id 只是一个查表的键,不是路径。 */
export function readImage(id: string): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> }> {
  return invoke('theme:readImage', { id })
}

/** 返回删除后的全表 */
export function deleteImage(id: string): Promise<ImageTheme[]> {
  return invoke('theme:deleteImage', { id })
}
export function listProfiles(): Promise<ThemeProfile[]> { return invoke('theme:listProfiles', undefined) }
export function saveProfile(profile: ThemeProfile): Promise<ThemeProfile[]> { return invoke('theme:saveProfile', profile) }
export function deleteProfile(id: string): Promise<ThemeProfile[]> { return invoke('theme:deleteProfile', { id }) }
export function renameProfile(id: string, name: string): Promise<ThemeProfile[]> { return invoke('theme:renameProfile', { id, name }) }

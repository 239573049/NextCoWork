export interface ClientUpdateInfo {
  version: string
  platform: string
  architecture: string
  fileName: string
  sha256: string
  fileSize: number
  downloadUrl: string
  releaseNotes?: string
  isPrerelease: boolean
}

export type UpdateCheckResult =
  | { status: 'available'; currentVersion: string; update: ClientUpdateInfo }
  | { status: 'current'; currentVersion: string }
  | { status: 'unavailable'; currentVersion: string; message: string }

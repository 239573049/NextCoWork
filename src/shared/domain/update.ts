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
  releaseDate?: string
  mandatory?: boolean
  minimumSupportedVersion?: string
  graceUntil?: string
}

export type UpdateErrorCode =
  | 'network'
  | 'invalid-metadata'
  | 'checksum-mismatch'
  | 'download-failed'
  | 'install-failed'
  | 'unsupported-platform'
  | 'not-packaged'

export interface UpdateProgress {
  percent: number
  transferredBytes: number
  totalBytes?: number
  bytesPerSecond?: number
}

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  mandatory: boolean
  minimumSupportedVersion?: string
  graceUntil?: string
}

export type UpdateState =
  | { state: 'disabled' | 'idle' | 'checking' | 'up-to-date'; currentVersion: string }
  | { state: 'available' | 'downloading' | 'downloaded' | 'installing'; currentVersion: string; update: UpdateInfo; progress?: UpdateProgress }
  | { state: 'error'; currentVersion: string; code: UpdateErrorCode }

export type UpdateCheckResult =
  | { status: 'available'; currentVersion: string; update: ClientUpdateInfo }
  | { status: 'current'; currentVersion: string }
  | { status: 'unavailable'; currentVersion: string; message: string }

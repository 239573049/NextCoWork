import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, imageCapabilities, videoCapabilities } from '../helpers'

export const AMAZON: readonly BuiltinModelRecord[] = [
  model('amazon', 'amazon.nova-pro-v1:0', 'Amazon Nova Pro', {
    capabilities: visionCapabilities(),
  }),
  model('amazon', 'amazon.nova-lite-v1:0', 'Amazon Nova Lite', {
    capabilities: visionCapabilities(),
  }),
  model('amazon', 'amazon.nova-micro-v1:0', 'Amazon Nova Micro', {
    capabilities: textCapabilities(),
  }),
  model('amazon', 'amazon.nova-canvas-v1:0', 'Amazon Nova Canvas', {
    modality: 'image',
    capabilities: imageCapabilities(),
  }),
  model('amazon', 'amazon.nova-reel-v1:0', 'Amazon Nova Reel', {
    modality: 'video',
    capabilities: videoCapabilities(),
  }),
]

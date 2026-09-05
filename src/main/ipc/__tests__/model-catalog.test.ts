import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelCatalogDefinition } from '../../../shared/domain/model-catalog'
import { closeDatabase, openDatabase } from '../../db/index'
import { store } from '../../state/store'
import { upsertUserModelCatalog } from '../model-catalog'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-model-catalog-'))
  openDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const definition = (over: Partial<ModelCatalogDefinition> = {}): ModelCatalogDefinition => ({
  id: 'custom-model',
  manufacturerId: 'other',
  manufacturerLabel: 'Other',
  displayName: 'Custom model',
  modality: 'text',
  capabilities: {
    tools: false,
    vision: false,
    thinking: false,
    caching: false,
    textInput: true,
    textOutput: true
  },
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  thinkingConfig: { mode: 'unsupported', defaultEnabled: false },
  ...over
})

describe('model catalogue IPC write boundary', () => {
  it('persists normalized request patches', () => {
    const saved = upsertUserModelCatalog(definition({
      requestAdapter: {
        preset: 'custom',
        patches: [
          { op: 'add', path: '/temperature', value: 0.2 },
          { op: 'remove', path: '/metadata/private', value: 'ignored' }
        ]
      }
    }))

    expect(saved.requestAdapter?.patches).toEqual([
      { op: 'add', path: '/temperature', value: 0.2 },
      { op: 'remove', path: '/metadata/private' }
    ])
    expect(store.listUserModelCatalog()).toEqual([saved])
  })

  it('rejects an unsafe adapter before persistence', () => {
    const unsafe = definition({
      requestAdapter: {
        preset: 'custom',
        patches: [{ op: 'add', path: '/model', value: 'other-model' }]
      }
    })

    expect(() => upsertUserModelCatalog(unsafe)).toThrow(/格式无效/u)
    expect(store.listUserModelCatalog()).toEqual([])
  })
})

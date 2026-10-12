import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FORBIDDEN_IMPORTS, REQUIRED_BUILTINS, inspectBundle } from './build-agent.mjs'

const good = 'import { DatabaseSync } from "node:sqlite";\nimport WebSocket from "ws";\nexport {};'

test('accepts a bundle that keeps node:sqlite and has no electron', () => {
  assert.deepEqual(inspectBundle(good), [])
})

test('rejects every spelling of an electron import', () => {
  for (const code of [
    `${good}\nimport { app } from "electron";`,
    `${good}\nimport{app}from'electron'`,
    `${good}\nconst e = require("electron");`,
    `${good}\nawait import("electron/main");`
  ]) {
    assert.deepEqual(inspectBundle(code), ['bundle imports "electron"'], code)
  }
})

test('does not confuse similarly named packages or plain text with an electron import', () => {
  assert.deepEqual(inspectBundle(`${good}\nimport x from "electron-store-like";\n// electron is mentioned in a comment`), [])
})

test('fails when the sqlite builtin import disappears', () => {
  assert.deepEqual(inspectBundle('import WebSocket from "ws";'), ['bundle lost the "node:sqlite" builtin import'])
})

test('the check lists stay in sync with what the service actually requires', () => {
  assert.deepEqual(FORBIDDEN_IMPORTS, ['electron'])
  assert.deepEqual(REQUIRED_BUILTINS, ['node:sqlite'])
})

import type { BuiltinModelRecord } from '../types'
import { model, visionCapabilities, budgetThinking } from '../helpers'

export const ANTHROPIC: readonly BuiltinModelRecord[] = [
  model('anthropic', 'claude-opus-5', 'Claude Opus 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-mythos-5', 'Claude Mythos 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5', 'Claude Fable 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
  }),
  model('anthropic', 'claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
    aliases: ['claude-3-7-sonnet-20250219'],
  }),
  model('anthropic', 'claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', {
    capabilities: visionCapabilities(),
    aliases: ['claude-3-5-sonnet-20241022'],
  }),
  model('anthropic', 'claude-3-5-haiku-latest', 'Claude 3.5 Haiku', {
    capabilities: visionCapabilities(),
    aliases: ['claude-3-5-haiku-20241022'],
  }),
]

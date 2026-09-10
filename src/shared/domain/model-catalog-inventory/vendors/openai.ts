import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, imageCapabilities, videoCapabilities, effortThinking, efforts, openAiModernEfforts, openAiAstraEfforts } from '../helpers'

export const OPENAI: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-6-astra', 'GPT-6 Astra', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiAstraEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    aliases: ['gpt-5.6'],
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-cyber', 'GPT-5.6 Cyber', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiAstraEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.5', 'GPT-5.5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4', 'GPT-5.4', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2', 'GPT-5.2', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2-pro', 'GPT-5.2 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.3-chat-latest', 'GPT-5.3 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5.2-codex', 'GPT-5.2 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2-chat-latest', 'GPT-5.2 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5.1', 'GPT-5.1', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex', 'GPT-5.1 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex-max', 'GPT-5.1 Codex Max', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-chat-latest', 'GPT-5.1 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5', 'GPT-5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-mini', 'GPT-5 mini', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-nano', 'GPT-5 nano', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-pro', 'GPT-5 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-codex', 'GPT-5 Codex', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-chat-latest', 'GPT-5 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1', 'GPT-4.1', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4o', 'GPT-4o', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4o-mini', 'GPT-4o mini', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'o1', 'o1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-pro', 'o1 Pro', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3', 'o3', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-pro', 'o3 Pro', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-mini', 'o3 mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-deep-research', 'o3 Deep Research', {
    capabilities: visionCapabilities({ tools: false, thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o4-mini', 'o4 mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o4-mini-deep-research', 'o4 Mini Deep Research', {
    capabilities: visionCapabilities({ tools: false, thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-mini', 'o1 Mini', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-preview', 'o1 Preview', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-4-turbo', 'GPT-4 Turbo', {
    capabilities: visionCapabilities(),
  }),
  model('openai', 'gpt-4-turbo-2024-04-09', 'GPT-4 Turbo 2024-04-09', {
    capabilities: visionCapabilities(),
  }),
  model('openai', 'gpt-4', 'GPT-4'),
  model('openai', 'gpt-4-0613', 'GPT-4 0613'),
  model('openai', 'gpt-3.5-turbo', 'GPT-3.5 Turbo'),
  model('openai', 'gpt-oss-120b', 'GPT OSS 120B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
  }),
  model('openai', 'gpt-oss-20b', 'GPT OSS 20B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
  }),
  model('openai', 'codex-mini-latest', 'Codex Mini', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'computer-use-preview', 'Computer Use Preview', {
    capabilities: visionCapabilities({ tools: true }),
  }),
  model('openai', 'gpt-4o-search-preview', 'GPT-4o Search Preview', {
    capabilities: visionCapabilities({ tools: false, webSearch: true }),
  }),
  model('openai', 'gpt-4o-mini-search-preview', 'GPT-4o Mini Search Preview', {
    capabilities: visionCapabilities({ tools: false, webSearch: true }),
  }),
]

export const OPENAI_MEDIA: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-image-2', 'GPT Image 2', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1.5', 'GPT Image 1.5', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1', 'GPT Image 1', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1-mini', 'GPT Image 1 Mini', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'chatgpt-image-latest', 'ChatGPT Image', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'sora-2', 'Sora 2', {
    modality: 'video',
    capabilities: videoCapabilities({
      vision: true,
      visionInput: true,
      audioOutput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'sora-2-pro', 'Sora 2 Pro', {
    modality: 'video',
    capabilities: videoCapabilities({
      vision: true,
      visionInput: true,
      audioOutput: true,
    }),
    verificationStatus: 'official-api',
  }),
]

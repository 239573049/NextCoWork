import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, audioCapabilities, effortThinking, efforts, source } from '../helpers'

export const AUDIO_MODELS: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-audio-1.5', 'GPT Audio 1.5', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-audio', 'GPT Audio', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-audio-mini', 'GPT Audio Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-audio-preview', 'GPT-4o Audio Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-audio-preview', 'GPT-4o Mini Audio Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-2.1', 'GPT Realtime 2.1', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-2.1-mini', 'GPT Realtime 2.1 Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-2', 'GPT Realtime 2', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-1.5', 'GPT Realtime 1.5', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime', 'GPT Realtime', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-mini', 'GPT Realtime Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-translate', 'GPT Realtime Translate', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-realtime-preview', 'GPT-4o Realtime Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-realtime-preview', 'GPT-4o Mini Realtime Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-tts', 'GPT-4o Mini TTS', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'tts-1', 'TTS 1', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'tts-1-hd', 'TTS 1 HD', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'gpt-transcribe', 'GPT Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-live-transcribe', 'GPT Live Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
      streaming: true,
    }),
  }),
  model('openai', 'gpt-realtime-whisper', 'GPT Realtime Whisper', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
      streaming: true,
    }),
  }),
  model('openai', 'gpt-4o-transcribe', 'GPT-4o Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-transcribe', 'GPT-4o Mini Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-transcribe-diarize', 'GPT-4o Transcribe Diarize', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'whisper-1', 'Whisper', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('google', 'gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Flash Native Audio Preview 12-2025', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      videoInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    aliases: ['gemini-2.5-flash-native-audio'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025'),
    verificationStatus: 'official-api',
  }),
]

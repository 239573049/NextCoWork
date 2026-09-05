import type {
  UsageDimensionStat,
  UsageRequestLogsPage,
  UsageRequestLogsQuery,
  UsageSummary,
  UsageWindow
} from '../../../shared/domain/usage'
import { invoke } from './ipc'

export function getUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  return invoke('usage:getSummary', window)
}

export function getUsageRequestLogs(
  query: UsageRequestLogsQuery
): Promise<UsageRequestLogsPage> {
  return invoke('usage:getRequestLogs', query)
}

export function getUsageProviderStats(window: UsageWindow): Promise<UsageDimensionStat[]> {
  return invoke('usage:getProviderStats', window)
}

export function getUsageModelStats(window: UsageWindow): Promise<UsageDimensionStat[]> {
  return invoke('usage:getModelStats', window)
}

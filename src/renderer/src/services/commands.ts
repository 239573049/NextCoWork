import type { CommandDefinition } from "../../../shared/domain/command";
import type { CommandListItem } from "../../../shared/domain/markdown-resource";
import { invoke, on } from "./ipc";

export function listCommands(
  workspaceId?: string,
): Promise<CommandDefinition[]> {
  return invoke(
    "commands:list",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

/** 管理界面用 —— 关掉的那些也在里面，否则用户没法再把它打开。 */
export function listAllCommands(workspaceId?: string): Promise<CommandListItem[]> {
  return invoke(
    "commands:listAll",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

export function setCommandEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke("commands:setEnabled", { name, enabled });
}

export function onCommandsChanged(callback: () => void): () => void {
  return on("commands:changed", callback);
}

export function commandDiagnostics(
  workspaceId?: string,
): Promise<Array<{ path: string; message: string }>> {
  return invoke(
    "commands:diagnostics",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

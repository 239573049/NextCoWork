import type { CommandDefinition } from "../../../shared/domain/command";
import { invoke } from "./ipc";

export function listCommands(
  workspaceId?: string,
): Promise<CommandDefinition[]> {
  return invoke(
    "commands:list",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

export function commandDiagnostics(
  workspaceId?: string,
): Promise<Array<{ path: string; message: string }>> {
  return invoke(
    "commands:diagnostics",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

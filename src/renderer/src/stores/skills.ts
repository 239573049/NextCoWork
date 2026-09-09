import { create } from "zustand";
import type { SkillListItem } from "../../../shared/domain/skill";
import {
  listSkills,
  listSkillDiagnostics,
  setSkillGlobalEnabled,
  setSkillWorkspaceActive,
} from "../services/skills";

interface SkillsState {
  items: SkillListItem[];
  diagnostics: Array<{ path: string; message: string }>;
  loading: boolean;
  error: "skills.loadFailed" | "skills.diagnosticsFailed" | null;
  workspaceId: string | null;
  load: (workspaceId: string | null) => Promise<void>;
  toggleGlobal: (skillId: string) => Promise<void>;
  toggleWorkspace: (skillId: string) => Promise<void>;
}

let latestRequest = 0;

export const useSkillsStore = create<SkillsState>((set, get) => ({
  items: [],
  diagnostics: [],
  loading: false,
  error: null,
  workspaceId: null,
  async load(workspaceId) {
    const request = ++latestRequest;
    const changedWorkspace = get().workspaceId !== workspaceId;
    set({
      workspaceId,
      loading: true,
      error: null,
      ...(changedWorkspace ? { items: [], diagnostics: [] } : {}),
    });
    const [items, diagnostics] = await Promise.allSettled([
      listSkills(workspaceId ?? undefined),
      listSkillDiagnostics(workspaceId ?? undefined),
    ]);
    if (request !== latestRequest) return;
    set({
      loading: false,
      ...(items.status === "fulfilled" ? { items: items.value } : {}),
      ...(diagnostics.status === "fulfilled"
        ? { diagnostics: diagnostics.value }
        : {}),
      error:
        items.status === "rejected"
          ? "skills.loadFailed"
          : diagnostics.status === "rejected"
            ? "skills.diagnosticsFailed"
            : null,
    });
  },
  async toggleGlobal(skillId) {
    const item = get().items.find((value) => value.id === skillId);
    if (!item) return;
    await setSkillGlobalEnabled(skillId, !item.globalEnabled);
    await get().load(get().workspaceId);
  },
  async toggleWorkspace(skillId) {
    const { workspaceId, items } = get();
    if (!workspaceId) return;
    const item = items.find((value) => value.id === skillId);
    if (!item) return;
    await setSkillWorkspaceActive(
      skillId,
      workspaceId,
      !item.activeInWorkspace,
    );
    await get().load(workspaceId);
  },
}));
